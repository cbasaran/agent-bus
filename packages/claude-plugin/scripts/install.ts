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
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PLUGIN = "message-bus";
const MARKETPLACE = "agent-bus";
const root = path.resolve(import.meta.dir, "..");
const version = (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string }).version;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const target = path.resolve(arg("dir") ?? path.join(os.homedir(), ".agent-bus", "claude-marketplace"));
const pluginDir = path.join(target, PLUGIN);

function claude(...args: string[]): { ok: boolean; out: string } {
  const res = spawnSync("claude", args, { encoding: "utf8" });
  if (res.error) throw new Error(`Could not run claude (${res.error.message}); is Claude Code installed?`);
  return { ok: res.status === 0, out: `${res.stdout ?? ""}${res.stderr ?? ""}`.trim() };
}

function must(...args: string[]): void {
  const res = claude(...args);
  if (!res.ok) throw new Error(`claude ${args.join(" ")} failed:\n${res.out}`);
}

/** The JS runtime Claude Code should start: node if installed (absolute path, any shell PATH), else bun. */
function runtime(): string {
  return Bun.which("node") ?? process.execPath;
}

async function build(outdir: string): Promise<void> {
  for (const [entry, name] of [
    ["src/server-main.ts", "server"],
    ["src/hook.ts", "hook"],
  ] as const) {
    const result = await Bun.build({ entrypoints: [path.join(root, entry)], outdir, target: "node", format: "esm", naming: `${name}.mjs` });
    if (!result.success) throw new AggregateError(result.logs, `Building ${entry} failed`);
  }
}

/** Removes an earlier copy of the marketplace (only one this script wrote). */
function removeOld(): void {
  if (!existsSync(target)) return;
  const manifest = path.join(target, ".claude-plugin", "marketplace.json");
  const name = existsSync(manifest) ? (JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }).name : undefined;
  if (name !== MARKETPLACE) throw new Error(`${target} exists and is not the ${MARKETPLACE} marketplace; not touching it.`);
  rmSync(target, { recursive: true });
}

async function install(): Promise<void> {
  const previous = path.join(pluginDir, "config.json");
  const oldUrl = existsSync(previous) ? (JSON.parse(readFileSync(previous, "utf8")) as { busUrl?: string }).busUrl : undefined;
  const busUrl = (arg("url") ?? process.env.AGENT_BUS_URL ?? oldUrl ?? "http://127.0.0.1:7800").replace(/\/+$/, "");
  const node = runtime();

  removeOld();
  mkdirSync(path.join(target, ".claude-plugin"), { recursive: true });
  mkdirSync(path.join(pluginDir, ".claude-plugin"), { recursive: true });
  mkdirSync(path.join(pluginDir, "hooks"), { recursive: true });
  await build(path.join(pluginDir, "dist"));
  const json = (file: string, value: unknown): void => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  const description = "Puts Claude Code sessions on the LAN message bus: messages from other agents and humans arrive in the session, and the message-bus tool answers them.";
  json(path.join(target, ".claude-plugin", "marketplace.json"), {
    name: MARKETPLACE,
    owner: { name: "message-bus" },
    plugins: [{ name: PLUGIN, source: `./${PLUGIN}`, description, version }],
  });
  json(path.join(pluginDir, ".claude-plugin", "plugin.json"), {
    name: PLUGIN,
    version,
    description,
    channels: [{ server: PLUGIN, displayName: "Message bus" }],
  });
  json(path.join(pluginDir, "config.json"), { busUrl });
  json(path.join(pluginDir, ".mcp.json"), {
    mcpServers: { [PLUGIN]: { command: node, args: ["${CLAUDE_PLUGIN_ROOT}/dist/server.mjs"] } },
  });
  // Exec form (command + args, no shell): the hook's parent is the `claude` process, which is how it finds the server.
  const hook = (event: string) => [{ type: "command", command: node, args: ["${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs", event], timeout: 5 }];
  json(path.join(pluginDir, "hooks", "hooks.json"), {
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
  const known = claude("plugin", "marketplace", "list");
  if (!known.out.includes(MARKETPLACE)) must("plugin", "marketplace", "add", target);
  else must("plugin", "marketplace", "update", MARKETPLACE);
  // Reinstall so the installed copy is this build.
  claude("plugin", "uninstall", `${PLUGIN}@${MARKETPLACE}`, "--keep-data");
  must("plugin", "install", `${PLUGIN}@${MARKETPLACE}`, "--scope", "user");
  console.log(`Installed ${PLUGIN}@${MARKETPLACE} from ${target} (bus ${busUrl}, runtime ${node}).`);
  console.log("New Claude Code sessions join the bus. To let bus messages start turns, start Claude Code with:");
  console.log(`  claude --dangerously-load-development-channels plugin:${PLUGIN}@${MARKETPLACE}`);
}

function uninstall(): void {
  claude("plugin", "uninstall", `${PLUGIN}@${MARKETPLACE}`);
  claude("plugin", "marketplace", "remove", MARKETPLACE);
  removeOld();
  console.log(`Removed ${PLUGIN}@${MARKETPLACE} and ${target}.`);
}

await (process.argv.includes("--uninstall") ? Promise.resolve(uninstall()) : install());
