// Installs the message-bus plugin into Antigravity (`agent-bus install antigravity`): builds the daemon and the hook
// into self-contained JS files and writes the plugin folder (~/.gemini/config/plugins/message-bus by default) with its
// manifest, hooks, MCP server and bus URL, then asks a running Antigravity to reload its MCP servers.
//
// The folder is a copy, not a link: it keeps working when this checkout moves or changes; install again to update.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  bundleForNode,
  configBusUrl,
  installBusUrl,
  jsRuntime,
  manifestName,
  removeOwnedDir,
  writeJson,
  writeMetadata,
  type InstallOptions,
  type InstallStatus,
} from "../../client/src/install";

const PLUGIN = "message-bus";
const root = path.resolve(import.meta.dir, "..");
const appData = path.join(os.homedir(), ".gemini", "antigravity");

const pluginFolder = (opts: InstallOptions): string =>
  path.resolve(opts.dir ?? path.join(os.homedir(), ".gemini", "config", "plugins", PLUGIN));

/** Removes an earlier install: a link (development installs) or a folder holding this plugin. Anything else stops. */
function removeOld(target: string): void {
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
  removeOwnedDir(target, path.join(target, "plugin.json"), PLUGIN, "plugin");
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

export async function install(opts: InstallOptions): Promise<void> {
  const target = pluginFolder(opts);
  const busUrl = installBusUrl(path.join(target, "config.json"), opts.url);
  const node = jsRuntime();

  removeOld(target);
  mkdirSync(target, { recursive: true });
  await bundleForNode(root, path.join(target, "dist"), [
    ["src/daemon-main.ts", "daemon"],
    ["src/hook.ts", "hook"],
  ]);
  const json = (name: string, value: unknown): void => writeJson(path.join(target, name), value);
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
  writeMetadata(target, "antigravity", "Antigravity plugin that puts this machine's Antigravity conversations on the message bus.");
  console.log(`Installed ${PLUGIN} in ${target} (bus ${busUrl}, runtime ${node}).`);
  if (opts.buildOnly) return;
  console.log(await refreshAntigravity().catch((err: Error) => `Could not reach Antigravity (${err.message}); restart it.`));
}

export async function uninstall(opts: InstallOptions): Promise<void> {
  const target = pluginFolder(opts);
  removeOld(target);
  console.log(`Removed ${target}.`);
  console.log(await refreshAntigravity().catch((err: Error) => `Could not reach Antigravity (${err.message}); restart it.`));
}

export function status(opts: InstallOptions): InstallStatus {
  const target = pluginFolder(opts);
  const installed = manifestName(path.join(target, "plugin.json")) === PLUGIN;
  return { installed, where: target, busUrl: configBusUrl(path.join(target, "config.json")), notes: [] };
}
