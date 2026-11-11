// Builds and installs a local Codex plugin marketplace containing message-bus.
//   bun run install:codex [--url http://bus-host:7800] [--dir <marketplace root>] [--uninstall]
//   bun run install:codex --build-only --dir <folder>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { arg, bundleForNode, harnessCli, installBusUrl, jsRuntime, removeOwnedDir, writeJson } from "../../client/src/install";
import { bindingFor, remember, type Binding } from "../src/reopen";
import { HOOK_EVENTS, HOOK_TOOL } from "../src/session";

const PLUGIN = "message-bus";
const MARKETPLACE = "agent-bus";
const root = path.resolve(import.meta.dir, "..");
const version = (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string }).version;

const target = path.resolve(arg("dir") ?? path.join(os.homedir(), ".agent-bus", "codex-marketplace"));
const pluginDir = path.join(target, "plugins", PLUGIN);
const marketplaceFile = path.join(target, ".agents", "plugins", "marketplace.json");
const codex = harnessCli("codex", "Codex");

function removeOld(): void {
  removeOwnedDir(target, marketplaceFile, MARKETPLACE, "marketplace");
}

async function install(): Promise<void> {
  const busUrl = installBusUrl(path.join(pluginDir, "config.json"));
  const node = jsRuntime();
  if (process.argv.includes("--live-output")) {
    throw new Error("Live output is now enabled for every connected Codex chat. Remove --live-output and its UUID to install this version.");
  }
  // One-time migration for an already-running pre-1.5 chat. Never choose the newest
  // chat in a directory. Normal installs learn this same binding from a root hook.
  let seed: Binding | undefined;
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
  await bundleForNode(root, path.join(pluginDir, "dist"), [["src/server-main.ts", "server"]]);
  const description = "Puts Codex tasks on the LAN message bus and exposes the message-bus tool.";
  writeJson(marketplaceFile, {
    name: MARKETPLACE,
    interface: { displayName: "Agent Bus" },
    plugins: [
      {
        name: PLUGIN,
        source: { source: "local", path: `./plugins/${PLUGIN}` },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Developer Tools",
      },
    ],
  });
  writeJson(path.join(pluginDir, ".codex-plugin", "plugin.json"), {
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
  writeJson(path.join(pluginDir, "config.json"), { busUrl });
  writeJson(path.join(pluginDir, ".mcp.json"), {
    // Codex expands PLUGIN_ROOT for lifecycle hook commands, but not for stdio MCP arguments.
    // The local marketplace remains at `target`, so its absolute server path is stable across cache refreshes.
    mcpServers: {
      [PLUGIN]: {
        command: node,
        args: [path.join(pluginDir, "dist", "server.mjs")],
        env_vars: ["CODEX_HOME"], // Queue into the same Codex installation when it uses a custom state directory.
        env: { AGENT_BUS_CODEX_CLI: process.env.CODEX_APP_RUNTIME_CLI_PATH || Bun.which("codex") || "codex" },
      },
    },
  });
  writeJson(path.join(pluginDir, "hooks", "hooks.json"), {
    hooks: Object.fromEntries(
      HOOK_EVENTS.map((event) => {
        const input: Record<string, string> = { event, session_id: "${session_id}", transcript_path: "${transcript_path}" };
        if (event === "SessionStart") input.source = "${source}";
        if (event === "PreToolUse" || event === "PostToolUse") {
          input.tool_name = "${tool_name}";
          input.tool_use_id = "${tool_use_id}";
        }
        return [event, [{ hooks: [{ type: "mcp_tool", server: PLUGIN, tool: HOOK_TOOL, input, timeout: 5 }] }]];
      })
    ),
  });
  writeFileSync(
    path.join(target, "METADATA"),
    `created by: message-bus (bun run install:codex)\ncreated: ${new Date().toISOString()}\ndelete: bun run install:codex --uninstall\n`
  );

  if (process.argv.includes("--build-only")) {
    console.log(`Built ${pluginDir} (bus ${busUrl}, runtime ${node}); not installed.`);
    return;
  }
  // Local marketplaces cannot use `marketplace upgrade` (that command is Git-only). Re-register the
  // rebuilt local source so Codex does not keep serving the previous cached plugin/config.json.
  codex.run("plugin", "remove", `${PLUGIN}@${MARKETPLACE}`);
  const listed = codex.run("plugin", "marketplace", "list").out;
  if (listed.includes(MARKETPLACE)) codex.must("plugin", "marketplace", "remove", MARKETPLACE);
  codex.must("plugin", "marketplace", "add", target);
  codex.must("plugin", "add", `${PLUGIN}@${MARKETPLACE}`);
  if (seed) {
    remember(seed);
    console.log(`Saved the startup binding for this chat: ${seed.id}`);
  }
  console.log(`Installed ${PLUGIN}@${MARKETPLACE} from ${target} (bus ${busUrl}). Restart Codex and trust the plugin hooks when prompted.`);
}

function uninstall(): void {
  codex.run("plugin", "remove", `${PLUGIN}@${MARKETPLACE}`);
  codex.run("plugin", "marketplace", "remove", MARKETPLACE);
  removeOld();
  console.log(`Removed ${PLUGIN}@${MARKETPLACE} and ${target}.`);
}

await (process.argv.includes("--uninstall") ? Promise.resolve(uninstall()) : install());
