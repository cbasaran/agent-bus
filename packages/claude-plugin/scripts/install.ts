// Installs the message-bus plugin into Claude Code (`agent-bus install claude`): builds the MCP server and the hook
// into self-contained JS files, writes a local plugin marketplace (~/.agent-bus/claude-marketplace by default) holding
// the plugin, and installs the plugin from it with the `claude` CLI (user scope). With `buildOnly`, it only writes the
// marketplace; try it with `claude --plugin-dir <dir>/message-bus`.
//
// The plugin is a copy, not a link: it keeps working when this checkout moves or changes; install again to update.
// Claude Code only delivers bus messages as channel events when started with the plugin's channel enabled:
//   claude --dangerously-load-development-channels plugin:message-bus@agent-bus
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  bundleForNode,
  configBusUrl,
  harnessCli,
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
const MARKETPLACE = "agent-bus";
const root = path.resolve(import.meta.dir, "..");
const claude = harnessCli("claude", "Claude Code");

const marketplaceDir = (opts: InstallOptions): string =>
  path.resolve(opts.dir ?? path.join(os.homedir(), ".agent-bus", "claude-marketplace"));
const manifestOf = (target: string): string => path.join(target, ".claude-plugin", "marketplace.json");

export async function install(opts: InstallOptions): Promise<void> {
  const target = marketplaceDir(opts);
  const pluginDir = path.join(target, PLUGIN);
  const busUrl = installBusUrl(path.join(pluginDir, "config.json"), opts.url);
  const node = jsRuntime();
  const version = (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string }).version;

  removeOwnedDir(target, manifestOf(target), MARKETPLACE, "marketplace");
  mkdirSync(path.join(target, ".claude-plugin"), { recursive: true });
  mkdirSync(path.join(pluginDir, ".claude-plugin"), { recursive: true });
  mkdirSync(path.join(pluginDir, "hooks"), { recursive: true });
  await bundleForNode(root, path.join(pluginDir, "dist"), [
    ["src/server-main.ts", "server"],
    ["src/hook.ts", "hook"],
  ]);
  const description =
    "Puts Claude Code sessions on the LAN message bus: messages from other agents and humans arrive in the session, and the message-bus tool answers them.";
  writeJson(manifestOf(target), {
    name: MARKETPLACE,
    owner: { name: "message-bus" },
    plugins: [{ name: PLUGIN, source: `./${PLUGIN}`, description, version }],
  });
  writeJson(path.join(pluginDir, ".claude-plugin", "plugin.json"), {
    name: PLUGIN,
    version,
    description,
    channels: [{ server: PLUGIN, displayName: "Message bus" }],
  });
  writeJson(path.join(pluginDir, "config.json"), { busUrl });
  writeJson(path.join(pluginDir, ".mcp.json"), {
    mcpServers: { [PLUGIN]: { command: node, args: ["${CLAUDE_PLUGIN_ROOT}/dist/server.mjs"] } },
  });
  // Exec form (command + args, no shell): the hook's parent is the `claude` process, which is how it finds the server.
  const hook = (event: string) => [{ type: "command", command: node, args: ["${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs", event], timeout: 5 }];
  writeJson(path.join(pluginDir, "hooks", "hooks.json"), {
    hooks: {
      SessionStart: [{ hooks: hook("SessionStart") }],
      UserPromptSubmit: [{ hooks: hook("UserPromptSubmit") }],
      PreToolUse: [{ matcher: "*", hooks: hook("PreToolUse") }],
      PostToolUse: [{ matcher: "*", hooks: hook("PostToolUse") }],
      Stop: [{ hooks: hook("Stop") }],
    },
  });
  writeMetadata(target, "claude", "local Claude Code plugin marketplace holding the message-bus plugin (sessions join the LAN message bus).");

  if (opts.buildOnly) {
    console.log(`Built ${pluginDir} (bus ${busUrl}, runtime ${node}); not installed.`);
    return;
  }
  const known = claude.run("plugin", "marketplace", "list");
  if (!known.out.includes(MARKETPLACE)) claude.must("plugin", "marketplace", "add", target);
  else claude.must("plugin", "marketplace", "update", MARKETPLACE);
  // Reinstall so the installed copy is this build.
  claude.run("plugin", "uninstall", `${PLUGIN}@${MARKETPLACE}`, "--keep-data");
  claude.must("plugin", "install", `${PLUGIN}@${MARKETPLACE}`, "--scope", "user");
  console.log(`Installed ${PLUGIN}@${MARKETPLACE} from ${target} (bus ${busUrl}, runtime ${node}).`);
  console.log("New Claude Code sessions join the bus. To let bus messages start turns, start Claude Code with:");
  console.log(`  claude --dangerously-load-development-channels plugin:${PLUGIN}@${MARKETPLACE}`);
}

export async function uninstall(opts: InstallOptions): Promise<void> {
  const target = marketplaceDir(opts);
  if (claude.present) {
    claude.run("plugin", "uninstall", `${PLUGIN}@${MARKETPLACE}`);
    claude.run("plugin", "marketplace", "remove", MARKETPLACE);
  }
  removeOwnedDir(target, manifestOf(target), MARKETPLACE, "marketplace");
  console.log(`Removed ${PLUGIN}@${MARKETPLACE} and ${target}.`);
}

export function status(opts: InstallOptions): InstallStatus {
  const target = marketplaceDir(opts);
  const notes: string[] = [];
  const installed = existsSync(target) && manifestName(manifestOf(target)) === MARKETPLACE;
  if (installed && claude.present) {
    const listed = claude.run("plugin", "list");
    if (listed.ok && !listed.out.includes(`${PLUGIN}@${MARKETPLACE}`)) notes.push("built but not installed in Claude Code");
  }
  if (installed) notes.push(`start sessions with: claude --dangerously-load-development-channels plugin:${PLUGIN}@${MARKETPLACE}`);
  return { installed, where: target, busUrl: configBusUrl(path.join(target, PLUGIN, "config.json")), notes };
}
