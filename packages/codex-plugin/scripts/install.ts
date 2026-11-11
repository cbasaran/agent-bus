// Builds and installs a local Codex plugin marketplace containing message-bus.
//   bun run install:codex [--url http://bus-host:7800] [--dir <marketplace root>] [--uninstall]
//   bun run install:codex --build-only --dir <folder>
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HOOK_EVENTS, HOOK_TOOL } from "../src/session";
import { bindingFor, remember } from "../src/reopen";

const PLUGIN = "message-bus";
const MARKETPLACE = "agent-bus";
const root = path.resolve(import.meta.dir, "..");
const version = (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string }).version;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const target = path.resolve(arg("dir") ?? path.join(os.homedir(), ".agent-bus", "codex-marketplace"));
const pluginDir = path.join(target, "plugins", PLUGIN);
const marketplaceFile = path.join(target, ".agents", "plugins", "marketplace.json");

function codex(...args: string[]): { ok: boolean; out: string } {
  const res = spawnSync("codex", args, { encoding: "utf8" });
  if (res.error) throw new Error(`Could not run codex (${res.error.message}); is Codex installed?`);
  return { ok: res.status === 0, out: `${res.stdout ?? ""}${res.stderr ?? ""}`.trim() };
}

function must(...args: string[]): void {
  const res = codex(...args);
  if (!res.ok) throw new Error(`codex ${args.join(" ")} failed:\n${res.out}`);
}

function runtime(): string { return Bun.which("node") ?? process.execPath; }

async function build(outdir: string): Promise<void> {
  const result = await Bun.build({ entrypoints: [path.join(root, "src/server-main.ts")], outdir, target: "node", format: "esm", naming: "server.mjs" });
  if (!result.success) throw new AggregateError(result.logs, "Building the Codex MCP server failed");
}

function removeOld(): void {
  if (!existsSync(target)) return;
  const name = existsSync(marketplaceFile)
    ? (JSON.parse(readFileSync(marketplaceFile, "utf8")) as { name?: string }).name
    : undefined;
  if (name !== MARKETPLACE) throw new Error(`${target} exists and is not the ${MARKETPLACE} marketplace; not touching it.`);
  rmSync(target, { recursive: true });
}

async function install(): Promise<void> {
  const oldConfig = path.join(pluginDir, "config.json");
  const oldUrl = existsSync(oldConfig) ? (JSON.parse(readFileSync(oldConfig, "utf8")) as { busUrl?: string }).busUrl : undefined;
  const busUrl = (arg("url") ?? process.env.AGENT_BUS_URL ?? oldUrl ?? "http://127.0.0.1:7800").replace(/\/+$/, "");
  const node = runtime();
  if (process.argv.includes("--live-output")) {
    throw new Error("Live output is now enabled for every connected Codex chat. Remove --live-output and its UUID to install this version.");
  }
  // One-time migration for an already-running pre-1.5 chat. Never choose the newest
  // chat in a directory. Normal installs learn this same binding from a root hook.
  let seed;
  if (process.argv.includes("--bind-current-transcript")) {
    seed = bindingFor(process.cwd(), process.env.CODEX_THREAD_ID, arg("bind-current-transcript"));
    if (!seed) throw new Error("The transcript must belong to this running Codex chat.");
    const first = (await Bun.file(seed.transcript).slice(0, 1024 * 1024).text()).split("\n")[0];
    const meta = JSON.parse(first || "null");
    if (meta?.type !== "session_meta" || meta.payload?.id !== seed.id || meta.payload?.cwd !== seed.folder) {
      throw new Error("The transcript metadata does not match this project and chat.");
    }
  }
  removeOld();
  mkdirSync(path.join(pluginDir, ".codex-plugin"), { recursive: true });
  mkdirSync(path.join(pluginDir, "hooks"), { recursive: true });
  mkdirSync(path.dirname(marketplaceFile), { recursive: true });
  await build(path.join(pluginDir, "dist"));
  const json = (file: string, value: unknown): void => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  const description = "Puts Codex tasks on the LAN message bus and exposes the message-bus tool.";
  json(marketplaceFile, {
    name: MARKETPLACE,
    interface: { displayName: "Agent Bus" },
    plugins: [{
      name: PLUGIN,
      source: { source: "local", path: `./plugins/${PLUGIN}` },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Developer Tools",
    }],
  });
  json(path.join(pluginDir, ".codex-plugin", "plugin.json"), {
    name: PLUGIN,
    version,
    description,
    author: { name: "message-bus" },
    interface: {
      displayName: "Message Bus",
      shortDescription: "Send and receive LAN agent messages.",
      longDescription: description,
      developerName: "message-bus",
      category: "Developer Tools",
      capabilities: ["Read", "Write"],
      defaultPrompt: "Check my message-bus inbox.",
    },
    mcpServers: "./.mcp.json",
  });
  json(path.join(pluginDir, "config.json"), { busUrl });
  json(path.join(pluginDir, ".mcp.json"), {
    // Codex expands PLUGIN_ROOT for lifecycle hook commands, but not for stdio MCP arguments.
    // The local marketplace remains at `target`, so its absolute server path is stable across cache refreshes.
    mcpServers: { [PLUGIN]: { command: node, args: [path.join(pluginDir, "dist", "server.mjs")],
      env_vars: ["CODEX_HOME"], // Queue into the same Codex installation when it uses a custom state directory.
      env: { AGENT_BUS_CODEX_CLI: process.env.CODEX_APP_RUNTIME_CLI_PATH || Bun.which("codex") || "codex" } } },
  });
  json(path.join(pluginDir, "hooks", "hooks.json"), {
    hooks: Object.fromEntries(HOOK_EVENTS.map((event) => {
      const input: Record<string, string> = { event, session_id: "${session_id}", transcript_path: "${transcript_path}" };
      if (event === "SessionStart") input.source = "${source}";
      if (event === "PreToolUse" || event === "PostToolUse") {
        input.tool_name = "${tool_name}";
        input.tool_use_id = "${tool_use_id}";
      }
      return [event, [{ hooks: [{ type: "mcp_tool", server: PLUGIN, tool: HOOK_TOOL, input, timeout: 5 }] }]];
    })),
  });
  writeFileSync(path.join(target, "METADATA"), `created by: message-bus (bun run install:codex)\ncreated: ${new Date().toISOString()}\ndelete: bun run install:codex --uninstall\n`);

  if (process.argv.includes("--build-only")) {
    console.log(`Built ${pluginDir} (bus ${busUrl}, runtime ${node}); not installed.`);
    return;
  }
  // Local marketplaces cannot use `marketplace upgrade` (that command is Git-only). Re-register the
  // rebuilt local source so Codex does not keep serving the previous cached plugin/config.json.
  codex("plugin", "remove", `${PLUGIN}@${MARKETPLACE}`);
  const listed = codex("plugin", "marketplace", "list").out;
  if (listed.includes(MARKETPLACE)) must("plugin", "marketplace", "remove", MARKETPLACE);
  must("plugin", "marketplace", "add", target);
  must("plugin", "add", `${PLUGIN}@${MARKETPLACE}`);
  if (seed) { remember(seed); console.log(`Saved the startup binding for this chat: ${seed.id}`); }
  console.log(`Installed ${PLUGIN}@${MARKETPLACE} from ${target} (bus ${busUrl}). Restart Codex and trust the plugin hooks when prompted.`);
}

function uninstall(): void {
  codex("plugin", "remove", `${PLUGIN}@${MARKETPLACE}`);
  codex("plugin", "marketplace", "remove", MARKETPLACE);
  removeOld();
  console.log(`Removed ${PLUGIN}@${MARKETPLACE} and ${target}.`);
}

await (process.argv.includes("--uninstall") ? Promise.resolve(uninstall()) : install());
