// The plugin's daemon: Antigravity starts it as the plugin's MCP server, once for the whole app, and stops it when the
// app quits. It serves the `message-bus` tool over MCP (stdio), keeps one bus agent per workspace folder that has a
// main conversation (FolderAgent), and answers the plugin's hooks over a local socket, which is how it learns which
// conversation is active, busy or idle, and which conversation a tool call comes from.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { serveHookSocket, type HookSocket } from "../../client/src/hook-socket";
import { McpToolServer, serveStdio, textResult, writeStdout, type McpToolResult } from "../../client/src/mcp";
import { pluginBusUrl, pluginLog, realFolder } from "../../client/src/runtime";
import { isScratchFolder, TOOL_NAME, toolDescription, toolInputSchema, type MessageBusToolParams } from "../../client/src/tool";
import { AgentApi, appDataDir, daemonSocketPath, hookDefault } from "./antigravity";
import { FolderAgent } from "./folder-agent";

/** The hook payload fields used here (Antigravity sends more). */
export interface HookPayload {
  conversationId?: string;
  workspacePaths?: string[];
  transcriptPath?: string;
  toolCall?: { name?: string; args?: Record<string, unknown> };
  fullyIdle?: boolean;
}

export type HookEvent = "SessionStart" | "PreInvocation" | "PreToolUse" | "PostToolUse" | "Stop";

/** Key the PreToolUse hook adds to this tool's arguments: the calling conversation (MCP calls carry none). */
const CONVERSATION_ARG = "_conversation";

const log = pluginLog();

/** What the daemon knows about a conversation: its bus folder (if it joins) and whether it is a subagent's. */
interface ConversationInfo {
  folder: string | undefined;
  subagent: boolean;
}

/** Folders whose main conversation was active this recently are rejoined when the daemon starts. */
const REJOIN_WITHIN_MS = 7 * 24 * 3600_000;
/** A folder's "last active" time is saved at most this often while its conversation stays the same. */
const REMEMBER_EVERY_MS = 3600_000;

/** Saved per folder: its latest main conversation, so the folder is back on the bus after a restart. */
interface Remembered {
  conversationId: string;
  transcriptPath?: string;
  at: number;
}

export class Daemon {
  private readonly agents = new Map<string, FolderAgent>();
  private readonly conversations = new Map<string, Promise<ConversationInfo>>();
  private readonly agentApi = new AgentApi();
  private readonly remembered: Record<string, Remembered> = {};
  readonly url = pluginBusUrl(process.env.PLUGIN_ROOT);

  /**
   * `stateFile` keeps each folder's latest conversation: Antigravity runs no hook for a conversation until it does
   * something, so without it an idle conversation would be off the bus after every app (or daemon) restart.
   */
  constructor(private readonly stateFile?: string) {
    if (stateFile) this.restore(stateFile);
  }

  private restore(stateFile: string): void {
    let saved: Record<string, Remembered> = {};
    try {
      saved = JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, Remembered>;
    } catch {
      return;
    }
    for (const [folder, entry] of Object.entries(saved)) {
      if (Date.now() - entry.at > REJOIN_WITHIN_MS || !existsSync(folder)) continue;
      if (entry.transcriptPath && !existsSync(entry.transcriptPath)) continue; // conversation deleted
      this.remembered[folder] = entry;
      this.conversations.set(entry.conversationId, Promise.resolve({ folder, subagent: false }));
      this.newAgent(folder).activate(entry.conversationId, entry.transcriptPath);
    }
  }

  private newAgent(folder: string): FolderAgent {
    const agent = new FolderAgent({ folder, busUrl: this.url, agentApi: this.agentApi, log });
    this.agents.set(folder, agent);
    return agent;
  }

  /** Saves the folder's active conversation when it changes (and its last-active time, hourly). */
  private remember(agent: FolderAgent): void {
    if (!this.stateFile || !agent.conversationId) return;
    const before = this.remembered[agent.folder];
    if (before?.conversationId === agent.conversationId && Date.now() - before.at < REMEMBER_EVERY_MS) return;
    this.remembered[agent.folder] = { conversationId: agent.conversationId, transcriptPath: agent.transcript, at: Date.now() };
    try {
      mkdirSync(path.dirname(this.stateFile), { recursive: true });
      writeFileSync(this.stateFile, `${JSON.stringify(this.remembered, null, 2)}\n`);
    } catch (err) {
      log(`could not save ${this.stateFile}: ${(err as Error).message}`);
    }
  }

  /** Folder of a conversation's first workspace, unless it is in the temp directory. */
  private static folderOf(payload: HookPayload): string | undefined {
    const first = payload.workspacePaths?.[0];
    if (!first) return undefined;
    const folder = realFolder(first);
    return isScratchFolder(folder) ? undefined : folder;
  }

  private info(conversationId: string, payload: HookPayload): Promise<ConversationInfo> {
    let info = this.conversations.get(conversationId);
    if (!info) {
      info = this.agentApi
        .isSubagent(conversationId)
        .catch((err: Error) => {
          log(`${err.message}; treating ${conversationId} as a main conversation`);
          return false;
        })
        .then((subagent) => ({ folder: Daemon.folderOf(payload), subagent }));
      this.conversations.set(conversationId, info);
    }
    return info;
  }

  /** The folder agent of a main conversation that joins the bus, created on first use. */
  private async agentFor(conversationId: string, payload: HookPayload): Promise<FolderAgent | undefined> {
    const { folder, subagent } = await this.info(conversationId, payload);
    if (subagent || !folder) return undefined;
    return this.agents.get(folder) ?? this.newAgent(folder);
  }

  /** Answers one hook. Failures answer as if the plugin were absent (hooks must never block Antigravity). */
  async hook(event: HookEvent, payload: HookPayload): Promise<Record<string, unknown>> {
    const neutral = hookDefault(event);
    const conversationId = payload.conversationId;
    if (!conversationId) return neutral;
    const agent = await this.agentFor(conversationId, payload);
    switch (event) {
      case "SessionStart":
        if (agent) {
          agent.activate(conversationId, payload.transcriptPath);
          this.remember(agent);
        }
        return neutral;
      case "PreInvocation": {
        if (!agent) return neutral;
        agent.activate(conversationId, payload.transcriptPath);
        this.remember(agent);
        const text = agent.beforeModelCall(conversationId);
        // A userMessage: Antigravity (2.30) does not show the model a systemMessage returned here (tested 9 Nov).
        return text ? { injectSteps: [{ userMessage: text }] } : neutral;
      }
      case "PreToolUse": {
        const call = payload.toolCall;
        agent?.toolStarted(call?.name ?? "tool", call?.args?.toolSummary);
        if (call?.name !== "call_mcp_tool" || call.args?.ToolName !== TOOL_NAME) return neutral;
        let args = call.args.Arguments;
        if (typeof args === "string") {
          try {
            args = JSON.parse(args);
          } catch {
            return neutral;
          }
        }
        // Tell the tool call which conversation it comes from.
        return { decision: "allow", overwrite: { Arguments: { ...(args as object), [CONVERSATION_ARG]: conversationId } } };
      }
      case "PostToolUse":
        agent?.toolEnded();
        return neutral;
      case "Stop":
        agent?.stopped();
        return neutral;
    }
  }

  /** Runs a `message-bus` tool call; returns the result text, throws with a message for the model. */
  async callTool(args: Record<string, unknown>): Promise<string> {
    const { [CONVERSATION_ARG]: conversation, ...params } = args;
    let agent: FolderAgent | undefined;
    if (typeof conversation === "string") {
      const info = await this.conversations.get(conversation);
      if (info?.subagent) throw new Error("Subagents are not on the message bus; the main conversation is.");
      if (!info?.folder) {
        throw new Error(
          "This conversation is not on the message bus: only conversations with a workspace folder (outside the temp directory) join."
        );
      }
      agent = this.agents.get(info.folder);
    } else if (this.agents.size === 1) {
      // No PreToolUse hook ran (it is part of this plugin, so this should not happen); one folder is unambiguous.
      agent = [...this.agents.values()][0];
    } else {
      throw new Error("Cannot tell which conversation this call comes from (the plugin's PreToolUse hook did not run).");
    }
    if (!agent) throw new Error("This conversation is not on the message bus yet.");
    if (!agent.conn.id) throw new Error(`Not connected to the bus at ${this.url} yet (still trying).`);
    return agent.tool.run(params as unknown as MessageBusToolParams, agent.folder);
  }

  close(): void {
    for (const agent of this.agents.values()) agent.close();
    this.agents.clear();
  }
}

// ---- MCP over stdio ----

const DESCRIPTION = toolDescription({
  arrives: "after your current tool call finishes",
  notJoining: "conversations without a workspace folder, in the temp directory, and subagents do not join",
});

class DaemonMcpServer extends McpToolServer {
  constructor(private readonly daemon: Daemon) {
    super(writeStdout, { tools: [{ name: TOOL_NAME, description: DESCRIPTION, inputSchema: toolInputSchema() }] });
  }

  protected async callTool(_name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    return textResult(await this.daemon.callTool(args));
  }
}

/** Hooks over a local socket: POST {event, payload}; the answer is the hook's stdout. */
function serveHooks(daemon: Daemon, socketPath: string): HookSocket {
  return serveHookSocket(socketPath, async (body) => {
    let event = "";
    try {
      const parsed = JSON.parse(body) as { event: HookEvent; payload: HookPayload };
      event = parsed.event;
      return await daemon.hook(parsed.event, parsed.payload ?? {});
    } catch (err) {
      log(`hook ${event || "?"} failed: ${(err as Error).message}`);
      return hookDefault(event);
    }
  });
}

export function main(): void {
  const socketPath = daemonSocketPath(appDataDir());
  const daemon = new Daemon(path.join(path.dirname(socketPath), "agents.json"));
  const hooks = serveHooks(daemon, socketPath);
  let ended = false;
  const shutdown = (): void => {
    if (ended) return;
    ended = true;
    daemon.close();
    hooks.close();
    // Let the bus connections send their close frames.
    setTimeout(() => process.exit(0), 200);
  };
  // Antigravity closes our stdin when it stops the server or quits.
  serveStdio(new DaemonMcpServer(daemon), shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  log(`daemon started: bus ${daemon.url}, hooks on ${socketPath}`);
}
