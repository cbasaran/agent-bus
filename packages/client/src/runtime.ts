// Process-level helpers for the harness bindings: which bus to join, logging, the project folder. Runs on Node (the
// Antigravity, Claude Code and Codex plugins are bundled for it): `node:*` only.
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { DEFAULT_BUS_PORT } from "../../protocol/src/types";

const LOCAL_BUS_URL = `http://127.0.0.1:${DEFAULT_BUS_PORT}`;

/** Bus URL: AGENT_BUS_URL, else the local bus. */
export function envBusUrl(): string {
  return (process.env.AGENT_BUS_URL?.trim() || LOCAL_BUS_URL).replace(/\/+$/, "");
}

/**
 * Bus URL for a plugin: AGENT_BUS_URL, else `busUrl` in the plugin's config.json (written by its installer), else the
 * local bus. `pluginRoot` comes from the harness's environment; without it the root is the folder above the running
 * script (`dist/`).
 */
export function pluginBusUrl(pluginRoot: string | undefined): string {
  const fromEnv = process.env.AGENT_BUS_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  const root = pluginRoot || path.dirname(path.dirname(process.argv[1] ?? "."));
  try {
    const config = JSON.parse(readFileSync(path.join(root, "config.json"), "utf8")) as { busUrl?: unknown };
    if (typeof config.busUrl === "string" && config.busUrl.trim()) return config.busUrl.trim().replace(/\/+$/, "");
  } catch {
    // No config: local bus.
  }
  return LOCAL_BUS_URL;
}

/** A plugin's log: stderr, and with `file` also appended there, with the time and `pid`. */
export function pluginLog(file?: string, pid = process.pid): (line: string) => void {
  return (line) => {
    process.stderr.write(`[message-bus] ${line}\n`);
    if (!file) return;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      appendFileSync(file, `${new Date().toISOString()} [${pid}] ${line}\n`);
    } catch {
      // Logging must never break the plugin.
    }
  };
}

/** `dir` as an absolute path with symlinks resolved (as given when it cannot be resolved). */
export function realFolder(dir: string): string {
  const folder = path.resolve(dir);
  try {
    return realpathSync(folder);
  } catch {
    return folder;
  }
}
