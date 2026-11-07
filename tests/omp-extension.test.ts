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
  private handlers = new Map<string, (event: never, ctx: MessageBusContext) => void>();
  tool?: Parameters<MessageBusApi["registerTool"]>[0];

  constructor(readonly cwd: string, readonly kind: "main" | "sub" = "main") {
    const chain = { optional: () => chain, describe: () => chain };
    const api: MessageBusApi = {
      zod: { object: () => chain, string: () => chain, number: () => chain, enum: () => chain, array: () => chain },
      on: ((event: string, handler: (event: never, ctx: MessageBusContext) => void) => {
        this.handlers.set(event, handler);
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

  /** Fires omp event `name` at the extension, as omp would. */
  emit(name: string, event: unknown = {}): void {
    this.handlers.get(name)?.(event as never, this.ctx);
  }

  start(): void {
    this.emit("session_start");
  }

  shutdown(): void {
    this.emit("session_shutdown");
  }

  run(params: MessageBusToolParams) {
    return this.tool!.execute("call", params, undefined, undefined, this.ctx);
  }

  /** Simulates a model request whose context holds `contents` (as omp user/custom messages). */
  modelRequest(contents: string[]): void {
    this.emit("context", { messages: contents.map((content) => ({ role: "user", content: [{ type: "text", text: content }] })) });
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
  expect(wrote.content[0]!.text).toMatch(
    /^Sent to @beta \(conversation g_\w+, message #\d+\): text 15 chars; seen by @beta\. \(you are @alpha\)$/
  );
  const dm = await beta.delivered("ping from alpha");
  expect(dm.replyTo).toBe("@alpha");
  expect(dm.conversation.addressed).toEqual(["alpha", "beta"]);

  // An argument outside the tool's set is an error and nothing is sent (it used to store an empty message).
  const before = (await (await fetch(`${bus.url}/api/state`)).json()) as { conversations: Array<{ lastMessageAt: number }> };
  await expect(
    alpha.run({ op: "reply", message_id: dm.message.seq, content: "wrong key" } as unknown as MessageBusToolParams)
  ).rejects.toThrow(/Unknown argument content; .* Nothing was sent/);
  const after = (await (await fetch(`${bus.url}/api/state`)).json()) as { conversations: Array<{ lastMessageAt: number }> };
  expect(after.conversations.map((c) => c.lastMessageAt)).toEqual(before.conversations.map((c) => c.lastMessageAt));

  const filePath = path.join(dataDir, "projects", "alpha", "report.txt");
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, "results: 42\n");
  const sent = await alpha.run({ op: "send", to: "@{beta,can}", files: ["report.txt"], message: "the report" });
  expect(sent.content[0]!.text).toContain("): text 10 chars, 1 file: report.txt; seen by @beta.");
  const withFile = await beta.delivered("the report");
  expect(withFile.message.files.map((f) => [f.name, f.size])).toEqual([["report.txt", 12]]);
  expect(withFile.replyTo).toBe("@{alpha,can}");
  // write takes files too (they used to be dropped without a word).
  const wroteFile = await alpha.run({ op: "write", to: "@beta", files: ["report.txt"], message: "again" });
  expect(wroteFile.content[0]!.text).toContain("): text 5 chars, 1 file: report.txt;");
  expect((await beta.delivered("again")).message.files.map((f) => f.name)).toEqual(["report.txt"]);

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
  expect(replied.content[0]!.text).toMatch(
    new RegExp(`^Replied to #${message.seq} \\(conversation ${message.conversationId}, message #\\d+\\): text 13 chars; seen by @beta\\.`)
  );
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

test("the agent reports its status to the bus without a model turn: busy with its tool and intent, waiting messages, then idle", async () => {
  const alpha = await startSession("alpha");
  const alphaIs = (pred: (p: Participant) => boolean) =>
    participantsWhere((ps) => ps.some((p) => p.id === "alpha" && pred(p)));
  const current = () => participants.find((p) => p.id === "alpha");
  await alphaIs((p) => p.status?.state === "idle");

  alpha.idle = false;
  alpha.emit("agent_start");
  alpha.emit("tool_execution_start", { toolCallId: "t1", toolName: "bash", intent: "Running the release export" });
  await alphaIs((p) => p.status?.tool === "bash");
  expect(current()?.status).toMatchObject({ state: "busy", tool: "bash", activity: "Running the release export" });

  // A message for the busy agent counts as waiting until its model sees it.
  await post({ from: "can", to: "@alpha", text: "status check" });
  const queued = await alpha.injectedWith("status check");
  await alphaIs((p) => p.waiting === 1);
  alpha.modelRequest([queued.content]);
  await alphaIs((p) => p.waiting === 0);

  // A turn that continues stays busy; the end of the run is idle, without tool or intent.
  alpha.emit("tool_execution_end", { toolCallId: "t1" });
  alpha.emit("agent_end", { willContinue: true });
  await alphaIs((p) => p.status?.state === "busy" && p.status.tool === undefined);
  alpha.emit("agent_end", {});
  await alphaIs((p) => p.status?.state === "idle");
  expect(current()?.status?.activity).toBeUndefined();

  // Status never reaches the model: the only injection is the bus message.
  expect(alpha.injected.map((i) => i.content.includes("status check"))).toEqual([true]);
});

test("live output streams only while someone watches the agent's page: replay first, then changes", async () => {
  const alpha = await startSession("alpha");
  // Before anyone watches: recorded, not sent.
  alpha.emit("message_start", { message: { role: "user", content: [{ type: "text", text: "check the logs" }], timestamp: 1 } });
  alpha.emit("tool_execution_start", { toolCallId: "t1", toolName: "bash", args: { command: "tail -n 5 app.log" }, intent: "Reading the log" });
  alpha.emit("tool_execution_end", { toolCallId: "t1", result: { content: [{ type: "text", text: "all good" }] } });

  const watcher = new WebSocket(`${bus.url.replace(/^http/, "ws")}/ws/viewer`);
  sockets.push(watcher);
  const frames: Array<Extract<ViewerServerFrame, { type: "activity" }>> = [];
  let waiter: { until: () => boolean; resolve: () => void } | undefined;
  watcher.addEventListener("message", (e) => {
    const frame = JSON.parse(String(e.data)) as ViewerServerFrame;
    if (frame.type === "activity") frames.push(frame);
    if (waiter?.until()) waiter.resolve();
  });
  const until = (pred: () => boolean): Promise<void> => {
    if (pred()) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    waiter = { until: pred, resolve };
    return promise;
  };
  await new Promise((r) => watcher.addEventListener("open", r, { once: true }));
  watcher.send(JSON.stringify({ type: "watch", agentId: "alpha" }));

  await until(() => frames.some((f) => f.replay));
  const replay = frames.find((f) => f.replay)!;
  expect(replay.agentId).toBe("alpha");
  expect(replay.events.map((e) => e.kind)).toEqual(["user", "tool"]);
  expect(replay.events[1]).toMatchObject({ name: "bash", input: "tail -n 5 app.log", output: "all good", state: "done", intent: "Reading the log" });

  // Live: streaming text is an upsert of one entry, with the model's thoughts (thinking blocks) alongside.
  const thought = { type: "thinking", thinking: "Checking the last lines for errors.", thinkingSignature: "x" };
  alpha.emit("message_update", { message: { role: "assistant", content: [thought], timestamp: 2 } });
  alpha.emit("message_end", {
    message: { role: "assistant", content: [thought, { type: "text", text: "The log is clean." }], timestamp: 2 },
  });
  await until(() => frames.some((f) => f.events.some((e) => e.kind === "assistant" && e.done)));
  const assistant = frames.flatMap((f) => f.events).filter((e) => e.kind === "assistant").at(-1);
  expect(assistant).toMatchObject({
    id: "a:2",
    thinking: "Checking the last lines for errors.",
    text: "The log is clean.",
    done: true,
  });

  // Watcher leaves: the agent stops sending (no frame reaches a new watcher of someone else either).
  watcher.send(JSON.stringify({ type: "watch", agentId: null }));
  const count = frames.length;
  alpha.emit("message_start", { message: { role: "user", content: [{ type: "text", text: "after" }], timestamp: 3 } });
  await Bun.sleep(600); // longer than the extension's 300 ms flush window
  expect(frames.length).toBe(count);
  // Nothing of this reached the model.
  expect(alpha.injected).toEqual([]);
});

test("read ops: inbox, show, history and search, mine by default and all on request, without starting turns", async () => {
  const alpha = await startSession("alpha");
  const beta = await rawAgent("beta");
  const first = (await post({ from: "can", to: "@alpha", text: "first: please look at the GPU 3 claim" })).message;
  const second = (await post({ from: "beta", to: "@{alpha,can}", text: "second, with the long report" })).message;
  await post({ from: "beta", to: "@umit", text: "private to umit about GPU 3" }); // alpha is not in this one
  await alpha.injectedWith("second, with the long report");
  const injectedBefore = alpha.injected.length;
  const text = async (params: Parameters<FakeOmp["run"]>[0]) => (await alpha.run(params)).content[0]!.text;

  const inbox = await text({ op: "inbox" });
  expect(inbox).toContain("2 messages sent to you");
  expect(inbox).toContain(`#${first.seq} @can → @{alpha,can}`);
  expect(inbox).not.toContain("[message-bus]"); // read results must not look like deliveries
  expect(await text({ op: "inbox", since: first.seq })).toContain("1 messages sent to you");

  expect(await text({ op: "show", message_id: first.seq })).toContain("first: please look at the GPU 3 claim");
  const privateSeq = (await post({ from: "umit", to: "@beta", text: "umit to beta" })).message.seq;
  await expect(alpha.run({ op: "show", message_id: privateSeq })).rejects.toThrow(/not in .*scope "all"/);
  expect(await text({ op: "show", message_id: privateSeq, scope: "all" })).toContain("umit to beta");

  // One thread per set of agents: can→alpha is the alpha thread, beta→{alpha,can} the alpha+beta thread.
  const history = await text({ op: "history", to: "@can", limit: 5 });
  expect(history).toContain("first: please look");
  expect(history).not.toContain("second,");
  expect(await text({ op: "history", to: "@beta" })).toContain("second, with the long report");
  expect(await text({ op: "history", message_id: second.seq })).toContain("1 messages, oldest first");
  await expect(alpha.run({ op: "history", to: "@nobody" })).rejects.toThrow(/Unknown id nobody/);
  const gamma = await rawAgent("gamma");
  await expect(alpha.run({ op: "history", to: "@gamma" })).rejects.toThrow(/No conversation of @alpha with @gamma/);
  gamma.ws.close();

  // Search: alpha's conversations and @all by default; every conversation with scope "all".
  const mine = await text({ op: "search", query: "gpu 3" });
  expect(mine).toContain("1 matching messages");
  expect(mine).toContain("@can → @{alpha,can}: first: please look at the GPU 3 claim");
  expect(await text({ op: "search", query: "gpu 3", scope: "all" })).toContain("2 matching messages");
  expect(await text({ op: "search", sender: "beta", scope: "all" })).toContain("private to umit");

  // Reading delivered nothing new and started no turn.
  expect(alpha.injected.length).toBe(injectedBefore);
  beta.ws.close();
});
