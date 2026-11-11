// MCP over stdio (JSON-RPC 2.0, one message per line) for the plugins that serve the `message-bus` tool as an MCP
// server: Antigravity, Claude Code and Codex. Each plugin says which tools it lists and how a call runs. Runs on Node
// (the plugins are bundled for it): `node:*` only.
import { createInterface } from "node:readline";
import { TOOL_NAME } from "./tool";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export function textResult(text: string): McpToolResult {
  return { content: [{ type: "text", text }] };
}

export interface McpServerInfo {
  /** Default `{ tools: {} }`. */
  capabilities?: Record<string, unknown>;
  /** Shown to the model by harnesses that support server instructions. */
  instructions?: string;
  tools: McpTool[];
}

type RpcRequest = { id?: unknown; method?: string; params?: Record<string, unknown> };

/** Lines go to `write` (stdout, `writeStdout`, outside tests); incoming lines come in through `handleLine`. */
export abstract class McpToolServer {
  private resolveReady: () => void = () => {};
  // Not Promise.withResolvers: Node 20 lacks it, and nothing else in the Antigravity daemon needs a newer Node.
  private readonly initialized = new Promise<void>((resolve) => (this.resolveReady = resolve));

  constructor(
    private readonly write: (line: string) => void,
    private readonly info: McpServerInfo
  ) {}

  /** Resolves once the client has finished initializing the connection (`notifications/initialized`). */
  get ready(): Promise<void> {
    return this.initialized;
  }

  /** Handles one JSON-RPC line from the client. */
  handleLine(line: string): void {
    if (!line.trim()) return;
    let request: RpcRequest;
    try {
      request = JSON.parse(line) as RpcRequest;
    } catch {
      return;
    }
    // Valid JSON that is not a request object (`null`, `5`) is ignored like malformed input.
    if (typeof request !== "object" || request === null) return;
    if (request.method === "notifications/initialized") this.resolveReady();
    // Notifications (no id) need no answer.
    if (request.id === undefined || request.id === null) return;
    void this.handle(request).then(
      (result) => this.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result })),
      (err: Error & { code?: number }) =>
        this.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: err.code ?? -32603, message: err.message } }))
    );
  }

  /** Sends a notification to the client. */
  protected notify(method: string, params: Record<string, unknown>): void {
    this.write(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  /** Runs a call of one of the listed tools. A throw answers with its message as an error result, for the model. */
  protected abstract callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;

  private async handle(request: RpcRequest): Promise<unknown> {
    switch (request.method) {
      case "initialize":
        return {
          protocolVersion: typeof request.params?.protocolVersion === "string" ? request.params.protocolVersion : "2025-06-18",
          capabilities: this.info.capabilities ?? { tools: {} },
          serverInfo: { name: TOOL_NAME, version: "1.0.0" },
          instructions: this.info.instructions,
        };
      case "ping":
        return {};
      case "tools/list":
        return { tools: this.info.tools };
      case "tools/call": {
        const name = request.params?.name;
        if (!this.info.tools.some((tool) => tool.name === name)) {
          throw Object.assign(new Error(`Unknown tool ${String(name)}`), { code: -32602 });
        }
        try {
          return await this.callTool(name as string, (request.params?.arguments ?? {}) as Record<string, unknown>);
        } catch (err) {
          return { content: [{ type: "text", text: (err as Error).message }], isError: true };
        }
      }
      default:
        throw Object.assign(new Error(`Method not found: ${String(request.method)}`), { code: -32601 });
    }
  }
}

export function writeStdout(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Feeds stdin to `server` line by line; `onEnd` runs when the harness closes stdin (it stops the server or quits). */
export function serveStdio(server: McpToolServer, onEnd: () => void): void {
  const lines = createInterface({ input: process.stdin, terminal: false });
  lines.on("line", (line) => server.handleLine(line));
  lines.on("close", onEnd);
}
