// pi extension (earendil-works pi-coding-agent): joins the message bus as the session's project folder and exposes
// the `message-bus` tool (ops and texts in packages/client/src/tool.ts). The same model as the omp extension, bound
// to pi's API:
// - wake → a custom message (`pi.sendMessage`, `deliverAs: "steer"`, `triggerTurn`): idle → a turn starts; busy →
//   it joins the running run after the current tool calls, before the next model request (omp's `aside`). A custom
//   message, not `sendUserMessage`: it skips input hooks and templates, and steering never throws while pi compacts
//   inside a run (a user prompt does).
// - quiet (@all from other agents, unless `set all wake`) and receipt notices → `deliverAs: "nextTurn"`.
// - busy/idle: `agent_start` / `agent_settled` (`agent_end` is not final in pi: retries, compaction, queued messages).
// pi has no subagents of its own; non-interactive runs (`pi -p`, `--mode json`, which subagent extensions spawn) do
// not join, so they cannot take the folder agent's messages.
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
} from "../../client/src/tool";
import { deliveryHeaderSeqs } from "../../protocol/src/address";
import { DEFAULT_BUS_PORT, type AgentStatus, type ReceiptFrame } from "../../protocol/src/types";

export { TOOL_NAME, type MessageBusToolParams };

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

/** The slice of pi's `ExtensionContext` used here (typed locally: the checkout does not depend on pi's packages). */
export interface MessageBusContext {
  cwd: string;
  /** "tui" | "rpc" | "json" | "print". */
  mode?: string;
  ui?: { notify(message: string, level: "info" | "warning" | "error"): void };
}

interface PiMessage {
  role?: string;
  customType?: string;
  content?: unknown;
  timestamp?: number;
}

/** The slice of pi's `ExtensionAPI` used here. */
export interface MessageBusApi {
  on(event: "session_start", handler: (event: unknown, ctx: MessageBusContext) => void): void;
  on(event: "session_shutdown", handler: () => void): void;
  /** Runs before every model request with the messages the model will get. */
  on(event: "context", handler: (event: { messages: unknown[] }) => void): void;
  on(event: "agent_start" | "agent_settled", handler: () => void): void;
  on(event: "tool_execution_start", handler: (event: { toolCallId: string; toolName: string; args?: unknown }) => void): void;
  on(event: "tool_execution_update", handler: (event: { toolCallId: string; partialResult?: { content?: unknown } }) => void): void;
  on(
    event: "tool_execution_end",
    handler: (event: { toolCallId: string; result?: { content?: unknown }; isError?: boolean }) => void
  ): void;
  on(event: "message_start" | "message_update" | "message_end", handler: (event: { message?: PiMessage }) => void): void;
  registerTool(definition: {
    name: string;
    label: string;
    description: string;
    parameters: Record<string, unknown>;
    execute(
      toolCallId: string,
      params: MessageBusToolParams,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: MessageBusContext
    ): Promise<ToolResult>;
  }): void;
  sendMessage(
    message: { customType: string; content: string; display: boolean },
    options: { deliverAs: "steer" | "nextTurn"; triggerTurn?: boolean }
  ): void;
}

/** How long a new session may take to join before the user is told it is not on the bus. */
const JOIN_NOTICE_MS = 8000;
/** Status reports are coalesced into one per this window (a batch of tool calls sends one report). */
const STATUS_COALESCE_MS = 250;

/** The tool's parameters as JSON Schema (pi validates tool arguments as JSON Schema, TypeBox or not). */
function jsonParameters(): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const param of TOOL_PARAMS) {
    const type = param.type === "string[]" ? { type: "array", items: { type: "string" } } : { type: param.type };
    properties[param.name] = { ...type, ...(param.enum ? { enum: [...param.enum] } : {}), description: param.description };
  }
  return { type: "object", properties, required: ["op"] };
}

/** Why a session does not join, or undefined when it does. */
function notJoining(ctx: MessageBusContext, projectPath: string): string | undefined {
  // Scratch sessions in the temp directory are not project agents (set AGENT_BUS_JOIN_FROM_TMP=1 to test there).
  if (isUnderTempDir(projectPath) && process.env.AGENT_BUS_JOIN_FROM_TMP !== "1") return "session started in the temp directory";
  // `pi -p` / `--mode json` runs (scripts, subagents) would take the folder agent's messages.
  if ((ctx.mode === "print" || ctx.mode === "json") && process.env.AGENT_BUS_JOIN_NONINTERACTIVE !== "1") {
    return `non-interactive run (--mode ${ctx.mode})`;
  }
  return undefined;
}

export default function messageBus(pi: MessageBusApi): void {
  let connection: BusConnection | undefined;
  let tool: BusTool | undefined;
  let offBus = "this session has not started";

  const quietly = (content: string): void =>
    pi.sendMessage({ customType: TOOL_NAME, content, display: true }, { deliverAs: "nextTurn" });

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
    else pi.sendMessage({ customType: TOOL_NAME, content: text, display: true }, { deliverAs: "steer", triggerTurn: true });
  };

  // A delivery is "seen" once its header is in what goes to the model.
  pi.on("context", (event) => {
    const conn = connection;
    if (!conn || unseen.size === 0) return;
    for (const seq of deliveryHeaderSeqs(JSON.stringify(event.messages))) {
      if (unseen.delete(seq)) conn.markSeen(seq);
    }
  });

  pi.on("session_start", (_event, ctx) => {
    if (connection) return;
    const projectPath = path.resolve(ctx.cwd);
    const reason = notJoining(ctx, projectPath);
    if (reason) {
      offBus = reason;
      if (ctx.mode === "tui" || ctx.mode === "rpc") ctx.ui?.notify(`message-bus: not joining (${reason})`, "info");
      return;
    }
    const url = (process.env.AGENT_BUS_URL?.trim() || `http://127.0.0.1:${DEFAULT_BUS_PORT}`).replace(/\/+$/, "");
    let announced = false;
    const conn = new BusConnection({
      url,
      host: os.hostname(),
      harness: "pi",
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
    const notice = setTimeout(() => {
      if (connection !== conn || conn.connected) return;
      ctx.ui?.notify(
        `message-bus: cannot reach the bus at ${url} (still retrying). Check AGENT_BUS_URL and the network.`,
        "warning"
      );
    }, JOIN_NOTICE_MS);
    notice.unref?.();
  });

  // ---- Status for the bus (website, GET /api/state): idle/busy and the running tool. No model turns. ----
  let busy = false;
  let since = Date.now();
  const runningTools = new Map<string, { name: string; since: number }>();
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
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
  // `agent_end` may be followed by a retry, a compaction retry or a queued message; `agent_settled` is final.
  pi.on("agent_settled", () => {
    busy = false;
    since = Date.now();
    runningTools.clear();
    statusChanged();
  });
  pi.on("tool_execution_start", (event) => {
    runningTools.set(event.toolCallId, { name: event.toolName, since: Date.now() });
    statusChanged();
    if (connection) activityLog.toolStart(event.toolCallId, event.toolName, event.args, undefined);
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
  const onMessage = (done: boolean) => (event: { message?: PiMessage }) => {
    const message = event.message;
    if (!connection || !message) return;
    const at = typeof message.timestamp === "number" ? message.timestamp : Date.now();
    if (message.role === "assistant") {
      activityLog.assistant(at, contentText(message.content), contentThinking(message.content), done);
    }
    // Typed prompts, and bus deliveries (custom messages of this extension) as they reach the session.
    else if (!done && (message.role === "user" || (message.role === "custom" && message.customType === TOOL_NAME))) {
      activityLog.user(at, contentText(message.content));
    }
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
    unseen.clear();
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Message bus",
    description: toolDescription({
      arrives: "after your current tool calls finish, before your next step",
      notJoining: "sessions started in the temp directory and non-interactive runs (pi -p, --mode json) do not join",
    }),
    parameters: jsonParameters(),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!tool) throw new Error(`This session is not on the message bus: ${offBus}.`);
      return { content: [{ type: "text", text: await tool.run(params, ctx.cwd) }], details: {} };
    },
  });
}
