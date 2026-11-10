import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentServerFrame, Participant, PostMessageResponse, ViewerServerFrame } from "@agent-bus/protocol";
import { createBusServer, type BusServerHandle } from "@agent-bus/server";
import messageBus, {
  type MessageBusApi,
  type MessageBusContext,
  type MessageBusToolParams,
} from "../packages/pi-extension/src/index";

interface Injected {
  content: string;
  customType: string;
  deliverAs: string;
  triggerTurn?: boolean;
}

/** Fake pi session: records injected messages, exposes the registered tool and fires events. */
class FakePi {
  readonly injected: Injected[] = [];
  private waiters: Array<{ until: () => boolean; resolve: () => void }> = [];
  private handlers = new Map<string, (event: never, ctx: MessageBusContext) => void>();
  tool?: Parameters<MessageBusApi["registerTool"]>[0];

  constructor(readonly cwd: string, readonly mode = "tui") {
    const api: MessageBusApi = {
      on: ((event: string, handler: (event: never, ctx: MessageBusContext) => void) => {
        this.handlers.set(event, handler);
      }) as MessageBusApi["on"],
      registerTool: (definition) => {
        this.tool = definition;
      },
      sendMessage: (message, options) =>
        this.record({ content: message.content, customType: message.customType, deliverAs: options.deliverAs, triggerTurn: options.triggerTurn }),
    };
    messageBus(api);
  }

  private get ctx(): MessageBusContext {
    return { cwd: this.cwd, mode: this.mode };
  }

  emit(name: string, event: unknown = {}): void {
    this.handlers.get(name)?.(event as never, this.ctx);
  }

  start(): void {
    this.emit("session_start", { reason: "startup" });
  }

  shutdown(): void {
    this.emit("session_shutdown", { reason: "quit" });
  }

  run(params: MessageBusToolParams) {
    return this.tool!.execute("call", params, undefined, undefined, this.ctx);
  }

  modelRequest(contents: string[]): void {
    this.emit("context", { messages: contents.map((content) => ({ role: "custom", customType: "message-bus", content })) });
  }

  private record(entry: Injected): void {
    this.injected.push(entry);
    for (const w of this.waiters.filter((w) => w.until())) {
      this.waiters.splice(this.waiters.indexOf(w), 1);
      w.resolve();
    }
  }

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
const sessions: FakePi[] = [];
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

async function startSession(folder: string): Promise<FakePi> {
  const pi = new FakePi(path.join(dataDir, "projects", folder));
  sessions.push(pi);
  pi.start();
  await participantsWhere((ps) => ps.some((p) => p.id === folder && p.online));
  return pi;
}

/** Raw agent socket that acks and sees every delivery, returning delivered frames. */
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
  dataDir = mkdtempSync(path.join(tmpdir(), "mb-pi-test-"));
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
  delete process.env.AGENT_BUS_JOIN_NONINTERACTIVE;
  rmSync(dataDir, { recursive: true, force: true });
});

test("joins as harness pi; wake messages steer and trigger a turn, agents' @all waits for the next turn", async () => {
  const alpha = await startSession("alpha");
  expect(participants.find((p) => p.id === "alpha")?.harness).toBe("pi");
  const beta = await rawAgent("beta");

  const { message } = await post({ from: "can", to: "@alpha", text: "check the logs" });
  const wake = await alpha.injectedWith("check the logs");
  expect(wake).toMatchObject({ customType: "message-bus", deliverAs: "steer", triggerTurn: true });
  expect(wake.content).toStartWith(`[message-bus] #${message.seq} @can → @{alpha,can} · `);

  await post({ from: "beta", to: "@all", text: "beta finished a run" });
  expect(await alpha.injectedWith("beta finished a run")).toMatchObject({ deliverAs: "nextTurn", triggerTurn: undefined });

  const wrote = await alpha.run({ op: "write", to: "@beta", message: "ping from alpha" });
  expect(wrote.content[0]!.text).toMatch(/^Sent to @beta .*seen by @beta\. \(you are @alpha\)$/);
  expect(wrote.details).toEqual({});
  expect((await beta.delivered("ping from alpha")).replyTo).toBe("@alpha");
  beta.ws.close();
});

test("the tool schema is JSON Schema with op required", () => {
  const pi = new FakePi(path.join(dataDir, "projects", "alpha"));
  const schema = pi.tool!.parameters as { type: string; required: string[]; properties: Record<string, { type: string; enum?: string[] }> };
  expect(schema.type).toBe("object");
  expect(schema.required).toEqual(["op"]);
  expect(schema.properties.op!.enum).toContain("reply");
  expect(schema.properties.files).toMatchObject({ type: "array", items: { type: "string" } });
  expect(schema.properties.message_id!.type).toBe("number");
});

test("a delivery is seen when its header reaches the model", async () => {
  const alpha = await startSession("alpha");
  const { message } = await post({ from: "can", to: "@alpha", text: "seen check" });
  const injected = await alpha.injectedWith("seen check");
  const receipt = async (waitMs: number, until = "delivered") =>
    ((await (await fetch(`${bus.url}/api/messages/${message.seq}?waitMs=${waitMs}&until=${until}`)).json()) as {
      message: { receipts: Array<{ deliveredAt: number | null; seenAt: number | null }> };
    }).message.receipts[0]!;
  expect((await receipt(5000)).deliveredAt).toBeNumber();
  alpha.modelRequest(["something else"]);
  expect((await receipt(0)).seenAt).toBeNull();
  alpha.modelRequest([injected.content]);
  expect((await receipt(5000, "seen")).seenAt).toBeNumber();
});

test("non-interactive runs (print, json) do not join unless AGENT_BUS_JOIN_NONINTERACTIVE=1", async () => {
  const printed = new FakePi(path.join(dataDir, "projects", "gamma"), "print");
  sessions.push(printed);
  printed.start();
  await expect(printed.run({ op: "inbox" })).rejects.toThrow(/not on the message bus: non-interactive run \(--mode print\)/);
  await startSession("alpha"); // a later participants frame proves gamma never joined
  expect(participants.some((p) => p.id === "gamma")).toBe(false);

  process.env.AGENT_BUS_JOIN_NONINTERACTIVE = "1";
  const json = new FakePi(path.join(dataDir, "projects", "delta"), "json");
  sessions.push(json);
  json.start();
  await participantsWhere((ps) => ps.some((p) => p.id === "delta" && p.online));
});

test("status: busy from agent_start with the running tool, idle only at agent_settled", async () => {
  const alpha = await startSession("alpha");
  const alphaIs = (pred: (p: Participant) => boolean) => participantsWhere((ps) => ps.some((p) => p.id === "alpha" && pred(p)));
  await alphaIs((p) => p.status?.state === "idle");
  alpha.emit("agent_start");
  alpha.emit("tool_execution_start", { toolCallId: "t1", toolName: "bash", args: { command: "ls" } });
  await alphaIs((p) => p.status?.tool === "bash");
  alpha.emit("tool_execution_end", { toolCallId: "t1" });
  alpha.emit("agent_end", { messages: [] }); // not final in pi
  await alphaIs((p) => p.status?.state === "busy" && p.status.tool === undefined);
  alpha.emit("agent_settled", { aborted: false });
  await alphaIs((p) => p.status?.state === "idle");
});

test("live output shows bus deliveries (custom messages) and model text while watched", async () => {
  const alpha = await startSession("alpha");
  alpha.emit("message_start", { message: { role: "custom", customType: "message-bus", content: "[message-bus] #1 @can → @alpha · x\nhi", timestamp: 1 } });
  alpha.emit("message_start", { message: { role: "custom", customType: "other", content: "not ours", timestamp: 2 } });
  alpha.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 3 } });

  const watcher = new WebSocket(`${bus.url.replace(/^http/, "ws")}/ws/viewer`);
  sockets.push(watcher);
  const replay = Promise.withResolvers<Extract<ViewerServerFrame, { type: "activity" }>>();
  watcher.addEventListener("message", (e) => {
    const frame = JSON.parse(String(e.data)) as ViewerServerFrame;
    if (frame.type === "activity" && frame.replay) replay.resolve(frame);
  });
  await new Promise((r) => watcher.addEventListener("open", r, { once: true }));
  watcher.send(JSON.stringify({ type: "watch", agentId: "alpha" }));
  const frame = await replay.promise;
  expect(frame.events.map((e) => e.kind)).toEqual(["user", "assistant"]);
  expect(frame.events[0]).toMatchObject({ text: expect.stringContaining("hi") });
});
