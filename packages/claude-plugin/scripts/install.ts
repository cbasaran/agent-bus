// Installs the message-bus plugin into Claude Code: builds the MCP server and the hook into self-contained JS files,
// writes a local plugin marketplace (~/.agent-bus/claude-marketplace by default) holding the plugin, and installs the
// plugin from it with the `claude` CLI (user scope).
//
//   bun run install:claude [--url http://bus-host:7800] [--dir <marketplace folder>] [--uninstall]
//   bun run install:claude --build-only --dir <folder>    (writes the marketplace only; try it with claude --plugin-dir <folder>/message-bus)
//
// The plugin is a copy, not a link: it keeps working when this checkout moves or changes; run this again to update.
// Claude Code only delivers bus messages as channel events when started with the plugin's channel enabled:
//   claude --dangerously-load-development-channels plugin:message-bus@agent-bus
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { arg, bundleForNode, harnessCli, installBusUrl, jsRuntime, removeOwnedDir, writeJson } from "../../client/src/install";

const PLUGIN = "message-bus";
const MARKETPLACE = "agent-bus";
const root = path.resolve(import.meta.dir, "..");
const version = (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string }).version;

const target = path.resolve(arg("dir") ?? path.join(os.homedir(), ".agent-bus", "claude-marketplace"));
const pluginDir = path.join(target, PLUGIN);
const claude = harnessCli("claude", "Claude Code");

/** Removes an earlier copy of the marketplace (only one this script wrote). */
function removeOld(): void {
  removeOwnedDir(target, path.join(target, ".claude-plugin", "marketplace.json"), MARKETPLACE, "marketplace");
}

async function install(): Promise<void> {
  const busUrl = installBusUrl(path.join(pluginDir, "config.json"));
  const node = jsRuntime();

  removeOld();
  mkdirSync(path.join(target, ".claude-plugin"), { recursive: true });
  mkdirSync(path.join(pluginDir, ".claude-plugin"), { recursive: true });
  mkdirSync(path.join(pluginDir, "hooks"), { recursive: true });
  await bundleForNode(root, path.join(pluginDir, "dist"), [
    ["src/server-main.ts", "server"],
    ["src/hook.ts", "hook"],
  ]);
  const description = "Puts Claude Code sessions on the LAN message bus: messages from other agents and humans arrive in the session, and the message-bus tool answers them.";
  writeJson(path.join(target, ".claude-plugin", "marketplace.json"), {
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
  writeFileSync(
    path.join(target, "METADATA"),
    `created by: message-bus (bun run install:claude in ${path.dirname(path.dirname(root))})\n` +
      `created: ${new Date().toISOString()}\n` +
      "reason: local Claude Code plugin marketplace holding the message-bus plugin (sessions join the LAN message bus).\n" +
      "delete: with bun run install:claude --uninstall.\n"
  );

  if (process.argv.includes("--build-only")) {
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

function uninstall(): void {
  claude.run("plugin", "uninstall", `${PLUGIN}@${MARKETPLACE}`);
  claude.run("plugin", "marketplace", "remove", MARKETPLACE);
  removeOld();
  console.log(`Removed ${PLUGIN}@${MARKETPLACE} and ${target}.`);
}

await (process.argv.includes("--uninstall") ? Promise.resolve(uninstall()) : install());
