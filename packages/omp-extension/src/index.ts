// omp extension: joins the message bus as the session's project folder and exposes the `message-bus` tool
// (ops and texts in packages/client/src/tool.ts). Messages for this agent arrive like composer input:
// idle → a turn starts; busy → `aside`: at the next step of the running turn, without cutting a tool
// batch short, and ending a running `wait` (an agent waiting inside its turn for a bus reply would
// otherwise never see it); quiet (@all from other agents, unless `set all wake`) → added to the
// conversation at the next turn without starting one.
// Only the main session joins; subagents share the folder but are not bus participants.
import * as os from "node:os";
import * as path from "node:path";
import { ActivityLog, contentText, contentThinking } from "../../client/src/activity";
import { BusConnection, type Delivery } from "../../client/src/connection";
import {
  BusTool,
  deliveryText,
  isUnderTempDir,
  TOOL_NAME,
  TOOL_PARAMS,
  toolDescription,
  type MessageBusToolParams,
  type ToolParam,
} from "../../client/src/tool";
import { deliveryHeaderSeqs } from "../../protocol/src/address";
import { DEFAULT_BUS_PORT, type AgentStatus, type ReceiptFrame } from "../../protocol/src/types";

export { TOOL_NAME, type MessageBusToolParams };

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

/** The tool's parameters as an omp (zod) schema. */
function zodParameters(z: ZodLike): ZodSchemaLike {
  const one = (param: ToolParam): ZodSchemaLike => {
    const base =
      param.enum !== undefined
        ? z.enum(param.enum as unknown as [string, ...string[]])
        : param.type === "number"
          ? z.number()
          : param.type === "string[]"
            ? z.array(z.string())
            : z.string();
    return (param.name === "op" ? base : base.optional()).describe(param.description);
  };
  return z.object(Object.fromEntries(TOOL_PARAMS.map((param) => [param.name, one(param)])));
}

export default function messageBus(pi: MessageBusApi): void {
  let connection: BusConnection | undefined;
  let tool: BusTool | undefined;
  let sessionCtx: MessageBusContext | undefined;

  const quietly = (content: string): void =>
    pi.sendMessage({ customType: TOOL_NAME, content, display: true, attribution: "agent" }, { deliverAs: "nextTurn" });

  const onReceipt = (receipt: ReceiptFrame): void => {
    const notice = tool?.receiptNotice(receipt);
    if (notice) quietly(notice);
  };

  /** Delivered seqs the model has not been given yet. */
  const unseen = new Set<number>();

  const deliver = async (delivery: Delivery): Promise<void> => {
    const conn = connection;
    if (!conn?.id) throw new Error("delivery before join");
    const text = await deliveryText(conn, delivery);
    unseen.add(delivery.message.seq);
    if (!delivery.wake) quietly(text);
    else if (sessionCtx?.isIdle() ?? true) pi.sendUserMessage(text, { attribution: "agent" });
    else pi.sendUserMessage(text, { deliverAs: "aside", attribution: "agent" });
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
    tool = new BusTool(conn);
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
    tool = undefined;
    sessionCtx = undefined;
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Message bus",
    description: toolDescription({
      arrives: "after your current tool call finishes, and they end a running `wait`",
      notJoining: "sessions started in the temp directory do not join",
    }),
    parameters: zodParameters(pi.zod),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!tool) {
        throw new Error("This session is not on the message bus: subagents and sessions started in the temp directory do not join.");
      }
      return { content: [{ type: "text", text: await tool.run(params, ctx.cwd) }] };
    },
  });
}
