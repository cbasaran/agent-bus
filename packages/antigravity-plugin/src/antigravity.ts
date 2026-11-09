// What the plugin needs from Antigravity itself: where its data lives, the running language server ("hub") and its
// `agentapi` (send a message into a conversation; a conversation's metadata).
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** The app's data directory (`~/.gemini/antigravity`, `…/antigravity-ide`, `…/antigravity-cli`). */
export function appDataDir(): string {
  // Antigravity exports PLUGIN_DATA (`<app data>/plugin_data/<plugin>`) to plugin MCP servers.
  const pluginData = process.env.PLUGIN_DATA;
  return pluginData ? path.dirname(path.dirname(pluginData)) : path.join(os.homedir(), ".gemini", "antigravity");
}

/** Where the plugin's daemon listens for its hooks. */
export function daemonSocketPath(dataDir = appDataDir()): string {
  return process.env.AGENT_BUS_ANTIGRAVITY_SOCKET || path.join(dataDir, "plugin_data", "message-bus", "daemon.sock");
}

/** What a hook answers when the plugin has nothing to add (PreToolUse must decide; "allow" defers to the defaults). */
export function hookDefault(event: string): Record<string, unknown> {
  return event === "PreToolUse" ? { decision: "allow" } : {};
}

interface Hub {
  address: string;
  csrfToken: string;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The language server that started this process: its `daemon/hub_<port>.json` names its pid, port and CSRF token
 * (new on every start; old files linger, so only a live pid counts, our parent first).
 */
function findHub(dataDir: string): Hub | undefined {
  const dir = path.join(dataDir, "daemon");
  let hubs: Array<{ pid: number; httpPort: number; csrfToken: string }> = [];
  try {
    hubs = readdirSync(dir)
      .filter((f) => /^hub_\d+\.json$/.test(f))
      .map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")))
      .filter((h) => typeof h?.pid === "number" && typeof h.httpPort === "number" && typeof h.csrfToken === "string");
  } catch {
    return undefined;
  }
  const hub = hubs.find((h) => h.pid === process.ppid) ?? hubs.find((h) => alive(h.pid));
  return hub ? { address: `127.0.0.1:${hub.httpPort}`, csrfToken: hub.csrfToken } : undefined;
}

/** Runs `agentapi` against the live hub. AGENT_BUS_AGENTAPI overrides the binary (tests). */
export class AgentApi {
  constructor(private readonly dataDir = appDataDir()) {}

  private binary(): string {
    if (process.env.AGENT_BUS_AGENTAPI) return process.env.AGENT_BUS_AGENTAPI;
    const wrapper = path.join(this.dataDir, "bin", "agentapi");
    return existsSync(wrapper) ? wrapper : "agentapi";
  }

  private run(args: string[]): Promise<string> {
    const hub = findHub(this.dataDir);
    const env = hub ? { ...process.env, ANTIGRAVITY_LS_ADDRESS: hub.address, ANTIGRAVITY_CSRF_TOKEN: hub.csrfToken } : process.env;
    return new Promise((resolve, reject) => {
      execFile(this.binary(), args, { env, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error(`agentapi ${args[0]} failed: ${(stderr || err.message).trim().slice(0, 300)}`));
        else resolve(stdout);
      });
    });
  }

  /** Puts `content` into the conversation: starts a turn when it is idle, joins after the current tool call when busy. */
  async sendMessage(conversationId: string, content: string): Promise<void> {
    await this.run(["send-message", conversationId, content]);
  }

  /** Whether the conversation is a subagent's (its own conversation under a parent). */
  async isSubagent(conversationId: string): Promise<boolean> {
    const out = await this.run(["get-conversation-metadata", conversationId]);
    const meta = JSON.parse(out)?.response?.conversationMetadata?.metadata ?? {};
    return (meta.nestingDepth ?? 0) > 0 || Boolean(meta.parentConversationId);
  }
}
