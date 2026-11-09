import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ActivityEvent, AgentServerFrame, Message, Participant, PostMessageResponse } from "@agent-bus/protocol";
import { createBusServer, type BusServerHandle } from "@agent-bus/server";
import { ActivityLog } from "../packages/client/src/activity";
import { Daemon, type HookPayload } from "../packages/antigravity-plugin/src/daemon";
import { TranscriptActivity } from "../packages/antigravity-plugin/src/transcript";

let dataDir = "";
let bus: BusServerHandle;
let daemon: Daemon | undefined;
const sockets: WebSocket[] = [];
let sentLog = "";

/** Polls until `check` returns a value (not undefined/false), or fails after `ms`. */
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

/** Hook payload of a conversation in `workspace` (none for conversations without a folder). */
function payload(conversationId: string, workspace?: string, extra: Partial<HookPayload> = {}): HookPayload {
  return { conversationId, workspacePaths: workspace ? [folder(workspace)] : [], transcriptPath: "", ...extra };
}

/** Every `agentapi send-message <conversation> <content>` the daemon ran, oldest first. */
function sent(): Array<[string, string]> {
  if (!existsSync(sentLog)) return [];
  return readFileSync(sentLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as [string, string]);
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

/** Another agent on a raw socket (joined, acking), to write as an agent. */
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

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "mb-ag-test-"));
  bus = createBusServer({ host: "127.0.0.1", port: 0, dataDir, humans: ["can", "umit"] });
  process.env.AGENT_BUS_URL = bus.url;
  process.env.AGENT_BUS_JOIN_FROM_TMP = "1"; // test folders live under the temp dir
  process.env.AGENT_BUS_RECEIPT_WAIT_MS = "300";
  // A fake agentapi: records send-message calls; conversations named "sub…" are subagents.
  sentLog = path.join(dataDir, "sent.jsonl");
  const fake = path.join(dataDir, "agentapi");
  writeFileSync(
    fake,
    `#!/usr/bin/env bun
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "send-message") require("node:fs").appendFileSync(${JSON.stringify(sentLog)}, JSON.stringify(rest) + "\\n");
if (cmd === "get-conversation-metadata") {
  const sub = rest[0].startsWith("sub");
  console.log(JSON.stringify({ response: { conversationMetadata: { metadata: { nestingDepth: sub ? 1 : 0, parentConversationId: sub ? "main" : "" } } } }));
}
`
  );
  chmodSync(fake, 0o755);
  process.env.AGENT_BUS_AGENTAPI = fake;
});

afterEach(async () => {
  daemon?.close();
  daemon = undefined;
  for (const ws of sockets.splice(0)) ws.close();
  await bus.stop();
  for (const key of ["AGENT_BUS_URL", "AGENT_BUS_JOIN_FROM_TMP", "AGENT_BUS_RECEIPT_WAIT_MS", "AGENT_BUS_AGENTAPI"]) delete process.env[key];
  rmSync(dataDir, { recursive: true, force: true });
});

test("a wake message goes into the folder's latest conversation and counts as seen at that conversation's next model call", async () => {
  daemon = new Daemon();
  await daemon.hook("SessionStart", payload("c1", "alpha"));
  await daemon.hook("PreInvocation", payload("c2", "alpha"));
  await until(async () => (await participant("alpha"))?.online);
  const { message: hello } = await post({ from: "can", to: "@alpha", text: "hello alpha" });

  const [conversation, content] = await until(() => sent()[0]);
  expect(conversation).toBe("c2");
  expect(content).toContain(`[message-bus] #${hello.seq} @can`);
  expect(content).toContain("hello alpha");
  const delivered = await until(async () => {
    const m = await message(hello.seq);
    return m.receipts[0]?.deliveredAt !== null ? m : undefined;
  });
  expect(delivered.receipts[0]?.seenAt).toBeNull();

  // Another conversation's model call does not see it; c2's does.
  await daemon.hook("PreInvocation", payload("c1", "alpha"));
  expect((await message(hello.seq)).receipts[0]?.seenAt).toBeNull();
  await daemon.hook("PreInvocation", payload("c2", "alpha"));
  await until(async () => (await message(hello.seq)).receipts[0]?.seenAt !== null);
});

test("after a daemon restart, an idle conversation's folder is back on the bus and still gets its messages", async () => {
  const stateFile = path.join(dataDir, "agents.json");
  daemon = new Daemon(stateFile);
  await daemon.hook("PreInvocation", payload("c1", "alpha"));
  await until(async () => (await participant("alpha"))?.online);
  daemon.close();
  // An agent that never took part is forgotten when it goes offline.
  await until(async () => !(await participant("alpha"))?.online);

  // Antigravity restarts the daemon; the conversation runs no hook until it does something.
  daemon = new Daemon(stateFile);
  await until(async () => (await participant("alpha"))?.online);
  await post({ from: "can", to: "@alpha", text: "still there?" });
  const [conversation, content] = await until(() => sent()[0]);
  expect(conversation).toBe("c1");
  expect(content).toContain("still there?");
});

test("quiet @all messages from agents ride along with the next model call (no turn started) and are seen then", async () => {
  daemon = new Daemon();
  await daemon.hook("SessionStart", payload("c1", "alpha"));
  await until(async () => (await participant("alpha"))?.online);
  await rawAgent("beta");
  const { message: note } = await post({ from: "beta", to: "@all", text: "GPU 2 released" });
  await until(async () => (await message(note.seq)).receipts.find((r) => r.to === "alpha")?.deliveredAt);

  const answer = (await daemon.hook("PreInvocation", payload("c1", "alpha"))) as {
    injectSteps?: Array<{ userMessage: string }>;
  };
  expect(answer.injectSteps?.[0]?.userMessage).toContain("GPU 2 released");
  expect(sent()).toEqual([]);
  await until(async () => (await message(note.seq)).receipts.find((r) => r.to === "alpha")?.seenAt);
  // Given once only.
  expect(await daemon.hook("PreInvocation", payload("c1", "alpha"))).toEqual({});
});

test("tool calls act as the calling conversation's folder; conversations without a folder and subagents are refused", async () => {
  daemon = new Daemon();
  const call = async (conversationId: string, workspace: string | undefined, args: object) => {
    const answer = (await daemon!.hook(
      "PreToolUse",
      payload(conversationId, workspace, {
        toolCall: { name: "call_mcp_tool", args: { ServerName: "message-bus_message-bus", ToolName: "message-bus", Arguments: args } },
      })
    )) as { decision: string; overwrite?: { Arguments: Record<string, unknown> } };
    expect(answer.decision).toBe("allow");
    return daemon!.callTool(answer.overwrite?.Arguments ?? (args as Record<string, unknown>));
  };
  await daemon.hook("SessionStart", payload("c1", "alpha"));
  await daemon.hook("SessionStart", payload("c3", "beta"));
  await until(async () => (await participant("alpha"))?.online && (await participant("beta"))?.online);

  expect(await call("c1", "alpha", { op: "write", to: "@can", message: "from alpha" })).toContain("(you are @alpha)");
  expect(await call("c3", "beta", { op: "write", to: "@can", message: "from beta" })).toContain("(you are @beta)");

  await daemon.hook("SessionStart", payload("c9", undefined));
  await expect(call("c9", undefined, { op: "inbox" })).rejects.toThrow(/not on the message bus/);

  await daemon.hook("SessionStart", payload("sub-1", "gamma"));
  await daemon.hook("PreInvocation", payload("sub-1", "gamma"));
  await expect(call("sub-1", "gamma", { op: "inbox" })).rejects.toThrow(/Subagents/);
  expect(await participant("gamma")).toBeUndefined();

  // Other tools pass untouched.
  expect(await daemon.hook("PreToolUse", payload("c1", "alpha", { toolCall: { name: "run_command", args: { CommandLine: "ls" } } }))).toEqual({
    decision: "allow",
  });
});

test("status follows the conversation: busy with its tool and summary, idle when the loop stops", async () => {
  daemon = new Daemon();
  await daemon.hook("PreInvocation", payload("c1", "alpha"));
  await until(async () => (await participant("alpha"))?.status?.state === "busy");
  await daemon.hook(
    "PreToolUse",
    payload("c1", "alpha", { toolCall: { name: "run_command", args: { CommandLine: "bun test", toolSummary: "Running the tests" } } })
  );
  const busy = await until(async () => {
    const p = await participant("alpha");
    return p?.status?.tool === "run_command" ? p.status : undefined;
  });
  expect(busy.activity).toBe("Running the tests");
  await daemon.hook("PostToolUse", payload("c1", "alpha", { toolCall: { name: "run_command" } }));
  await daemon.hook("Stop", payload("c1", "alpha", { fullyIdle: true }));
  await until(async () => (await participant("alpha"))?.status?.state === "idle");
});

test("live output pairs each tool result with its call, unwraps prompts and bus deliveries, and follows appends", async () => {
  const file = path.join(dataDir, "transcript_full.jsonl");
  const line = (step: object) => `${JSON.stringify({ created_at: "2026-11-09T21:00:00Z", status: "DONE", ...step })}\n`;
  writeFileSync(
    file,
    line({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "<USER_REQUEST>\nfix the test\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>" }) +
      line({
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        thinking: "Look first.",
        tool_calls: [
          { name: "run_command", args: { CommandLine: "bun test", toolSummary: "Run tests" } },
          { name: "read_file", args: { Path: "/x/a.ts" } },
        ],
      }) +
      line({ step_index: 2, source: "MODEL", type: "GENERIC", content: "1 fail" }) +
      line({ step_index: 3, source: "MODEL", type: "GENERIC", error: "no such file", content: "" }) +
      line({ step_index: 4, source: "SYSTEM", type: "SYSTEM_MESSAGE", content: "<SYSTEM_MESSAGE>\n[message-bus] #7 @can → @{alpha,can}\nhi\n</SYSTEM_MESSAGE>" })
  );
  const batches: ActivityEvent[][] = [];
  const log = new ActivityLog((events) => batches.push(events));
  const follower = new TranscriptActivity(file, log, "conv");
  follower.start();
  log.setWatching(true);
  try {
    const replay = batches[0] ?? [];
    expect(replay.map((e) => e.kind)).toEqual(["user", "assistant", "tool", "tool", "user"]);
    expect(replay[0]).toMatchObject({ kind: "user", text: "fix the test" });
    expect(replay[1]).toMatchObject({ kind: "assistant", thinking: "Look first." });
    expect(replay[2]).toMatchObject({ kind: "tool", name: "run_command", input: "bun test", intent: "Run tests", output: "1 fail", state: "done" });
    expect(replay[3]).toMatchObject({ kind: "tool", name: "read_file", input: "/x/a.ts", state: "error" });
    expect(replay[4]).toMatchObject({ kind: "user", text: "[message-bus] #7 @can → @{alpha,can}\nhi" });

    appendFileSync(file, line({ step_index: 5, source: "MODEL", type: "PLANNER_RESPONSE", content: "Fixed." }));
    const later = await until(() => batches.slice(1).flat().find((e) => e.kind === "assistant" && e.text === "Fixed."), 3000);
    expect(later.id).toBe("s:conv:5");
  } finally {
    follower.stop();
    log.dispose();
  }
});
