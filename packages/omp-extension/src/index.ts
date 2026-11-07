// omp extension: joins the message bus as the session's project folder and exposes the
// `message-bus` tool (write / send / set). Messages for this agent arrive like composer input:
// idle → a turn starts; busy → `aside`: at the next step of the running turn, without cutting a tool
// batch short, and ending a running `wait` (an agent waiting inside its turn for a bus reply would
// otherwise never see it); quiet (@all from other agents, unless `set all wake`) → added to the
// conversation at the next turn without starting one.
// Only the main session joins; subagents share the folder but are not bus participants.
import { realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deliveryHeader, deliveryHeaderSeqs, describeReceipts, formatAddress, formatUtc, quoteLine } from "../../protocol/src/address";
import {
  DEFAULT_BUS_PORT,
  type AgentStatus,
  type Conversation,
  type FileRef,
  type Message,
  type PostMessageResponse,
  type ReadResponse,
  type ReceiptFrame,
} from "../../protocol/src/types";
import { ActivityLog, contentText, contentThinking } from "./activity";
import { BusConnection, type Delivery } from "./connection";

interface ZodSchemaLike {
  optional(): ZodSchemaLike;
  describe(text: string): ZodSchemaLike;
}

/** The slice of omp's injected Zod-compatible builder (`pi.zod`) this extension uses. */
interface ZodLike {
  object(shape: Record<string, ZodSchemaLike>): ZodSchemaLike;
  string(): ZodSchemaLike;
  number(): ZodSchemaLike;
  enum(values: [string, ...string[]]): ZodSchemaLike;
  array(item: ZodSchemaLike): ZodSchemaLike;
}

export interface MessageBusToolParams {
  op: "reply" | "write" | "send" | "set" | "inbox" | "show" | "history" | "search";
  message_id?: number;
  to?: string;
  message?: string;
  files?: string[];
  key?: string;
  value?: string;
  query?: string;
  sender?: string;
  since?: number;
  limit?: number;
  scope?: "mine" | "all";
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
}

/** The slice of omp's `ExtensionContext` used here (omp ships as a binary; no type package to import). */
export interface MessageBusContext {
  cwd: string;
  agent?: { kind: "main" | "sub" };
  isIdle(): boolean;
  /** Absent in some harness modes (and in tests): notices are best effort. */
  ui?: { notify(message: string, level: "info" | "warning" | "error"): void };
  /** Managed timer: a throw in the callback does not tear the session down. Absent in tests. */
  setTimeout?(fn: () => void, ms: number): unknown;
}

/** How long a new session may take to join before the user is told it is not on the bus. */
const JOIN_NOTICE_MS = 8000;
/** Status reports are coalesced into one per this window (a batch of tool calls sends one report). */
const STATUS_COALESCE_MS = 250;

/** The slice of omp's `ExtensionAPI` used here. */
export interface MessageBusApi {
  zod: ZodLike;
  on(event: "session_start", handler: (event: unknown, ctx: MessageBusContext) => void): void;
  on(event: "session_shutdown", handler: () => void): void;
  /** Runs before every model request with the messages the model will get. */
  on(event: "context", handler: (event: { messages: unknown[] }) => void): void;
  on(event: "agent_start", handler: () => void): void;
  on(event: "agent_end", handler: (event: { willContinue?: boolean }) => void): void;
  on(
    event: "tool_execution_start",
    handler: (event: { toolCallId: string; toolName: string; args?: unknown; intent?: string }) => void
  ): void;
  on(event: "tool_execution_update", handler: (event: { toolCallId: string; partialResult?: { content?: unknown } }) => void): void;
  on(
    event: "tool_execution_end",
    handler: (event: { toolCallId: string; result?: { content?: unknown }; isError?: boolean }) => void
  ): void;
  on(
    event: "message_start" | "message_update" | "message_end",
    handler: (event: { message?: { role?: string; content?: unknown; timestamp?: number } }) => void
  ): void;
  registerTool(definition: {
    name: string;
    label: string;
    description: string;
    parameters: ZodSchemaLike;
    execute(
      toolCallId: string,
      params: MessageBusToolParams,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: MessageBusContext
    ): Promise<ToolResult>;
  }): void;
  sendUserMessage(content: string, options: { deliverAs?: "aside"; attribution: "agent" }): void;
  sendMessage(
    message: { customType: string; content: string; display: boolean; attribution: "agent" },
    options: { deliverAs: "nextTurn" }
  ): void;
}

export const TOOL_NAME = "message-bus";
/** Every argument the tool takes; anything else is rejected rather than silently ignored. */
const TOOL_ARGS: readonly string[] = [
  "op", "message_id", "to", "message", "files", "key", "value", "query", "sender", "since", "limit", "scope",
];

/** `dir` is the temp directory (`os.tmpdir()`, symlinks resolved) or inside it. */
function isUnderTempDir(dir: string): boolean {
  let tmp = os.tmpdir();
  try {
    tmp = realpathSync(tmp);
    dir = realpathSync(dir);
  } catch {
    // Keep the unresolved paths.
  }
  return dir === tmp || dir.startsWith(tmp.endsWith(path.sep) ? tmp : tmp + path.sep);
}

/** Text injected into the session for one delivery; `savedFiles` are local paths of its attachments. */
export function formatDelivery(delivery: Delivery, savedFiles: string[]): string {
  const { message, conversation, replyTo } = delivery;
  const where = conversation.kind === "all" ? "@all" : formatAddress(conversation.addressed);
  const lines = [deliveryHeader(message.seq, message.from, where, message.createdAt)];
  if (message.quote) lines.push(quoteLine(message.quote));
  if (message.text) lines.push(message.text);
  message.files.forEach((file, i) => {
    lines.push(`File: ${savedFiles[i] ?? file.name} (${file.name}, ${file.size} B, sha256 ${file.sha256.slice(0, 12)}…)`);
  });
  lines.push(`(Reply only if they need something from you: ${TOOL_NAME} reply, message_id ${message.seq} → ${replyTo}.)`);
  return lines.join("\n");
}

/** Per-message text shown by inbox and history; `show` gives all of it. */
const READ_TEXT_CHARS = 3000;
/** Total size of one read result, so a large page cannot flood the context (older messages are dropped first). */
const READ_BUDGET_CHARS = 30_000;

/**
 * One message as the read ops list it. Deliberately not the delivery header (`[message-bus] #n @…`): read results
 * must not look like new messages, and the seen-detection keys on that header.
 */
export function formatReadMessage(message: Message, conversation: Conversation | undefined, maxText: number, savedFiles: string[] = []): string {
  const where = !conversation ? message.conversationId : conversation.kind === "all" ? "@all" : formatAddress(conversation.members);
  const lines = [`#${message.seq} @${message.from} → ${where} · ${formatUtc(message.createdAt)}`];
  if (message.quote) lines.push(quoteLine(message.quote));
  if (message.text) {
    lines.push(
      message.text.length > maxText
        ? `${message.text.slice(0, maxText)}… (${message.text.length} chars; op=show message_id ${message.seq} for all)`
        : message.text
    );
  }
  message.files.forEach((file, i) => lines.push(`File: ${savedFiles[i] ?? file.name} (${file.name}, ${file.size} B)`));
  return lines.join("\n");
}

/** "#n · time · @from → where: …snippet…" around the first match of `query`. */
export function formatSearchHit(message: Message, conversation: Conversation | undefined, query: string): string {
  const where = !conversation ? message.conversationId : conversation.kind === "all" ? "@all" : formatAddress(conversation.members);
  const flat = message.text.replace(/\s+/g, " ").trim();
  const at = query ? flat.toLowerCase().indexOf(query.toLowerCase()) : 0;
  const start = Math.max(0, at - 80);
  const snippet = `${start > 0 ? "…" : ""}${flat.slice(start, start + 200)}${start + 200 < flat.length ? "…" : ""}`;
  const files = message.files.length > 0 ? ` [${message.files.map((f) => f.name).join(", ")}]` : "";
  return `#${message.seq} · ${formatUtc(message.createdAt)} · @${message.from} → ${where}: ${snippet || "(no text)"}${files}`;
}

/** Joins entries newest-last within the budget, dropping the oldest first. */
function withinBudget(entries: string[], separator: string): { text: string; dropped: number } {
  const kept: string[] = [];
  let size = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] ?? "";
    if (kept.length > 0 && size + entry.length > READ_BUDGET_CHARS) break;
    kept.unshift(entry);
    size += entry.length + separator.length;
  }
  return { text: kept.join(separator), dropped: entries.length - kept.length };
}

/** How long write/send wait for recipients' harnesses to accept the message before reporting (ms). */
const receiptWaitMs = (): number => Number(process.env.AGENT_BUS_RECEIPT_WAIT_MS) || 5000;

export default function messageBus(pi: MessageBusApi): void {
  let connection: BusConnection | undefined;
  let sessionCtx: MessageBusContext | undefined;
  const z = pi.zod;
  /** Group messages this session wrote whose recipients were still pending when the tool returned. */
  const awaitingReceipts = new Map<number, Set<string>>();

  /** Waits for receipts and returns the delivery line for the tool result; remembers late group recipients. */
  const deliveryStatus = async (conn: BusConnection, sent: PostMessageResponse): Promise<string> => {
    const message = await conn.waitForReceipts(sent.message.seq, receiptWaitMs());
    const pending = message.receipts.filter((r) => r.deliveredAt === null).map((r) => r.to);
    const late = pending.length > 0 && sent.conversation.kind === "group";
    if (late) awaitingReceipts.set(message.seq, new Set(pending));
    return `${describeReceipts(message.receipts)}${late ? ". You will be told when they receive it" : ""}`;
  };

  const onReceipt = (receipt: ReceiptFrame): void => {
    const pending = awaitingReceipts.get(receipt.seq);
    if (!pending?.delete(receipt.to)) return;
    if (pending.size === 0) awaitingReceipts.delete(receipt.seq);
    pi.sendMessage(
      {
        customType: TOOL_NAME,
        content: `[message-bus] @${receipt.to} has now received your message #${receipt.seq} (conversation ${receipt.conversationId}).`,
        display: true,
        attribution: "agent",
      },
      { deliverAs: "nextTurn" }
    );
  };

  /** Delivered seqs the model has not been given yet. */
  const unseen = new Set<number>();

  const deliver = async (delivery: Delivery): Promise<void> => {
    const conn = connection;
    if (!conn?.id) throw new Error("delivery before join");
    const saved: string[] = [];
    if (delivery.message.files.length > 0) {
      const dir = path.join(os.homedir(), ".agent-bus", "received", conn.id);
      for (const file of delivery.message.files) saved.push(await conn.downloadFile(file, dir));
    }
    const text = formatDelivery(delivery, saved);
    unseen.add(delivery.message.seq);
    if (!delivery.wake) {
      pi.sendMessage(
        { customType: TOOL_NAME, content: text, display: true, attribution: "agent" },
        { deliverAs: "nextTurn" }
      );
    } else if (sessionCtx?.isIdle() ?? true) {
      pi.sendUserMessage(text, { attribution: "agent" });
    } else {
      pi.sendUserMessage(text, { deliverAs: "aside", attribution: "agent" });
    }
  };

  // A delivery is "seen" once its header is in what goes to the model (idle start, dequeued follow-up, or
  // a quiet message joining the next turn alike).
  pi.on("context", (event) => {
    const conn = connection;
    if (!conn || unseen.size === 0) return;
    for (const seq of deliveryHeaderSeqs(JSON.stringify(event.messages))) {
      if (unseen.delete(seq)) conn.markSeen(seq);
    }
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.agent?.kind === "sub" || connection) return;
    const projectPath = path.resolve(ctx.cwd);
    // Scratch sessions in the temp directory are not project agents (set AGENT_BUS_JOIN_FROM_TMP=1 to test there).
    if (isUnderTempDir(projectPath) && process.env.AGENT_BUS_JOIN_FROM_TMP !== "1") {
      ctx.ui?.notify("message-bus: not joining (session started in the temp directory)", "info");
      return;
    }
    sessionCtx = ctx;
    const url = (process.env.AGENT_BUS_URL?.trim() || `http://127.0.0.1:${DEFAULT_BUS_PORT}`).replace(/\/+$/, "");
    let announced = false;
    const conn = new BusConnection({
      url,
      host: os.hostname(),
      harness: "omp",
      path: projectPath,
      onDeliver: deliver,
      onReceipt,
      onWatch: (on) => activityLog.setWatching(on),
      onJoined: (id) => {
        if (announced) return;
        announced = true;
        ctx.ui?.notify(`message-bus: on the bus as @${id}`, "info");
      },
      onLog: (line) => console.error(`[message-bus] ${line}`),
    });
    connection = conn;
    conn.connect();
    // Stored by the connection and sent once it has joined (and after every rejoin).
    publishStatus();
    ctx.setTimeout?.(() => {
      if (connection !== conn || conn.connected) return;
      ctx.ui?.notify(
        `message-bus: cannot reach the bus at ${url} (still retrying). Check AGENT_BUS_URL and the network.`,
        "warning"
      );
    }, JOIN_NOTICE_MS);
  });

  // ---- Status for the bus (website, GET /api/state): idle/busy, running tool, latest intent. No model turns. ----
  let busy = false;
  let since = Date.now();
  let activity: string | undefined;
  const runningTools = new Map<string, { name: string; since: number }>();
  let statusTimer: Timer | undefined;
  const publishStatus = (): void => {
    statusTimer = undefined;
    const conn = connection;
    if (!conn) return;
    const status: AgentStatus = { state: busy ? "busy" : "idle", since };
    const oldest = [...runningTools.values()].sort((a, b) => a.since - b.since)[0];
    if (busy && oldest) {
      status.tool = oldest.name;
      status.toolSince = oldest.since;
    }
    if (busy && activity) status.activity = activity;
    try {
      conn.reportStatus(status);
    } catch (err) {
      console.error(`[message-bus] status report failed: ${(err as Error).message}`);
    }
  };
  /** Coalesces bursts (a batch of tool calls) into one report a moment later. */
  const statusChanged = (): void => {
    if (!connection || statusTimer) return;
    statusTimer = setTimeout(publishStatus, STATUS_COALESCE_MS);
  };
  pi.on("agent_start", () => {
    if (!busy) {
      busy = true;
      since = Date.now();
    }
    statusChanged();
  });
  pi.on("agent_end", (event) => {
    if (event.willContinue) return;
    busy = false;
    since = Date.now();
    runningTools.clear();
    activity = undefined;
    statusChanged();
  });
  pi.on("tool_execution_start", (event) => {
    runningTools.set(event.toolCallId, { name: event.toolName, since: Date.now() });
    if (typeof event.intent === "string" && event.intent.trim()) activity = event.intent.trim();
    statusChanged();
    if (connection) activityLog.toolStart(event.toolCallId, event.toolName, event.args, event.intent);
  });
  pi.on("tool_execution_end", (event) => {
    runningTools.delete(event.toolCallId);
    statusChanged();
    if (connection) activityLog.toolOutput(event.toolCallId, contentText(event.result?.content), event.isError ? "error" : "done");
  });

  // ---- Live output for whoever watches this agent's page on the website (sent only while watched). ----
  const activityLog = new ActivityLog((events, replay) => connection?.sendActivity(events, replay));
  pi.on("tool_execution_update", (event) => {
    if (connection) activityLog.toolOutput(event.toolCallId, contentText(event.partialResult?.content), "running");
  });
  const onMessage = (done: boolean) => (event: { message?: { role?: string; content?: unknown; timestamp?: number } }) => {
    const message = event.message;
    if (!connection || !message) return;
    const at = typeof message.timestamp === "number" ? message.timestamp : Date.now();
    if (message.role === "assistant") {
      activityLog.assistant(at, contentText(message.content), contentThinking(message.content), done);
    }
    else if (message.role === "user" && !done) activityLog.user(at, contentText(message.content));
  };
  pi.on("message_start", onMessage(false));
  pi.on("message_update", onMessage(false));
  pi.on("message_end", onMessage(true));

  pi.on("session_shutdown", () => {
    clearTimeout(statusTimer);
    statusTimer = undefined;
    activityLog.dispose();
    connection?.close();
    connection = undefined;
    sessionCtx = undefined;
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Message bus",
    description:
      "Talk to the other agents and the humans (@can, @umit) on the shared message bus. " +
      // Same text as the cost note in packages/hermes-plugin/message-bus/__init__.py.
      "Every message you send starts a paid model turn for each agent it reaches (@all reaches every agent), so use the " +
      "bus sparingly: write only when the recipients need it (a result, a decision, a question, a claim or release of a " +
      "shared resource). Do not send acknowledgements, thanks or \"noted/received\" messages, and do not restate other " +
      "agents' messages; not replying is the default. Send to the fewest recipients who need it: @id or @{ids} rather " +
      "than @all, and only the agents who have to read or act on it. Your bus id comes from your " +
      "project folder and is shown in every result (sessions started in the temp directory do not join). " +
      "Messages for you arrive in this conversation on their own as " +
      "\"[message-bus] #<message_id> @sender → …\", also while you are working: after your current tool call finishes, " +
      "and they end a running `wait`. So never poll, and never read the bus database or files under ~/.agent-bus to " +
      "look for replies; keep working (or wait) and the reply comes to you. " +
      "op=reply: answer a message you received: `message_id` (the #number) plus `message` and/or `files`; it goes to that " +
      "message's conversation, so you never need to work out an address. " +
      "op=write: start or continue a conversation: `to` is \"@all\", \"@id\" or \"@{id1,id2}\" (a group; the same set always " +
      "reuses the same conversation), plus `message` and/or `files` (local paths). " +
      "op=send: the same as write, with `files` required. Unknown arguments are rejected and nothing is sent; every " +
      "result says what the bus stored (text length, file names). " +
      "op=set: `key` + `value`; settings: all = wake | quiet (whether @all messages from other agents start a turn for you; default quiet). " +
      "Reading (no turns for anyone, only your own tokens; never read the bus database instead): " +
      "op=inbox: messages sent to you, newest `limit` (default 20), optionally only after #`since`. " +
      "op=show: one message by `message_id`, in full, with its files downloaded. " +
      "op=history: the last `limit` messages of a conversation: `to` (as you would write to it, e.g. \"@all\", \"@hilde\") " +
      "or the conversation of `message_id`. " +
      "op=search: messages whose text contains `query` and/or from `sender`, newest `limit`, as one-line hits. " +
      "show, history and search cover the conversations you are in (and @all); add scope=\"all\" for every conversation.",
    parameters: z.object({
      op: z
        .enum(["reply", "write", "send", "set", "inbox", "show", "history", "search"])
        .describe("reply/write/send a message, set a setting, or read: inbox, show, history, search"),
      message_id: z.number().optional().describe("a message's #number (reply, show, history)"),
      to: z.string().optional().describe('"@all", "@id" or "@{id1,id2}" (write/send, history)'),
      message: z.string().optional().describe("message text (reply/write; optional caption for send)"),
      files: z.array(z.string()).optional().describe("file paths, relative to the project folder or absolute (optional for reply and write)"),
      key: z.string().optional().describe("setting name (set)"),
      value: z.string().optional().describe("setting value (set)"),
      query: z.string().optional().describe("text to find, case-insensitive (search)"),
      sender: z.string().optional().describe("only messages from this id (search)"),
      since: z.number().optional().describe("only messages after this #number (inbox)"),
      limit: z.number().optional().describe("how many messages, default 20, at most 100 (inbox, history, search)"),
      scope: z.enum(["mine", "all"]).optional().describe('"mine" (default): your conversations and @all; "all": every conversation'),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const conn = connection;
      if (!conn) {
        throw new Error("This session is not on the message bus: subagents and sessions started in the temp directory do not join.");
      }
      // omp passes arguments outside the schema through; ignoring them once stored an empty reply (`content` for `message`).
      const unknown = Object.keys(params).filter((key) => !TOOL_ARGS.includes(key));
      if (unknown.length > 0) {
        throw new Error(`Unknown argument${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}; the arguments are ${TOOL_ARGS.join(", ")}. Nothing was sent.`);
      }
      const result = (out: string): ToolResult => ({ content: [{ type: "text", text: `${out} (you are @${conn.id})` }] });
      const upload = async (files: string[]): Promise<FileRef[]> => {
        const refs: FileRef[] = [];
        for (const file of files) refs.push(await conn.uploadFile(path.resolve(ctx.cwd, file)));
        return refs;
      };
      /** "text 812 chars, 2 files: a.patch, b.py" — what the bus stored, so a wrong argument shows at once. */
      const contents = (res: PostMessageResponse): string => {
        const files = res.message.files;
        const text = res.message.text.length > 0 ? `text ${res.message.text.length} chars` : "no text";
        return files.length > 0 ? `${text}, ${files.length} file${files.length === 1 ? "" : "s"}: ${files.map((f) => f.name).join(", ")}` : text;
      };
      const sent = async (what: string, res: PostMessageResponse): Promise<ToolResult> =>
        result(`${what} (conversation ${res.conversation.id}, message #${res.message.seq}): ${contents(res)}; ${await deliveryStatus(conn, res)}.`);

      /** Messages of a read result, newest kept when the page is too large. */
      const listed = (res: ReadResponse, what: string): string => {
        const byId = new Map(res.conversations.map((c) => [c.id, c]));
        const entries = res.messages.map((m) => formatReadMessage(m, byId.get(m.conversationId), READ_TEXT_CHARS));
        const { text, dropped } = withinBudget(entries, "\n\n");
        return `${res.messages.length} ${what}${dropped ? ` (${dropped} older ones left out; use a smaller limit)` : ""}:\n\n${text}\n`;
      };
      switch (params.op) {
        case "reply": {
          if (params.message_id === undefined || (!params.message && !params.files?.length)) {
            throw new Error("reply needs `message_id` and `message` (or `files`).");
          }
          const refs = await upload(params.files ?? []);
          const res = await conn.write({ replyToSeq: params.message_id }, params.message ?? "", refs.map((r) => r.id));
          return sent(`Replied to #${params.message_id}`, res);
        }
        case "write": {
          if (!params.to || (!params.message && !params.files?.length)) throw new Error("write needs `to` and `message` (or `files`).");
          const refs = await upload(params.files ?? []);
          return sent(`Sent to ${params.to}`, await conn.write({ to: params.to }, params.message ?? "", refs.map((r) => r.id)));
        }
        case "send": {
          if (!params.to || !params.files?.length) throw new Error("send needs `to` and `files`.");
          const refs = await upload(params.files);
          const res = await conn.write({ to: params.to }, params.message ?? "", refs.map((r) => r.id));
          return sent(`Sent to ${params.to}`, res);
        }
        case "set": {
          if (!params.key || params.value === undefined) throw new Error("set needs `key` and `value`.");
          const res = await conn.set(params.key, params.value);
          return result(`Settings now: ${JSON.stringify(res.participant.settings)}.`);
        }
        case "inbox": {
          const res = await conn.inbox(params.since ?? 0, params.limit ?? 20);
          if (res.messages.length === 0) return result(`No messages for you${params.since ? ` after #${params.since}` : ""}.`);
          return result(listed(res, "messages sent to you"));
        }
        case "show": {
          if (params.message_id === undefined) throw new Error("show needs `message_id`.");
          const { message, conversation } = await conn.message(params.message_id);
          if (params.scope !== "all" && conversation.kind === "group" && !conversation.members.includes(conn.id ?? "")) {
            throw new Error(`#${message.seq} is in a conversation you are not in (${formatAddress(conversation.members)}); add scope "all" to read it.`);
          }
          const saved: string[] = [];
          if (message.files.length > 0) {
            const dir = path.join(os.homedir(), ".agent-bus", "received", conn.id ?? "");
            for (const file of message.files) saved.push(await conn.downloadFile(file, dir));
          }
          return result(formatReadMessage(message, conversation, Number.MAX_SAFE_INTEGER, saved));
        }
        case "history": {
          let target: { to: string } | { conversationId: string };
          if (params.to) target = { to: params.to };
          else if (params.message_id !== undefined) target = { conversationId: (await conn.message(params.message_id)).message.conversationId };
          else throw new Error("history needs `to` (an address) or `message_id` (that message's conversation).");
          const res = await conn.history(target, params.limit ?? 20, params.scope === "all");
          if (res.messages.length === 0) return result("No messages in that conversation yet.");
          return result(listed(res, "messages, oldest first"));
        }
        case "search": {
          if (!params.query?.trim() && !params.sender) throw new Error("search needs `query` and/or `sender`.");
          const res = await conn.search(params.query ?? "", params.sender, params.limit ?? 20, params.scope === "all");
          if (res.messages.length === 0) return result("No matching messages.");
          const byId = new Map(res.conversations.map((c) => [c.id, c]));
          const hits = res.messages.map((m) => formatSearchHit(m, byId.get(m.conversationId), params.query ?? ""));
          const { text, dropped } = withinBudget(hits, "\n");
          return result(`${res.messages.length} matching messages, oldest first${dropped ? ` (${dropped} older ones left out)` : ""}:\n${text}\n`);
        }
      }
    },
  });
}
