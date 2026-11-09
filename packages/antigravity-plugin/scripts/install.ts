// Installs the message-bus plugin into Antigravity: builds the daemon and the hook into self-contained JS files and
// writes the plugin folder (~/.gemini/config/plugins/message-bus by default) with its manifest, hooks, MCP server and
// bus URL, then asks a running Antigravity to reload its MCP servers.
//
//   bun run install:antigravity [--url http://bus-host:7800] [--dir <plugin folder>] [--uninstall]
//
// The folder is a copy, not a link: it keeps working when this checkout moves or changes; run this again to update.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PLUGIN = "message-bus";
const root = path.resolve(import.meta.dir, "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const target = path.resolve(arg("dir") ?? path.join(os.homedir(), ".gemini", "config", "plugins", PLUGIN));
const appData = path.join(os.homedir(), ".gemini", "antigravity");

/** Removes an earlier install: a link (development installs) or a folder holding this plugin. Anything else stops. */
function removeOld(): void {
  let stat;
  try {
    stat = lstatSync(target);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) {
    unlinkSync(target);
    return;
  }
  const manifest = path.join(target, "plugin.json");
  const name = existsSync(manifest) ? (JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }).name : undefined;
  if (name !== PLUGIN) throw new Error(`${target} exists and is not the ${PLUGIN} plugin; not touching it.`);
  rmSync(target, { recursive: true });
}

/** The JS runtime Antigravity should start: node if installed (its GUI PATH may lack it, so the absolute path), else bun. */
function runtime(): string {
  return Bun.which("node") ?? process.execPath;
}

async function build(outdir: string): Promise<void> {
  for (const [entry, name] of [
    ["src/daemon-main.ts", "daemon"],
    ["src/hook.ts", "hook"],
  ] as const) {
    const result = await Bun.build({
      entrypoints: [path.join(root, entry)],
      outdir,
      target: "node",
      format: "esm",
      naming: `${name}.mjs`,
    });
    if (!result.success) throw new AggregateError(result.logs, `Building ${entry} failed`);
  }
}

/** Asks the running Antigravity (if any) to restart its MCP servers, so the new daemon replaces the old one. */
async function refreshAntigravity(): Promise<string> {
  const dir = path.join(appData, "daemon");
  const hubs = existsSync(dir) ? readdirSync(dir).filter((f) => /^hub_\d+\.json$/.test(f)) : [];
  for (const file of hubs) {
    const hub = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as { pid: number; httpPort: number; csrfToken: string };
    try {
      process.kill(hub.pid, 0);
    } catch {
      continue;
    }
    const res = await fetch(`http://127.0.0.1:${hub.httpPort}/exa.language_server_pb.LanguageServerService/RefreshMcpServers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-codeium-csrf-token": hub.csrfToken },
      body: "{}",
    });
    return res.ok ? "Antigravity reloaded its MCP servers." : `Antigravity did not reload (HTTP ${res.status}); restart it.`;
  }
  return "Antigravity is not running; it loads the plugin when it starts.";
}

async function install(): Promise<void> {
  const previous = path.join(target, "config.json");
  const oldUrl = existsSync(previous) ? (JSON.parse(readFileSync(previous, "utf8")) as { busUrl?: string }).busUrl : undefined;
  const busUrl = (arg("url") ?? process.env.AGENT_BUS_URL ?? oldUrl ?? "http://127.0.0.1:7800").replace(/\/+$/, "");
  const node = runtime();

  removeOld();
  mkdirSync(target, { recursive: true });
  await build(path.join(target, "dist"));
  const json = (name: string, value: unknown): void => writeFileSync(path.join(target, name), `${JSON.stringify(value, null, 2)}\n`);
  json("plugin.json", JSON.parse(readFileSync(path.join(root, "plugin.json"), "utf8")));
  json("config.json", { busUrl });
  json("mcp_config.json", {
    mcpServers: { [PLUGIN]: { command: node, args: ["${PLUGIN_ROOT}/dist/daemon.mjs"] } },
  });
  const hook = (event: string) => [{ type: "command", command: `"${node}" ./dist/hook.mjs ${event}`, timeout: 5 }];
  json("hooks.json", {
    [PLUGIN]: {
      SessionStart: hook("SessionStart"),
      PreInvocation: hook("PreInvocation"),
      PreToolUse: [{ matcher: "", hooks: hook("PreToolUse") }],
      PostToolUse: [{ matcher: "", hooks: hook("PostToolUse") }],
      Stop: hook("Stop"),
    },
  });
  writeFileSync(
    path.join(target, "METADATA"),
    `created by: message-bus (bun run install:antigravity in ${path.dirname(path.dirname(root))})\n` +
      `created: ${new Date().toISOString()}\n` +
      "reason: Antigravity plugin that puts this machine's Antigravity conversations on the message bus.\n" +
      "delete: with bun run install:antigravity --uninstall, or delete this folder; Antigravity then leaves the bus.\n"
  );
  console.log(`Installed ${PLUGIN} in ${target} (bus ${busUrl}, runtime ${node}).`);
  console.log(await refreshAntigravity().catch((err: Error) => `Could not reach Antigravity (${err.message}); restart it.`));
}

async function uninstall(): Promise<void> {
  removeOld();
  console.log(`Removed ${target}.`);
  console.log(await refreshAntigravity().catch((err: Error) => `Could not reach Antigravity (${err.message}); restart it.`));
}

await (process.argv.includes("--uninstall") ? uninstall() : install());
