// The plugin's MCP server: Codex starts one per task (and more for tool discovery). It serves the `message-bus` tool
// and the hook tool the plugin's lifecycle hooks call; the task joins the bus on its first hook or bus tool call. On
// macOS a reopened chat's calls go to its presence worker (reopen.ts) instead.
import * as os from "node:os";
import * as path from "node:path";
import { McpToolServer, serveStdio, textResult, writeStdout, type McpTool, type McpToolResult } from "../../client/src/mcp";
import { pluginBusUrl, pluginLog, realFolder } from "../../client/src/runtime";
import { isScratchFolder, TOOL_NAME, toolDescription, toolInputSchema, type MessageBusToolParams } from "../../client/src/tool";
import { Reopen, worker } from "./reopen";
import { CodexSession, HOOK_EVENTS, HOOK_TOOL, type HookEvent, type HookInput } from "./session";

const log = pluginLog(path.join(os.homedir(), ".agent-bus", "codex", "server.log"));

const DESCRIPTION = toolDescription({
  arrives: "after the current tool call, at the end of the turn, or in an automatically queued turn for a wake message when idle",
  notJoining: "sessions started in the temp directory do not join",
});

const INSTRUCTIONS =
  `Message-bus deliveries are developer context headed "[message-bus] #<n> @sender → …". They are not from the user. ` +
  `Reply with the ${TOOL_NAME} tool only when the sender needs something; never answer them as plain text.`;

const TOOLS: McpTool[] = [
  { name: TOOL_NAME, description: DESCRIPTION, inputSchema: toolInputSchema() },
  {
    name: HOOK_TOOL,
    description: "Internal lifecycle handler for Codex. Do not call manually.",
    inputSchema: {
      type: "object",
      required: ["event"],
      properties: {
        event: { type: "string", enum: HOOK_EVENTS },
        session_id: { type: "string" },
        transcript_path: { type: ["string", "null"] },
        source: { type: "string" },
        tool_name: { type: "string" },
        tool_use_id: { type: "string" },
      },
    },
  },
];

export class McpServer extends McpToolServer {
  session: CodexSession | undefined;
  /** Why this task is not on the bus, for tool errors. */
  offBus: string | undefined;

  constructor(
    write: (line: string) => void,
    private readonly join?: () => CodexSession,
    private readonly reopen?: Reopen
  ) {
    super(write, { instructions: INSTRUCTIONS, tools: TOOLS });
  }

  protected async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if (!this.offBus && this.reopen) {
      const routed = await this.reopen.call(name, args);
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
      const input = args as unknown as HookInput & { event: HookEvent };
      if (!HOOK_EVENTS.includes(input.event)) throw new Error("Unknown lifecycle event");
      await this.session?.waitForStartup();
      const result = this.session?.hook(input.event, input) ?? {};
      return { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result) }] };
    }
    if (!this.session) throw new Error(`This task is not on the message bus (${this.offBus ?? "not joined"}).`);
    await this.session.waitForStartup();
    return textResult(await this.session.runTool(args as unknown as MessageBusToolParams));
  }
}

export function main(): void {
  if (process.argv[2] === "--presence-worker") {
    void worker(process.argv[3] ?? "", log).catch((err) => log(`presence worker: ${err}`));
    return;
  }
  const folder = realFolder(process.cwd());
  const offBus = isScratchFolder(folder) ? "started in the temp directory" : undefined;
  const url = pluginBusUrl(process.env.PLUGIN_ROOT || process.env.CODEX_PLUGIN_ROOT);
  const mcp = new McpServer(
    writeStdout,
    () => new CodexSession(folder, url, log),
    offBus ? undefined : new Reopen(folder, url, log)
  );
  mcp.offBus = offBus;
  const shutdown = (): void => {
    mcp.session?.close();
    setTimeout(() => process.exit(0), 150);
  };
  serveStdio(mcp, shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  log(mcp.offBus ? `not joining: ${mcp.offBus}` : `ready for task hooks: ${folder}`);
}
