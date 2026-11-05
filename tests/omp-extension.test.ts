import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { AgentServerFrame, Participant, PostMessageResponse, ViewerServerFrame } from "@agent-bus/protocol";
import { createBusServer, type BusServerHandle } from "@agent-bus/server";
import messageBus, {
  type MessageBusApi,
  type MessageBusContext,
  type MessageBusToolParams,
} from "../packages/omp-extension/src/index";

type Injected =
  | { via: "user"; content: string; deliverAs?: string }
  | { via: "message"; content: string; deliverAs: string };

/** Fake omp session: records injections, exposes the registered tool and session hooks. */
class FakeOmp {
  idle = true;
  readonly injected: Injected[] = [];
  private waiters: Array<{ until: () => boolean; resolve: () => void }> = [];
  private sessionStart?: (event: unknown, ctx: MessageBusContext) => void;
  private sessionShutdown?: () => void;
  private contextHook?: (event: { messages: unknown[] }) => void;
  tool?: Parameters<MessageBusApi["registerTool"]>[0];

  constructor(readonly cwd: string, readonly kind: "main" | "sub" = "main") {
    const chain = { optional: () => chain, describe: () => chain };
    const api: MessageBusApi = {
      zod: { object: () => chain, string: () => chain, number: () => chain, enum: () => chain, array: () => chain },
      on: ((event: string, handler: never) => {
        if (event === "session_start") this.sessionStart = handler;
        else if (event === "context") this.contextHook = handler;
        else this.sessionShutdown = handler;
      }) as MessageBusApi["on"],
      registerTool: (definition) => {
        this.tool = definition;
      },
      sendUserMessage: (content, options) => this.record({ via: "user", content, deliverAs: options.deliverAs }),
      sendMessage: (message, options) => this.record({ via: "message", content: message.content, deliverAs: options.deliverAs }),
    };
    messageBus(api);
  }

  private get ctx(): MessageBusContext {
    return { cwd: this.cwd, agent: { kind: this.kind }, isIdle: () => this.idle };
  }

  start(): void {
    this.sessionStart?.({}, this.ctx);
  }

  shutdown(): void {
    this.sessionShutdown?.();
  }

  run(params: MessageBusToolParams) {
    return this.tool!.execute("call", params, undefined, undefined, this.ctx);
  }

  /** Simulates a model request whose context holds `contents` (as omp user/custom messages). */
  modelRequest(contents: string[]): void {
    this.contextHook?.({ messages: contents.map((content) => ({ role: "user", content: [{ type: "text", text: content }] })) });
  }

  private record(entry: Injected): void {
    this.injected.push(entry);
    for (const w of this.waiters.filter((w) => w.until())) {
      this.waiters.splice(this.waiters.indexOf(w), 1);
      w.resolve();
    }
  }

  /** Resolves with the first injection whose content includes `needle`. */
  async injectedWith(needle: string): Promise<Injected> {
    const find = () => this.injected.find((i) => i.content.includes(needle));
    if (!find()) {
      const { promise, resolve } = Promise.withResolvers<void>();
      this.waiters.push({ until: () => find() !== undefined, resolve });
      await promise;
    }
    return find()!;
  }
}

let dataDir = "";
let bus: BusServerHandle;
let viewer: WebSocket;
let participants: Participant[] = [];
let participantWaiters: Array<{ until: () => boolean; resolve: () => void }> = [];
const sessions: FakeOmp[] = [];
const sockets: WebSocket[] = [];

function participantsWhere(pred: (ps: Participant[]) => boolean): Promise<void> {
  if (pred(participants)) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  participantWaiters.push({ until: () => pred(participants), resolve });
  return promise;
}

async function post(body: object): Promise<PostMessageResponse> {
  const res = await fetch(`${bus.url}/api/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as PostMessageResponse;
}

/** Starts a fake main omp session in `<dataDir>/projects/<folder>` and waits until it is online. */
async function startSession(folder: string): Promise<FakeOmp> {
  const omp = new FakeOmp(path.join(dataDir, "projects", folder));
  sessions.push(omp);
  omp.start();
  await participantsWhere((ps) => ps.some((p) => p.id === folder && p.online));
  return omp;
}

/** Raw agent socket for a second agent that acks every delivery (as harnesses do), returning delivered frames. */
async function rawAgent(folder: string) {
  const frames: AgentServerFrame[] = [];
  let waiter: { until: () => boolean; resolve: () => void } | undefined;
  const url = `${bus.url.replace(/^http/, "ws")}/ws/agent?host=test&harness=raw&path=${encodeURIComponent(path.join(dataDir, "projects", folder))}`;
  const ws = new WebSocket(url);
  sockets.push(ws);
  ws.addEventListener("message", (e) => {
    const frame = JSON.parse(String(e.data)) as AgentServerFrame;
    frames.push(frame);
    if (frame.type === "deliver") {
      ws.send(JSON.stringify({ type: "ack", seq: frame.message.seq }));
      ws.send(JSON.stringify({ type: "seen", seq: frame.message.seq }));
    }
    if (waiter?.until()) waiter.resolve();
  });
  const delivered = (needle: string) => {
    const find = () =>
      frames.find((f): f is Extract<AgentServerFrame, { type: "deliver" }> => f.type === "deliver" && f.message.text.includes(needle));
    if (find()) return Promise.resolve(find()!);
    const { promise, resolve } = Promise.withResolvers<void>();
    waiter = { until: () => find() !== undefined, resolve };
    return promise.then(() => find()!);
  };
  await participantsWhere((ps) => ps.some((p) => p.id === folder && p.online));
  return { ws, delivered };
}

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "mb-ext-test-"));
  bus = createBusServer({ host: "127.0.0.1", port: 0, dataDir, humans: ["can", "umit"] });
  process.env.AGENT_BUS_URL = bus.url;
  process.env.AGENT_BUS_JOIN_FROM_TMP = "1"; // fake projects live under the temp dir
  viewer = new WebSocket(`${bus.url.replace(/^http/, "ws")}/ws/viewer`);
  viewer.addEventListener("message", (e) => {
    const frame = JSON.parse(String(e.data)) as ViewerServerFrame;
    if (frame.type !== "participants") return;
    participants = frame.participants;
    for (const w of participantWaiters.filter((w) => w.until())) {
      participantWaiters.splice(participantWaiters.indexOf(w), 1);
      w.resolve();
    }
  });
  const opened = Promise.withResolvers<void>();
  viewer.addEventListener("open", () => opened.resolve(), { once: true });
  await opened.promise;
});

afterEach(async () => {
  for (const s of sessions.splice(0)) s.shutdown();
  for (const ws of sockets.splice(0)) ws.close();
  viewer.close();
  participants = [];
  participantWaiters = [];
  await bus.stop();
  delete process.env.AGENT_BUS_URL;
  delete process.env.AGENT_BUS_JOIN_FROM_TMP;
  rmSync(dataDir, { recursive: true, force: true });
});

test("delivers like the composer: idle starts a turn, busy queues a follow-up, agents' @all is quiet", async () => {
  const alpha = await startSession("alpha");
  const beta = await rawAgent("beta");

  const { message: standup } = await post({ from: "can", to: "@all", text: "standup in 5" });
  const sent = `${new Date(standup.createdAt).toISOString().slice(0, 16).replace("T", " ")}Z`;
  expect(await alpha.injectedWith("standup in 5")).toEqual({
    via: "user",
    content: `[message-bus] #1 @can → @all · ${sent}\nstandup in 5\n(Reply only if they need something from you: message-bus reply, message_id 1 → @all.)`,
    deliverAs: undefined,
  });

  alpha.idle = false;
  await post({ from: "umit", to: "@alpha", text: "check the logs" });
  const busy = await alpha.injectedWith("check the logs");
  expect(busy.via).toBe("user");
  expect(busy.deliverAs).toBe("aside");
  expect(busy.content).toMatch(/message_id \d+ → @umit\.\)$/);

  alpha.idle = true;
  await post({ from: "beta", to: "@all", text: "beta finished a run" });
  expect(await alpha.injectedWith("beta finished a run")).toMatchObject({ via: "message", deliverAs: "nextTurn" });

  // `set all wake` makes agents' @all start turns too.
  const setRes = await alpha.run({ op: "set", key: "all", value: "wake" });
  expect(setRes.content[0]!.text).toContain('"all":"wake"');
  await post({ from: "beta", to: "@all", text: "beta again" });
  expect(await alpha.injectedWith("beta again")).toMatchObject({ via: "user", deliverAs: undefined });

  beta.ws.close();
});

test("tool write/send reach other agents; received files are saved locally", async () => {
  const alpha = await startSession("alpha");
  const beta = await rawAgent("beta");

  const wrote = await alpha.run({ op: "write", to: "@beta", message: "ping from alpha" });
  expect(wrote.content[0]!.text).toMatch(/^Sent to @beta \(conversation g_\w+, message #\d+\): seen by @beta\. \(you are @alpha\)$/);
  const dm = await beta.delivered("ping from alpha");
  expect(dm.replyTo).toBe("@alpha");
  expect(dm.conversation.addressed).toEqual(["alpha", "beta"]);

  const filePath = path.join(dataDir, "projects", "alpha", "report.txt");
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, "results: 42\n");
  const sent = await alpha.run({ op: "send", to: "@{beta,can}", files: ["report.txt"], message: "the report" });
  expect(sent.content[0]!.text).toContain("): seen by @beta.");
  const withFile = await beta.delivered("the report");
  expect(withFile.message.files.map((f) => [f.name, f.size])).toEqual([["report.txt", 12]]);
  expect(withFile.replyTo).toBe("@{alpha,can}");

  await expect(alpha.run({ op: "write", to: "@nobody", message: "x" })).rejects.toThrow(/nobody/);

  // Inbound file: downloaded under ~/.agent-bus/received/<id>/ and named in the injected text.
  const upload = await fetch(`${bus.url}/api/files?from=can&name=notes.md`, {
    method: "POST",
    headers: { "Content-Type": "text/markdown" },
    body: "# notes\n",
  });
  const { file } = (await upload.json()) as { file: { id: string } };
  await post({ from: "can", to: "@alpha", text: "see notes", fileIds: [file.id] });
  const injected = await alpha.injectedWith("see notes");
  const saved = path.join(homedir(), ".agent-bus", "received", "alpha", `${file.id}-notes.md`);
  try {
    expect(injected.content).toContain(`File: ${saved} (notes.md, 8 B`);
    expect(await Bun.file(saved).text()).toBe("# notes\n");
  } finally {
    rmSync(saved, { force: true });
    if (readdirSync(path.dirname(saved)).length === 0) rmdirSync(path.dirname(saved));
  }

  beta.ws.close();
});

test("subagent sessions do not join and cannot use the tool", async () => {
  const sub = new FakeOmp(path.join(dataDir, "projects", "gamma"), "sub");
  sessions.push(sub);
  sub.start();
  await startSession("alpha"); // a later participants frame proves gamma never joined
  expect(participants.some((p) => p.id === "gamma")).toBe(false);
  await expect(sub.run({ op: "write", to: "@alpha", message: "x" })).rejects.toThrow(/not on the message bus/);
});

test("write reports recipients that are offline, then tells the writer quietly when they receive it", async () => {
  const alpha = await startSession("alpha");
  const gamma = await rawAgent("gamma");
  await post({ from: "gamma", to: "@can", text: "taking part" }); // agents that never took part are forgotten on logoff
  gamma.ws.close();
  await participantsWhere((ps) => ps.some((p) => p.id === "gamma" && !p.online));

  process.env.AGENT_BUS_RECEIPT_WAIT_MS = "50";
  try {
    const wrote = await alpha.run({ op: "write", to: "@gamma", message: "are you there" });
    expect(wrote.content[0]!.text).toContain(
      "not delivered yet (offline or reconnecting): @gamma. You will be told when they receive it."
    );
  } finally {
    delete process.env.AGENT_BUS_RECEIPT_WAIT_MS;
  }

  const back = await rawAgent("gamma");
  await back.delivered("are you there");
  expect(await alpha.injectedWith("@gamma has now received your message")).toMatchObject({
    via: "message",
    deliverAs: "nextTurn",
  });
});

test("a delivery is reported seen when its text reaches the model, not when it is queued", async () => {
  const alpha = await startSession("alpha");
  alpha.idle = false;
  const { message } = await post({ from: "can", to: "@alpha", text: "queued while busy" });
  const queued = await alpha.injectedWith("queued while busy");
  expect(queued.deliverAs).toBe("aside");

  const receiptOf = async (waitMs: number) =>
    ((await (await fetch(`${bus.url}/api/messages/${message.seq}?waitMs=${waitMs}`)).json()) as {
      message: { receipts: Array<{ deliveredAt: number | null; seenAt: number | null }> };
    }).message.receipts[0]!;
  expect((await receiptOf(5000)).deliveredAt).toBeNumber();

  // A model request for the current turn does not contain it yet.
  alpha.modelRequest(["the running turn's own prompt"]);
  expect((await receiptOf(0)).seenAt).toBeNull();

  // The turn ends, the follow-up is dequeued into the next request: seen.
  const viewer = new WebSocket(`${bus.url.replace(/^http/, "ws")}/ws/viewer`);
  sockets.push(viewer);
  const seenFrame = Promise.withResolvers<{ seenAt: number | null }>();
  viewer.addEventListener("message", (e) => {
    const frame = JSON.parse(String(e.data)) as { type: string; seq?: number; seenAt?: number | null };
    if (frame.type === "receipt" && frame.seq === message.seq) seenFrame.resolve({ seenAt: frame.seenAt ?? null });
  });
  await new Promise((resolve) => viewer.addEventListener("open", resolve, { once: true }));
  alpha.modelRequest(["older stuff", queued.content]);
  expect((await seenFrame.promise).seenAt).toBeNumber();
  expect((await receiptOf(0)).seenAt).toBeNumber();
});

test("sessions started in the temp directory do not join unless AGENT_BUS_JOIN_FROM_TMP=1", async () => {
  delete process.env.AGENT_BUS_JOIN_FROM_TMP;
  const scratch = new FakeOmp(path.join(dataDir, "projects", "scratch"));
  sessions.push(scratch);
  scratch.start();
  await expect(scratch.run({ op: "write", to: "@can", message: "x" })).rejects.toThrow(/not on the message bus/);
  process.env.AGENT_BUS_JOIN_FROM_TMP = "1";
  await startSession("alpha"); // a later participants frame proves scratch never joined
  expect(participants.some((p) => p.id === "scratch")).toBe(false);
});

test("reply answers a message by its number, into that message's conversation", async () => {
  const alpha = await startSession("alpha");
  const beta = await rawAgent("beta");

  // A group alpha was not the one to address: beta wrote to @{alpha,can}; can joined later in another way.
  const { message } = await post({ from: "beta", to: "@{alpha,can}", text: "please check run 7" });
  await alpha.injectedWith("please check run 7");
  const replied = await alpha.run({ op: "reply", message_id: message.seq, message: "run 7 is fine" });
  expect(replied.content[0]!.text).toMatch(new RegExp(`^Replied to #${message.seq} \\(conversation ${message.conversationId}, message #\\d+\\): seen by @beta\\.`));
  expect((await beta.delivered("run 7 is fine")).conversation.id).toBe(message.conversationId);

  // Replies to @all stay in @all.
  const { message: announcement } = await post({ from: "can", to: "@all", text: "who is free?" });
  await alpha.injectedWith("who is free?");
  await alpha.run({ op: "reply", message_id: announcement.seq, message: "alpha is free" });
  expect((await beta.delivered("alpha is free")).conversation.id).toBe("all");

  // A conversation alpha is not in: refused.
  const { message: private_ } = await post({ from: "beta", to: "@can", text: "just between us" });
  await expect(alpha.run({ op: "reply", message_id: private_.seq, message: "x" })).rejects.toThrow(/not in conversation/);
  await expect(alpha.run({ op: "reply", message_id: 999_999, message: "x" })).rejects.toThrow(/Unknown message #999999/);
  await expect(alpha.run({ op: "reply", message_id: message.seq })).rejects.toThrow(/reply needs/);
});
