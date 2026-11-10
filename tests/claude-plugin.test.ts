import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ActivityEvent, AgentServerFrame, Message, Participant, PostMessageResponse } from "@agent-bus/protocol";
import { createBusServer, type BusServerHandle } from "@agent-bus/server";
import { ActivityLog } from "../packages/client/src/activity";
import { McpServer } from "../packages/claude-plugin/src/server";
import { ClaudeSession, type HookInput } from "../packages/claude-plugin/src/session";
import { TranscriptFollower } from "../packages/claude-plugin/src/transcript";

let dataDir = "";
let bus: BusServerHandle;
let session: ClaudeSession | undefined;
const sockets: WebSocket[] = [];
/** Channel events the session sent, oldest first. */
let channel: Array<{ content: string; meta: Record<string, string> }> = [];
let transcript = "";

async function until<T>(check: () => T | Promise<T>, ms = 4000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false && value !== null) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(25);
  }
}

function folder(name: string): string {
  const dir = path.join(dataDir, "projects", name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function participant(id: string): Promise<Participant | undefined> {
  const state = (await (await fetch(`${bus.url}/api/state`)).json()) as { participants: Participant[] };
  return state.participants.find((p) => p.id === id);
}

async function message(seq: number): Promise<Message> {
  return ((await (await fetch(`${bus.url}/api/messages/${seq}`)).json()) as { message: Message }).message;
}

async function post(body: object): Promise<PostMessageResponse> {
  const res = await fetch(`${bus.url}/api/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  expect(res.status).toBe(200);
  return (await res.json()) as PostMessageResponse;
}

async function rawAgent(name: string): Promise<void> {
  const ws = new WebSocket(`${bus.url.replace(/^http/, "ws")}/ws/agent?host=test&harness=raw&path=${encodeURIComponent(folder(name))}`);
  sockets.push(ws);
  const joined = Promise.withResolvers<void>();
  ws.addEventListener("message", (e) => {
    const frame = JSON.parse(String(e.data)) as AgentServerFrame;
    if (frame.type === "joined") joined.resolve();
    if (frame.type === "deliver") ws.send(JSON.stringify({ type: "ack", seq: frame.message.seq }));
  });
  await joined.promise;
}

/** Appends a record to the session transcript, as Claude Code does before a model request. */
function write(record: object): void {
  appendFileSync(transcript, `${JSON.stringify({ timestamp: new Date().toISOString(), isSidechain: false, ...record })}\n`);
}

/** What Claude Code writes for a channel event that started a turn. */
function channelArrived(content: string): void {
  write({ type: "user", uuid: crypto.randomUUID(), message: { role: "user", content: `<channel source="plugin:message-bus:message-bus">\n${content}\n</channel>` } });
}

function input(extra: Partial<HookInput> = {}): HookInput {
  return { session_id: "s1", transcript_path: transcript, ...extra };
}

async function startSession(name = "alpha", channelWorks = true): Promise<ClaudeSession> {
  session = new ClaudeSession({
    folder: folder(name),
    busUrl: bus.url,
    sendChannel: async (content, meta) => {
      channel.push({ content, meta });
      if (channelWorks) channelArrived(content);
    },
    log: () => {},
  });
  session.hook("SessionStart", input({ source: "startup" }));
  await until(async () => (await participant(name))?.online);
  return session;
}

const seenBy = async (seq: number, id = "alpha") => (await message(seq)).receipts.find((r) => r.to === id)?.seenAt;
const deliveredTo = async (seq: number, id = "alpha") => (await message(seq)).receipts.find((r) => r.to === id)?.deliveredAt;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "mb-claude-test-"));
  bus = createBusServer({ host: "127.0.0.1", port: 0, dataDir, humans: ["can", "umit"] });
  process.env.AGENT_BUS_RECEIPT_WAIT_MS = "300";
  channel = [];
  transcript = path.join(dataDir, "transcript.jsonl");
  writeFileSync(transcript, "");
});

afterEach(async () => {
  session?.close();
  session = undefined;
  for (const ws of sockets.splice(0)) ws.close();
  await bus.stop();
  delete process.env.AGENT_BUS_RECEIPT_WAIT_MS;
  rmSync(dataDir, { recursive: true, force: true });
});

test("an idle session gets a wake message as a channel event; it is seen once it is in the transcript", async () => {
  await startSession();
  const { message: hello } = await post({ from: "can", to: "@alpha", text: "hello alpha" });
  const event = await until(() => channel[0]);
  expect(event.content).toContain(`[message-bus] #${hello.seq} @can`);
  expect(event.content).toContain("hello alpha");
  expect(event.meta).toEqual({ message_id: String(hello.seq) });
  await until(() => seenBy(hello.seq));
  // The channel turn is running: the session reports busy.
  await until(async () => (await participant("alpha"))?.status?.state === "busy");
});

test("a channel-started turn's UserPromptSubmit (run before the transcript has the event) does not add the message again", async () => {
  // A channel that does not write the transcript itself: Claude Code runs the hook first.
  session = new ClaudeSession({
    folder: folder("alpha"),
    busUrl: bus.url,
    sendChannel: async (content, meta) => {
      channel.push({ content, meta });
    },
    log: () => {},
  });
  session.hook("SessionStart", input({ source: "startup" }));
  await until(async () => (await participant("alpha"))?.online);
  const { message: m } = await post({ from: "can", to: "@alpha", text: "wake up" });
  const event = await until(() => channel[0]);
  const prompt = `<channel source="plugin:message-bus:message-bus" message_id="${m.seq}">\n${event.content}\n</channel>`;
  expect(session.hook("UserPromptSubmit", input({ prompt }))).toEqual({});
  await until(() => seenBy(m.seq));
});

test("a wake message for a busy session joins the running turn at the next tool result, not as a channel event", async () => {
  await startSession();
  session!.hook("UserPromptSubmit", input());
  session!.hook("PreToolUse", input({ tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "sleep 5", description: "Wait a bit" } }));
  const busy = await until(async () => {
    const p = await participant("alpha");
    return p?.status?.tool === "Bash" ? p.status : undefined;
  });
  expect(busy.activity).toBe("Wait a bit");

  const { message: ping } = await post({ from: "can", to: "@alpha", text: "ping while busy" });
  await until(() => deliveredTo(ping.seq));
  expect(channel).toEqual([]);
  expect(await seenBy(ping.seq)).toBeNull();

  const answer = session!.hook("PostToolUse", input({ tool_name: "Bash", tool_use_id: "t1" })) as {
    hookSpecificOutput?: { hookEventName: string; additionalContext: string };
  };
  expect(answer.hookSpecificOutput?.hookEventName).toBe("PostToolUse");
  expect(answer.hookSpecificOutput?.additionalContext).toContain(`[message-bus] #${ping.seq} @can`);
  await until(() => seenBy(ping.seq));
  // Given once.
  expect(session!.hook("PostToolUse", input({ tool_use_id: "t2" }))).toEqual({});
});

test("a wake message held during a turn without tool calls starts the next turn when the turn stops", async () => {
  await startSession();
  session!.hook("UserPromptSubmit", input());
  const { message: later } = await post({ from: "can", to: "@alpha", text: "after your turn" });
  await until(() => deliveredTo(later.seq));
  expect(channel).toEqual([]);
  session!.hook("Stop", input());
  const event = await until(() => channel[0]);
  expect(event.content).toContain("after your turn");
  await until(() => seenBy(later.seq));
});

test("an interrupted turn (no Stop hook) also releases held wake messages", async () => {
  await startSession();
  session!.hook("UserPromptSubmit", input());
  const { message: m } = await post({ from: "can", to: "@alpha", text: "are you there" });
  await until(() => deliveredTo(m.seq));
  write({ type: "user", uuid: "i1", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } });
  await until(() => channel[0]?.content.includes("are you there"));
});

test("quiet @all messages from agents wait for the next prompt and start no turn", async () => {
  await startSession();
  await rawAgent("beta");
  const { message: note } = await post({ from: "beta", to: "@all", text: "GPU 2 released" });
  await until(() => deliveredTo(note.seq));
  expect(channel).toEqual([]);
  const answer = session!.hook("UserPromptSubmit", input()) as { hookSpecificOutput?: { additionalContext: string } };
  expect(answer.hookSpecificOutput?.additionalContext).toContain("GPU 2 released");
  await until(() => seenBy(note.seq));
});

test("subagents' tool hooks do not take the session's held messages", async () => {
  await startSession();
  await rawAgent("beta");
  const { message: note } = await post({ from: "beta", to: "@all", text: "quiet note" });
  await until(() => deliveredTo(note.seq));
  expect(session!.hook("PostToolUse", input({ agent_id: "sub1", tool_use_id: "x" }))).toEqual({});
  const answer = session!.hook("PostToolUse", input({ tool_use_id: "y" })) as { hookSpecificOutput?: { additionalContext: string } };
  expect(answer.hookSpecificOutput?.additionalContext).toContain("quiet note");
});

test("without a working channel, wake messages go along with the next prompt", async () => {
  process.env.AGENT_BUS_CHANNEL_CHECK_MS = "200";
  try {
    // The module reads the check delay at load time; a fresh import picks up the short one.
    const { ClaudeSession: Fresh } = await import(`../packages/claude-plugin/src/session.ts?short=${Date.now()}`);
    session = new Fresh({
      folder: folder("alpha"),
      busUrl: bus.url,
      sendChannel: async (content: string, meta: Record<string, string>) => {
        channel.push({ content, meta }); // dropped: nothing reaches the transcript
      },
      log: () => {},
    }) as ClaudeSession;
    session.hook("SessionStart", input({ source: "startup" }));
    await until(async () => (await participant("alpha"))?.online);

    const { message: first } = await post({ from: "can", to: "@alpha", text: "first" });
    await until(() => channel.length === 1);
    // One drop can be timing: it is sent again. After the second drop the session stops using the channel.
    await until(() => channel.length === 2);
    expect(channel[1]?.content).toContain("first");
    await Bun.sleep(400);
    const { message: second } = await post({ from: "can", to: "@alpha", text: "second" });
    await until(() => deliveredTo(second.seq));
    expect(channel.length).toBe(2);

    const answer = session.hook("UserPromptSubmit", input()) as { hookSpecificOutput?: { additionalContext: string } };
    const text = answer.hookSpecificOutput?.additionalContext ?? "";
    expect(text).toContain(`#${first.seq} @can`);
    expect(text).toContain(`#${second.seq} @can`);
    expect(text.indexOf(`#${first.seq} `)).toBeLessThan(text.indexOf(`#${second.seq} `));
    await until(() => seenBy(first.seq));
    await until(() => seenBy(second.seq));
  } finally {
    delete process.env.AGENT_BUS_CHANNEL_CHECK_MS;
  }
});

test("wake messages that arrive before the channel is ready (the join backlog at startup) are sent once it is", async () => {
  const ready = Promise.withResolvers<void>();
  session = new ClaudeSession({
    folder: folder("alpha"),
    busUrl: bus.url,
    sendChannel: async (content, meta) => {
      channel.push({ content, meta });
      channelArrived(content);
    },
    channelReady: ready.promise,
    log: () => {},
  });
  session.hook("SessionStart", input({ source: "resume" }));
  await until(async () => (await participant("alpha"))?.online);
  const { message: early } = await post({ from: "can", to: "@alpha", text: "early bird" });
  await until(() => deliveredTo(early.seq));
  await Bun.sleep(100);
  expect(channel).toEqual([]);
  ready.resolve();
  await until(() => channel[0]?.content.includes("early bird"));
  await until(() => seenBy(early.seq));
});

test("the MCP server declares the channel, lists the tool and sends channel events after initialization", async () => {
  const out: Array<Record<string, unknown>> = [];
  const mcp = new McpServer((line) => out.push(JSON.parse(line) as Record<string, unknown>));
  mcp.offBus = "started in the temp directory";
  mcp.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } }));
  const sent = mcp.channel("[message-bus] #1 @can → @alpha\nhi", { message_id: "1" });
  await Bun.sleep(20);
  const init = out[0]?.result as { capabilities: { experimental: Record<string, unknown> }; instructions: string };
  expect(init.capabilities.experimental["claude/channel"]).toEqual({});
  expect(init.instructions).toContain("message-bus");
  expect(out.length).toBe(1); // the channel event waits for `initialized`
  mcp.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  await sent;
  expect(out[1]).toEqual({
    jsonrpc: "2.0",
    method: "notifications/claude/channel",
    params: { content: "[message-bus] #1 @can → @alpha\nhi", meta: { message_id: "1" } },
  });
  mcp.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
  mcp.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "message-bus", arguments: { op: "inbox" } } }));
  await until(() => out.length === 4);
  const tools = (out.find((m) => m.id === 2)?.result as { tools: Array<{ name: string }> }).tools;
  expect(tools.map((t) => t.name)).toEqual(["message-bus"]);
  const call = out.find((m) => m.id === 3)?.result as { isError: boolean; content: Array<{ text: string }> };
  expect(call.isError).toBe(true);
  expect(call.content[0]?.text).toContain("not on the message bus (started in the temp directory)");
});

test("the tool acts as the session's folder agent", async () => {
  await startSession();
  expect(await session!.runTool({ op: "write", to: "@can", message: "hi from claude" })).toContain("(you are @alpha)");
  expect((await participant("alpha"))?.harness).toBe("claude");
});

test("live output turns transcript records into prompts, channel deliveries, text and tool calls with results", async () => {
  const file = path.join(dataDir, "live.jsonl");
  const line = (record: object) => `${JSON.stringify({ timestamp: "2026-11-10T07:00:00Z", isSidechain: false, ...record })}\n`;
  writeFileSync(
    file,
    line({ type: "user", uuid: "u1", message: { role: "user", content: "fix the test" } }) +
      line({ type: "assistant", uuid: "a1", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "Looking." }] } }) +
      line({ type: "assistant", uuid: "a2", message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "bun test" } }] } }) +
      line({ type: "user", uuid: "u2", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "1 fail", is_error: true }] } }) +
      line({ type: "user", uuid: "u3", isSidechain: true, message: { role: "user", content: "subagent prompt" } }) +
      line({ type: "user", uuid: "u4", message: { role: "user", content: '<channel source="plugin:message-bus:message-bus">\n[message-bus] #7 @can → @{alpha,can}\nhi\n</channel>' } }) +
      line({ type: "queue-operation", operation: "enqueue", content: "[message-bus] #9 @can → @alpha\nqueued, not sent yet" }) +
      line({ type: "attachment", uuid: "h1", attachment: { type: "hook_additional_context", hookEvent: "PostToolUse", content: ["[message-bus] #8 @umit → @{alpha,umit}\nmid-turn"] } })
  );
  const batches: ActivityEvent[][] = [];
  const headers: number[] = [];
  const log = new ActivityLog((events) => batches.push(events));
  const follower = new TranscriptFollower({ onHeaders: (seqs) => headers.push(...seqs), onInterrupted: () => {} }, log);
  follower.follow(file);
  log.setWatching(true);
  try {
    const replay = batches[0] ?? [];
    expect(replay.map((e) => e.kind)).toEqual(["user", "assistant", "tool", "user", "user"]);
    expect(replay[0]).toMatchObject({ kind: "user", text: "fix the test" });
    expect(replay[1]).toMatchObject({ kind: "assistant", text: "Looking." });
    expect(replay[2]).toMatchObject({ kind: "tool", name: "Bash", input: "bun test", output: "1 fail", state: "error" });
    expect(replay[3]).toMatchObject({ kind: "user", text: "[message-bus] #7 @can → @{alpha,can}\nhi" });
    expect(replay[4]).toMatchObject({ kind: "user", text: "[message-bus] #8 @umit → @{alpha,umit}\nmid-turn" });
    expect(headers).toEqual([7, 8]);

    appendFileSync(file, line({ type: "assistant", uuid: "a3", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "Fixed." }] } }));
    const later = await until(() => batches.slice(1).flat().find((e) => e.kind === "assistant" && e.text === "Fixed."), 3000);
    expect(later.id).toBe("a:m2");
  } finally {
    follower.stop();
    log.dispose();
  }
});
