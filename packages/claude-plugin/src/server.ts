// The plugin's MCP server: Claude Code starts one per session (its parent is the `claude` process). It serves the
// `message-bus` tool, declares the `claude/channel` capability (bus messages start turns through it), and listens for
// the plugin's hooks on a socket named after the `claude` process, which the hooks (also its children) find the same way.
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { isUnderTempDir, TOOL_NAME, TOOL_PARAMS, toolDescription, type MessageBusToolParams } from "../../client/src/tool";
import { DEFAULT_BUS_PORT } from "../../protocol/src/types";
import { ClaudeSession, type HookEvent, type HookInput } from "./session";
import { hookSocketPath } from "./socket";

/**
 * Also in a log file: Claude Code records the server's stderr only while it starts (its MCP log), so later lines
 * (dropped channel events, delivery failures) would be lost.
 */
const LOG_FILE = path.join(path.dirname(hookSocketPath(0)), "server.log");
const log = (line: string): void => {
  process.stderr.write(`[message-bus] ${line}\n`);
  try {
    mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, `${new Date().toISOString()} [${process.ppid}] ${line}\n`);
  } catch {
    // Logging must never break the server.
  }
};

/** Claude Code drops channel events sent while a session is still starting; wait this long after initialization. */
const CHANNEL_SETTLE_MS = 3000;

/** Bus URL: AGENT_BUS_URL, else `busUrl` in the plugin's config.json (written by the installer), else local. */
function busUrl(): string {
  const fromEnv = process.env.AGENT_BUS_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  const root = process.env.CLAUDE_PLUGIN_ROOT || path.dirname(path.dirname(process.argv[1] ?? "."));
  try {
    const config = JSON.parse(readFileSync(path.join(root, "config.json"), "utf8")) as { busUrl?: unknown };
    if (typeof config.busUrl === "string" && config.busUrl.trim()) return config.busUrl.trim().replace(/\/+$/, "");
  } catch {
    // No config: local bus.
  }
  return `http://127.0.0.1:${DEFAULT_BUS_PORT}`;
}

/** Why this session does not join, or undefined when it does. */
function notJoining(folder: string): string | undefined {
  if (isUnderTempDir(folder) && process.env.AGENT_BUS_JOIN_FROM_TMP !== "1") return "started in the temp directory";
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

function inputSchema(): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const param of TOOL_PARAMS) {
    const type = param.type === "string[]" ? { type: "array", items: { type: "string" } } : { type: param.type };
    properties[param.name] = { ...type, ...(param.enum ? { enum: param.enum } : {}), description: param.description };
  }
  return { type: "object", properties, required: ["op"] };
}

type RpcRequest = { id?: unknown; method?: string; params?: Record<string, unknown> };

export class McpServer {
  session: ClaudeSession | undefined;
  /** Why this session is not on the bus, for tool errors. */
  offBus: string | undefined;
  private initialized = Promise.withResolvers<void>();

  /** Resolves once Claude Code has finished initializing the connection. */
  get ready(): Promise<void> {
    return this.initialized.promise;
  }

  constructor(private readonly write: (line: string) => void) {}

  /** Sends a channel event once Claude Code has finished initializing the connection. */
  async channel(content: string, meta: Record<string, string>): Promise<void> {
    await this.initialized.promise;
    this.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/claude/channel", params: { content, meta } }));
  }

  /** Handles one JSON-RPC line from Claude Code. */
  handleLine(line: string): void {
    if (!line.trim()) return;
    let request: RpcRequest;
    try {
      request = JSON.parse(line) as RpcRequest;
    } catch {
      return;
    }
    if (request.method === "notifications/initialized") this.initialized.resolve();
    if (request.id === undefined || request.id === null) return;
    void this.handle(request).then(
      (result) => this.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result })),
      (err: Error & { code?: number }) =>
        this.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: err.code ?? -32603, message: err.message } }))
    );
  }

  private async handle(request: RpcRequest): Promise<unknown> {
    switch (request.method) {
      case "initialize":
        return {
          protocolVersion: typeof request.params?.protocolVersion === "string" ? request.params.protocolVersion : "2025-06-18",
          capabilities: { tools: {}, experimental: { "claude/channel": {} } },
          serverInfo: { name: TOOL_NAME, version: "1.0.0" },
          instructions: INSTRUCTIONS,
        };
      case "ping":
        return {};
      case "tools/list":
        return { tools: [{ name: TOOL_NAME, description: DESCRIPTION, inputSchema: inputSchema() }] };
      case "tools/call": {
        if (request.params?.name !== TOOL_NAME) throw Object.assign(new Error(`Unknown tool ${String(request.params?.name)}`), { code: -32602 });
        const args = (request.params.arguments ?? {}) as Record<string, unknown>;
        try {
          if (!this.session) throw new Error(`This session is not on the message bus (${this.offBus ?? "not joined"}).`);
          return { content: [{ type: "text", text: await this.session.runTool(args as unknown as MessageBusToolParams) }] };
        } catch (err) {
          return { content: [{ type: "text", text: (err as Error).message }], isError: true };
        }
      }
      default:
        throw Object.assign(new Error(`Method not found: ${String(request.method)}`), { code: -32601 });
    }
  }
}

/** Hooks over a local socket: POST {event, input}; the answer is the hook's stdout. */
export function serveHooks(server: McpServer, socketPath: string): ReturnType<typeof createServer> {
  mkdirSync(path.dirname(socketPath), { recursive: true });
  // Left by a server that did not shut down cleanly (pids are reused).
  if (existsSync(socketPath)) unlinkSync(socketPath);
  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let answer: Record<string, unknown> = {};
      try {
        const { event, input } = JSON.parse(body) as { event: HookEvent; input: HookInput };
        if (server.session) answer = server.session.hook(event, input ?? {});
      } catch (err) {
        log(`hook failed: ${(err as Error).message}`);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(answer));
    });
  });
  http.listen(socketPath);
  return http;
}

export function main(): void {
  let folder = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  try {
    folder = realpathSync(folder);
  } catch {
    // Keep the given path.
  }
  const mcp = new McpServer((line) => process.stdout.write(`${line}\n`));
  mcp.offBus = notJoining(folder);
  const url = busUrl();
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
    if (hooks) {
      hooks.close();
      try {
        unlinkSync(socketPath);
      } catch {
        // Already gone.
      }
    }
    // Let the bus connection send its close frame.
    setTimeout(() => process.exit(0), 150);
  };
  const lines = createInterface({ input: process.stdin, terminal: false });
  lines.on("line", (line) => mcp.handleLine(line));
  // Claude Code closes stdin and signals the server when the session ends.
  lines.on("close", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  log(mcp.offBus ? `not joining: ${mcp.offBus}` : `bus ${url}, folder ${folder}, hooks on ${socketPath}`);
}
