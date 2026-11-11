import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Message, Participant, PostMessageResponse, ViewerServerFrame } from "@agent-bus/protocol";
import { createBusServer, type BusServerHandle } from "@agent-bus/server";
import { agentToken } from "../packages/client/src/connection";
import { McpServer } from "../packages/codex-plugin/src/server";
import { CodexSession, HOOK_TOOL, type HookInput } from "../packages/codex-plugin/src/session";

let dataDir = "";
let bus: BusServerHandle;
let session: CodexSession | undefined;

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

async function post(body: object, headers: Record<string, string> = {}): Promise<PostMessageResponse> {
  const res = await fetch(`${bus.url}/api/messages`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  expect(res.status).toBe(200);
  return (await res.json()) as PostMessageResponse;
}

const hookInput = (extra: Partial<HookInput> = {}): HookInput => ({ cwd: folder("alpha"), ...extra });
const seenBy = async (seq: number) => (await message(seq)).receipts.find((r) => r.to === "alpha")?.seenAt;
const deliveredTo = async (seq: number) => (await message(seq)).receipts.find((r) => r.to === "alpha")?.deliveredAt;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "mb-codex-test-"));
  bus = createBusServer({ host: "127.0.0.1", port: 0, dataDir, humans: ["can"] });
});

afterEach(async () => {
  session?.close();
  session = undefined;
  await bus.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

async function start(): Promise<CodexSession> {
  session = new CodexSession(folder("alpha"), bus.url);
  session.hook("SessionStart", hookInput({ source: "startup" }));
  await until(async () => (await participant("alpha"))?.online);
  return session;
}

test("Codex deliveries are injected by the next hook and marked seen", async () => {
  await start();
  const { message: incoming } = await post({ from: "can", to: "@alpha", text: "please inspect this" });
  await until(() => deliveredTo(incoming.seq));
  expect(await seenBy(incoming.seq)).toBeNull();
  const answer = session!.hook("UserPromptSubmit", hookInput({ prompt: "continue" })) as { hookSpecificOutput?: { additionalContext: string } };
  expect(answer.hookSpecificOutput?.additionalContext).toContain(`[message-bus] #${incoming.seq} @can`);
  expect(answer.hookSpecificOutput?.additionalContext).toContain("please inspect this");
  await until(() => seenBy(incoming.seq));
  expect(session!.hook("PostToolUse", hookInput())).toEqual({});
  expect((await participant("alpha"))?.harness).toBe("codex");
});

test("a message arriving during a turn blocks Stop once so Codex continues with it", async () => {
  await start();
  session!.hook("UserPromptSubmit", hookInput());
  const { message: incoming } = await post({ from: "can", to: "@alpha", text: "urgent follow-up" });
  await until(() => deliveredTo(incoming.seq));
  const answer = session!.hook("Stop", hookInput()) as { decision?: string; reason?: string };
  expect(answer.decision).toBe("block");
  expect(answer.reason).toContain("urgent follow-up");
  await until(() => seenBy(incoming.seq));
  expect(session!.hook("Stop", hookInput())).toEqual({});
});

test("the Codex MCP server exposes the tool and reports an off-bus task", async () => {
  const out: Array<Record<string, unknown>> = [];
  const mcp = new McpServer((line) => out.push(JSON.parse(line) as Record<string, unknown>));
  mcp.offBus = "started in the temp directory";
  mcp.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } }));
  mcp.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
  mcp.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "message-bus", arguments: { op: "inbox" } } }));
  await until(() => out.length === 3);
  const init = out.find((m) => m.id === 1)?.result as { instructions: string };
  expect(init.instructions).toContain("Message-bus deliveries");
  const tools = (out.find((m) => m.id === 2)?.result as { tools: Array<{ name: string }> }).tools;
  expect(tools.map((tool) => tool.name)).toEqual(["message-bus", HOOK_TOOL]);
  const call = out.find((m) => m.id === 3)?.result as { isError: boolean; content: Array<{ text: string }> };
  expect(call.isError).toBe(true);
  expect(call.content[0]?.text).toContain("not on the message bus (started in the temp directory)");
});

test("the message-bus tool acts as the Codex task's folder agent", async () => {
  await start();
  expect(await session!.runTool({ op: "write", to: "@can", message: "hi from codex" })).toContain("(you are @alpha)");
});

test("by default a viewer receives only the bound Codex chat's visible items, then live updates", async () => {
  const savedHome = process.env.CODEX_HOME;
  const task = "00000000-1111-2222-3333-444444444444";
  const sessions = path.join(dataDir, "sessions");
  mkdirSync(sessions);
  const file = path.join(sessions, `rollout-test-${task}.jsonl`);
  const item = (content: object, thread = task) => JSON.stringify({ type: "event_msg",
    payload: { type: "item_completed", thread_id: thread, item: content } }) + "\n";
  const reply = { id: "a", type: "AgentMessage", phase: "commentary", content: [{ type: "Text", text: "Checking build" }] };
  writeFileSync(file, item(reply) + item({ ...reply, id: "wrong" }, "some-other-chat") +
    item({ type: "Reasoning", id: "private", raw_content: "secret" }) +
    JSON.stringify({ type: "response_item", payload: { role: "developer", content: "secret" } }) + "\n");
  let viewer: WebSocket | undefined;
  try {
    process.env.CODEX_HOME = dataDir;
    session = new CodexSession(folder("alpha"), bus.url);
    await session.waitForStartup();
    viewer = new WebSocket(bus.url.replace(/^http/, "ws") + "/ws/viewer");
    const frames: Extract<ViewerServerFrame, { type: "activity" }>[] = [];
    viewer.addEventListener("message", (m) => {
      const f = JSON.parse(String(m.data)) as ViewerServerFrame;
      if (f.type === "activity") frames.push(f);
    });
    await new Promise((resolve) => viewer!.addEventListener("open", resolve, { once: true }));
    viewer.send(JSON.stringify({ type: "watch", agentId: "alpha" }));
    session.hook("SessionStart", { session_id: task, transcript_path: file });
    const replay = await until(() => frames.find((f) => f.replay));
    expect(replay.events).toHaveLength(1);
    expect(replay.events[0]).toMatchObject({ id: "a", text: "Checking build", done: true });
    const cmd = item({ type: "CommandExecution", id: "t", command: ["make"], status: "completed",
      exit_code: 0, aggregated_output: "built ✓" });
    const bytes = Buffer.from(cmd), split = bytes.indexOf(Buffer.from("✓")) + 1;
    appendFileSync(file, bytes.subarray(0, split));
    await Bun.sleep(450);
    appendFileSync(file, bytes.subarray(split));
    const live = await until(() => frames.find((f) => !f.replay));
    expect(live.events).toHaveLength(1);
    expect(live.events[0]).toMatchObject({ id: "t", input: "make", output: "built ✓", state: "done" });
    viewer.send(JSON.stringify({ type: "watch", agentId: null }));
    await Bun.sleep(100);
    const count = frames.length;
    appendFileSync(file, item({ ...reply, id: "b" }));
    await Bun.sleep(850);
    expect(frames.length).toBe(count);
  } finally {
    viewer?.close();
    if (savedHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedHome;
  }
});

test("idle direct messages coalesce into one wake for the bound task; seen waits for the hook", async () => {
  const wakes: string[] = [];
  const task = "00000000-1111-2222-3333-444444444444";
  session = new CodexSession(folder("alpha"), bus.url, () => {}, async (id) => { wakes.push(id); });
  session.hook("SessionStart", { session_id: task });
  await until(async () => (await participant("alpha"))?.online);
  const { message: first } = await post({ from: "can", to: "@alpha", text: "one" });
  await post({ from: "can", to: "@alpha", text: "two" });
  await until(() => wakes.length > 0);
  expect(wakes).toEqual([task]);
  expect(await seenBy(first.seq)).toBeNull();
  expect(session.hook("UserPromptSubmit", { session_id: "00000000-1111-2222-3333-555555555555" })).toEqual({});
  const response = JSON.stringify(session.hook("UserPromptSubmit", { session_id: task }));
  expect(response).toContain("one");
  expect(response).toContain("two");
  await until(() => seenBy(first.seq));
});

test("quiet broadcasts do not queue a Codex turn; a later direct message after interrupt does", async () => {
  const wakes: string[] = [];
  const task = "00000000-1111-2222-3333-444444444444";
  session = new CodexSession(folder("alpha"), bus.url, () => {}, async (id) => { wakes.push(id); });
  const sender = new CodexSession(folder("beta"), bus.url);
  try {
    session.hook("SessionStart", { session_id: task });
    await Promise.all([session.waitForStartup(), sender.waitForStartup()]);
    // beta joined through a real session, so its id is bound to this account's agent token.
    const { message: quiet } = await post({ from: "beta", to: "@all", text: "quiet" }, { "X-Agent-Token": agentToken() });
    await until(() => deliveredTo(quiet.seq));
    await Bun.sleep(250);
    expect(wakes).toEqual([]);
    session.hook("UserPromptSubmit", { session_id: task });
    session.hook("Interrupt", { session_id: task });
    await post({ from: "can", to: "@alpha", text: "direct" });
    await until(() => wakes.length === 1);
  } finally { sender.close(); }
});

test("tool discovery stays offline; a restarted task's MCP hook recovers a queued but unseen message", async () => {
  await start();
  const { message: incoming } = await post({ from: "can", to: "@alpha", text: "test before restart" });
  await until(() => deliveredTo(incoming.seq));
  session!.close();
  await until(async () => !(await participant("alpha"))?.online);
  const replies: string[] = [];
  const mcp = new McpServer((line) => replies.push(line), () => session = new CodexSession(folder("alpha"), bus.url));
  mcp.handleLine(JSON.stringify({ id: 1, method: "tools/list" }));
  await until(() => replies.length === 1);
  expect(mcp.session).toBeUndefined();
  const hook = (id: number) => mcp.handleLine(JSON.stringify({ id, method: "tools/call",
    params: { name: HOOK_TOOL, arguments: { event: "UserPromptSubmit" } } }));
  hook(2);
  await until(() => replies.length === 2);
  expect(JSON.parse(replies[1]!).result.structuredContent.hookSpecificOutput.additionalContext).toContain("test before restart");
  await until(() => seenBy(incoming.seq));
  hook(3);
  await until(() => replies.length === 3);
  expect(JSON.parse(replies[2]!).result.structuredContent).toEqual({});
});
