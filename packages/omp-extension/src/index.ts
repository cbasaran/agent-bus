// omp extension: joins the message bus as the session's project folder and exposes the
// `message-bus` tool (write / send / set). Messages for this agent arrive like composer input:
// idle → a turn starts; busy → queued until the current turn ends; quiet (@all from other agents,
// unless `set all wake`) → added to the conversation at the next turn without starting one.
// Only the main session joins; subagents share the folder but are not bus participants.
import { realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deliveryHeader, deliveryHeaderSeqs, describeReceipts, formatAddress } from "../../protocol/src/address";
import { DEFAULT_BUS_PORT, type FileRef, type PostMessageResponse, type ReceiptFrame } from "../../protocol/src/types";
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
  op: "reply" | "write" | "send" | "set";
  message_id?: number;
  to?: string;
  message?: string;
  files?: string[];
  key?: string;
  value?: string;
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

/** The slice of omp's `ExtensionAPI` used here. */
export interface MessageBusApi {
  zod: ZodLike;
  on(event: "session_start", handler: (event: unknown, ctx: MessageBusContext) => void): void;
  on(event: "session_shutdown", handler: () => void): void;
  /** Runs before every model request with the messages the model will get. */
  on(event: "context", handler: (event: { messages: unknown[] }) => void): void;
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
  sendUserMessage(content: string, options: { deliverAs?: "followUp"; attribution: "agent" }): void;
  sendMessage(
    message: { customType: string; content: string; display: boolean; attribution: "agent" },
    options: { deliverAs: "nextTurn" }
  ): void;
}

export const TOOL_NAME = "message-bus";

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
  const lines = [deliveryHeader(message.seq, message.from, where)];
  if (message.text) lines.push(message.text);
  message.files.forEach((file, i) => {
    lines.push(`File: ${savedFiles[i] ?? file.name} (${file.name}, ${file.size} B, sha256 ${file.sha256.slice(0, 12)}…)`);
  });
  lines.push(`(Reply only if they need something from you: ${TOOL_NAME} reply, message_id ${message.seq} → ${replyTo}.)`);
  return lines.join("\n");
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
      pi.sendUserMessage(text, { deliverAs: "followUp", attribution: "agent" });
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
      onJoined: (id) => {
        if (announced) return;
        announced = true;
        ctx.ui?.notify(`message-bus: on the bus as @${id}`, "info");
      },
      onLog: (line) => console.error(`[message-bus] ${line}`),
    });
    connection = conn;
    conn.connect();
    ctx.setTimeout?.(() => {
      if (connection !== conn || conn.connected) return;
      ctx.ui?.notify(
        `message-bus: cannot reach the bus at ${url} (still retrying). Check AGENT_BUS_URL and the network.`,
        "warning"
      );
    }, JOIN_NOTICE_MS);
  });

  pi.on("session_shutdown", () => {
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
      "\"[message-bus] #<message_id> @sender → …\" (never poll; there is no read). " +
      "op=reply: answer a message you received: `message_id` (the #number) plus `message` and/or `files`; it goes to that " +
      "message's conversation, so you never need to work out an address. " +
      "op=write: start or continue a conversation: `to` is \"@all\", \"@id\" or \"@{id1,id2}\" (a group; the same set always " +
      "reuses the same conversation), plus `message`. " +
      "op=send: `to` plus `files` (local paths) and an optional `message`. " +
      "op=set: `key` + `value`; settings: all = wake | quiet (whether @all messages from other agents start a turn for you; default quiet).",
    parameters: z.object({
      op: z.enum(["reply", "write", "send", "set"]).describe("reply to a message, write a message, send files, or set a setting"),
      message_id: z.number().optional().describe("the #number of the message you answer (reply)"),
      to: z.string().optional().describe('"@all", "@id" or "@{id1,id2}" (write/send)'),
      message: z.string().optional().describe("message text (reply/write; optional caption for send)"),
      files: z.array(z.string()).optional().describe("file paths, relative to the project folder or absolute (send; optional for reply)"),
      key: z.string().optional().describe("setting name (set)"),
      value: z.string().optional().describe("setting value (set)"),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const conn = connection;
      if (!conn) {
        throw new Error("This session is not on the message bus: subagents and sessions started in the temp directory do not join.");
      }
      const result = (out: string): ToolResult => ({ content: [{ type: "text", text: `${out} (you are @${conn.id})` }] });
      const upload = async (files: string[]): Promise<FileRef[]> => {
        const refs: FileRef[] = [];
        for (const file of files) refs.push(await conn.uploadFile(path.resolve(ctx.cwd, file)));
        return refs;
      };
      const sent = async (what: string, res: PostMessageResponse): Promise<ToolResult> =>
        result(`${what} (conversation ${res.conversation.id}, message #${res.message.seq}): ${await deliveryStatus(conn, res)}.`);

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
          if (!params.to || !params.message) throw new Error("write needs `to` and `message`.");
          return sent(`Sent to ${params.to}`, await conn.write({ to: params.to }, params.message));
        }
        case "send": {
          if (!params.to || !params.files?.length) throw new Error("send needs `to` and `files`.");
          const refs = await upload(params.files);
          const res = await conn.write({ to: params.to }, params.message ?? "", refs.map((r) => r.id));
          return sent(`Sent ${refs.map((r) => r.name).join(", ")} to ${params.to}`, res);
        }
        case "set": {
          if (!params.key || params.value === undefined) throw new Error("set needs `key` and `value`.");
          const res = await conn.set(params.key, params.value);
          return result(`Settings now: ${JSON.stringify(res.participant.settings)}.`);
        }
      }
    },
  });
}
