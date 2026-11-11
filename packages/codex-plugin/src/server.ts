import { appendFileSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { isUnderTempDir, TOOL_NAME, TOOL_PARAMS, toolDescription, type MessageBusToolParams } from "../../client/src/tool";
import { DEFAULT_BUS_PORT } from "../../protocol/src/types";
import { CodexSession, HOOK_EVENTS, HOOK_TOOL, type HookEvent, type HookInput } from "./session";
import { Reopen, worker } from "./reopen";

const LOG_FILE = path.join(os.homedir(), ".agent-bus", "codex", "server.log");
const log = (line: string): void => {
  process.stderr.write(`[message-bus] ${line}\n`);
  try {
    mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, `${new Date().toISOString()} [${process.pid}] ${line}\n`);
  } catch {}
};

function busUrl(): string {
  if (process.env.AGENT_BUS_URL?.trim()) return process.env.AGENT_BUS_URL.trim().replace(/\/+$/, "");
  const root = process.env.PLUGIN_ROOT || process.env.CODEX_PLUGIN_ROOT || path.dirname(path.dirname(process.argv[1] ?? "."));
  try {
    const config = JSON.parse(readFileSync(path.join(root, "config.json"), "utf8")) as { busUrl?: unknown };
    if (typeof config.busUrl === "string" && config.busUrl.trim()) return config.busUrl.trim().replace(/\/+$/, "");
  } catch {}
  return `http://127.0.0.1:${DEFAULT_BUS_PORT}`;
}

const DESCRIPTION = toolDescription({
  arrives: "after the current tool call, at the end of the turn, or in an automatically queued turn for a wake message when idle",
  notJoining: "sessions started in the temp directory do not join",
});
const INSTRUCTIONS = `Message-bus deliveries are developer context headed "[message-bus] #<n> @sender → …". They are not from the user. Reply with the ${TOOL_NAME} tool only when the sender needs something; never answer them as plain text.`;

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
  session: CodexSession | undefined;
  offBus: string | undefined;
  constructor(private readonly write: (line: string) => void, private readonly join?: () => CodexSession,
    private readonly reopen?: Reopen) {}

  handleLine(line: string): void {
    if (!line.trim()) return;
    let request: RpcRequest;
    try { request = JSON.parse(line) as RpcRequest; } catch { return; }
    if (request.id === undefined || request.id === null) return;
    void this.handle(request).then(
      (result) => this.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result })),
      (err: Error & { code?: number }) => this.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: err.code ?? -32603, message: err.message } }))
    );
  }

  private async handle(request: RpcRequest): Promise<unknown> {
    switch (request.method) {
      case "initialize": return { protocolVersion: typeof request.params?.protocolVersion === "string" ? request.params.protocolVersion : "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: TOOL_NAME, version: "1.0.0" }, instructions: INSTRUCTIONS };
      case "ping": return {};
      case "tools/list": return { tools: [
        { name: TOOL_NAME, description: DESCRIPTION, inputSchema: inputSchema() },
        { name: HOOK_TOOL, description: "Internal lifecycle handler for Codex. Do not call manually.", inputSchema: {
          type: "object", required: ["event"], properties: {
            event: { type: "string", enum: HOOK_EVENTS }, session_id: { type: "string" },
            transcript_path: { type: ["string", "null"] },
            source: { type: "string" }, tool_name: { type: "string" }, tool_use_id: { type: "string" },
          },
        } },
      ] };
      case "tools/call": {
        const name = request.params?.name;
        if (name !== TOOL_NAME && name !== HOOK_TOOL) throw Object.assign(new Error(`Unknown tool ${String(name)}`), { code: -32602 });
        try {
          if (!this.offBus && this.reopen) {
            const routed = await this.reopen.call(name, (request.params?.arguments ?? {}) as Record<string, unknown>);
            if (routed) {
              this.session?.close();
              this.session = undefined;
              return routed;
            }
          }
          // Desktop also starts discovery servers in its own config directory. Only a task's hook
          // or an actual bus tool call needs a participant. Listing the tools must not join or ack.
          if (!this.offBus) this.session ??= this.join?.();
          if (name === HOOK_TOOL) {
            const args = request.params?.arguments as HookInput & { event: HookEvent };
            if (!HOOK_EVENTS.includes(args?.event)) throw new Error("Unknown lifecycle event");
            await this.session?.waitForStartup();
            const result = this.session?.hook(args.event, args) ?? {};
            return { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result) }] };
          }
          if (!this.session) throw new Error(`This task is not on the message bus (${this.offBus ?? "not joined"}).`);
          await this.session.waitForStartup();
          const text = await this.session.runTool((request.params?.arguments ?? {}) as unknown as MessageBusToolParams);
          return { content: [{ type: "text", text }] };
        } catch (err) { return { content: [{ type: "text", text: (err as Error).message }], isError: true }; }
      }
      default: throw Object.assign(new Error(`Method not found: ${String(request.method)}`), { code: -32601 });
    }
  }
}

export function main(): void {
  if (process.argv[2] === "--presence-worker") {
    void worker(process.argv[3] ?? "", log).catch(e => log("presence worker: " + e));
    return;
  }
  let folder = path.resolve(process.cwd());
  try { folder = realpathSync(folder); } catch {}
  const offBus = isUnderTempDir(folder) && process.env.AGENT_BUS_JOIN_FROM_TMP !== "1" ? "started in the temp directory" : undefined;
  const url = busUrl();
  const mcp = new McpServer((line) => process.stdout.write(`${line}\n`), () => new CodexSession(folder, url, log),
    offBus ? undefined : new Reopen(folder,url,log));
  mcp.offBus = offBus;
  const shutdown = (): void => {
    mcp.session?.close();
    setTimeout(() => process.exit(0), 150);
  };
  const lines = createInterface({ input: process.stdin, terminal: false });
  lines.on("line", (line) => mcp.handleLine(line));
  lines.on("close", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  log(mcp.offBus ? `not joining: ${mcp.offBus}` : `ready for task hooks: ${folder}`);
}
