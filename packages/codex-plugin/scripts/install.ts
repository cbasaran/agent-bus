// Installs the message-bus plugin into Codex (`agent-bus install codex`): builds the MCP server into a local Codex
// plugin marketplace (~/.agent-bus/codex-marketplace by default) and registers marketplace and plugin with the
// `codex` CLI. With `buildOnly`, it only writes the marketplace.
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
import { bindingFor, remember } from "../src/reopen";
import { HOOK_EVENTS, HOOK_TOOL } from "../src/session";

const PLUGIN = "message-bus";
const MARKETPLACE = "agent-bus";
const root = path.resolve(import.meta.dir, "..");
const codex = harnessCli("codex", "Codex");

const marketplaceRoot = (opts: InstallOptions): string =>
  path.resolve(opts.dir ?? path.join(os.homedir(), ".agent-bus", "codex-marketplace"));
const manifestOf = (target: string): string => path.join(target, ".agents", "plugins", "marketplace.json");

export interface CodexInstallOptions extends InstallOptions {
  /**
   * One-time migration for a chat that was already running before 1.5: its rollout file (absolute path). Run from
   * inside that chat (needs CODEX_THREAD_ID); never guesses the newest chat in a folder. Normal installs learn the
   * same binding from a root hook.
   */
  bindTranscript?: string;
}

export async function install(opts: CodexInstallOptions): Promise<void> {
  const target = marketplaceRoot(opts);
  const pluginDir = path.join(target, "plugins", PLUGIN);
  const busUrl = installBusUrl(path.join(pluginDir, "config.json"), opts.url);
  const node = jsRuntime();
  const version = (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string }).version;

  const seed = opts.bindTranscript === undefined ? undefined : bindingFor(process.cwd(), process.env.CODEX_THREAD_ID, opts.bindTranscript);
  if (opts.bindTranscript !== undefined) {
    if (!seed) throw new Error("The transcript must belong to this running Codex chat.");
    const first = (await Bun.file(seed.transcript).slice(0, 1024 * 1024).text()).split("\n")[0];
    const meta = JSON.parse(first || "null");
    if (meta?.type !== "session_meta" || meta.payload?.id !== seed.id || meta.payload?.cwd !== seed.folder) {
      throw new Error("The transcript metadata does not match this project and chat.");
    }
  }

  removeOwnedDir(target, manifestOf(target), MARKETPLACE, "marketplace");
  mkdirSync(path.join(pluginDir, ".codex-plugin"), { recursive: true });
  mkdirSync(path.join(pluginDir, "hooks"), { recursive: true });
  mkdirSync(path.dirname(manifestOf(target)), { recursive: true });
  await bundleForNode(root, path.join(pluginDir, "dist"), [["src/server-main.ts", "server"]]);
  const description = "Puts Codex tasks on the LAN message bus and exposes the message-bus tool.";
  writeJson(manifestOf(target), {
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
  writeMetadata(target, "codex", "local Codex plugin marketplace holding the message-bus plugin (tasks join the LAN message bus).");

  if (opts.buildOnly) {
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

export async function uninstall(opts: InstallOptions): Promise<void> {
  const target = marketplaceRoot(opts);
  if (codex.present) {
    codex.run("plugin", "remove", `${PLUGIN}@${MARKETPLACE}`);
    codex.run("plugin", "marketplace", "remove", MARKETPLACE);
  }
  removeOwnedDir(target, manifestOf(target), MARKETPLACE, "marketplace");
  console.log(`Removed ${PLUGIN}@${MARKETPLACE} and ${target}.`);
}

export function status(opts: InstallOptions): InstallStatus {
  const target = marketplaceRoot(opts);
  const notes: string[] = [];
  const installed = existsSync(target) && manifestName(manifestOf(target)) === MARKETPLACE;
  if (installed && codex.present) {
    const listed = codex.run("plugin", "list");
    if (listed.ok && !listed.out.includes(PLUGIN)) notes.push("built but not registered with Codex");
  }
  if (installed) notes.push("trust the plugin's hooks in Codex once, and allow its message-bus tool");
  return { installed, where: target, busUrl: configBusUrl(path.join(target, "plugins", PLUGIN, "config.json")), notes };
}
