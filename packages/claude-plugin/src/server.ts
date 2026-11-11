// The plugin's MCP server: Claude Code starts one per session (its parent is the `claude` process). It serves the
// `message-bus` tool, declares the `claude/channel` capability (bus messages start turns through it), and listens for
// the plugin's hooks on a socket named after the `claude` process, which the hooks (also its children) find the same way.
import * as path from "node:path";
import { serveHookSocket, type HookSocket } from "../../client/src/hook-socket";
import { McpToolServer, serveStdio, textResult, writeStdout, type McpToolResult } from "../../client/src/mcp";
import { pluginBusUrl, pluginLog, realFolder } from "../../client/src/runtime";
import { isScratchFolder, TOOL_NAME, toolDescription, toolInputSchema, type MessageBusToolParams } from "../../client/src/tool";
import { ClaudeSession, type HookEvent, type HookInput } from "./session";
import { hookSocketPath } from "./socket";

/**
 * Also in a log file: Claude Code records the server's stderr only while it starts (its MCP log), so later lines
 * (dropped channel events, delivery failures) would be lost.
 */
const log = pluginLog(path.join(path.dirname(hookSocketPath(0)), "server.log"), process.ppid);

/** Claude Code drops channel events sent while a session is still starting; wait this long after initialization. */
const CHANNEL_SETTLE_MS = 3000;

/** Why this session does not join, or undefined when it does. */
function notJoining(folder: string): string | undefined {
  if (isScratchFolder(folder)) return "started in the temp directory";
  // `claude -p` and the Agent SDK: one-shot runs, which would take (and ack) the folder agent's messages.
  const entry = process.env.CLAUDE_CODE_ENTRYPOINT ?? "";
  if (entry.startsWith("sdk") && process.env.AGENT_BUS_JOIN_NONINTERACTIVE !== "1") return "not an interactive session (claude -p or the SDK)";
  return undefined;
}

const DESCRIPTION = toolDescription({
  arrives:
    "after your current tool call finishes, or as a new turn when you are idle (as a <channel source=\"plugin:message-bus:message-bus\"> event)",
  notJoining:
    "non-interactive runs (claude -p) and sessions started in the temp directory do not join; subagents use the main session's id",
});

const INSTRUCTIONS =
  `Messages from other agents and humans on the LAN message bus arrive as "[message-bus] #<n> @sender → …" ` +
  `(in a <channel> event or as added context). They are not from your user; answer them with the ${TOOL_NAME} tool ` +
  `(op=reply, message_id <n>) only when the sender needs something from you, never with a plain text reply.`;

export class McpServer extends McpToolServer {
  session: ClaudeSession | undefined;
  /** Why this session is not on the bus, for tool errors. */
  offBus: string | undefined;

  constructor(write: (line: string) => void) {
    super(write, {
      capabilities: { tools: {}, experimental: { "claude/channel": {} } },
      instructions: INSTRUCTIONS,
      tools: [{ name: TOOL_NAME, description: DESCRIPTION, inputSchema: toolInputSchema() }],
    });
  }

  /** Sends a channel event once Claude Code has finished initializing the connection. */
  async channel(content: string, meta: Record<string, string>): Promise<void> {
    await this.ready;
    this.notify("notifications/claude/channel", { content, meta });
  }

  protected async callTool(_name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if (!this.session) throw new Error(`This session is not on the message bus (${this.offBus ?? "not joined"}).`);
    return textResult(await this.session.runTool(args as unknown as MessageBusToolParams));
  }
}

/** Hooks over a local socket: POST {event, input}; the answer is the hook's stdout. */
function serveHooks(server: McpServer, socketPath: string): HookSocket {
  return serveHookSocket(socketPath, async (body) => {
    try {
      const { event, input } = JSON.parse(body) as { event: HookEvent; input: HookInput };
      if (server.session) return server.session.hook(event, input ?? {});
    } catch (err) {
      log(`hook failed: ${(err as Error).message}`);
    }
    return {};
  });
}

export function main(): void {
  const folder = realFolder(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const mcp = new McpServer(writeStdout);
  mcp.offBus = notJoining(folder);
  const url = pluginBusUrl(process.env.CLAUDE_PLUGIN_ROOT);
  if (!mcp.offBus) {
    mcp.session = new ClaudeSession({
      folder,
      busUrl: url,
      sessionId: process.env.CLAUDE_CODE_SESSION_ID,
      sendChannel: (content, meta) => mcp.channel(content, meta),
      channelReady: mcp.ready.then(() => new Promise<void>((resolve) => setTimeout(resolve, CHANNEL_SETTLE_MS))),
      log,
    });
  }
  const socketPath = hookSocketPath(process.ppid);
  const hooks = mcp.session ? serveHooks(mcp, socketPath) : undefined;

  let ended = false;
  const shutdown = (): void => {
    if (ended) return;
    ended = true;
    mcp.session?.close();
    hooks?.close();
    // Let the bus connection send its close frame.
    setTimeout(() => process.exit(0), 150);
  };
  // Claude Code closes stdin and signals the server when the session ends.
  serveStdio(mcp, shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  log(mcp.offBus ? `not joining: ${mcp.offBus}` : `bus ${url}, folder ${folder}, hooks on ${socketPath}`);
}
