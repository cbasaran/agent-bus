// Desktop starts identical stdio servers for discovery and resumed chats. A folder, a PID
// or the mere existence of an old lock file is not a chat identity. On macOS verify the
// specific writer file is open in our parent before advertising an already known chat.
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { textResult, type McpToolResult } from "../../client/src/mcp";
import { TOOL_NAME, type MessageBusToolParams } from "../../client/src/tool";
import { isThreadId } from "./live-output";
import { CodexSession, HOOK_EVENTS, HOOK_TOOL, type HookEvent, type HookInput } from "./session";
import { queueWake } from "./wake";

const exec = promisify(execFile);

/** Presence sockets per binding: a slot whose socket a killed worker left behind is skipped, never unlinked. */
const WORKER_SLOTS = 8;

const shortHash = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 24);
const codexHome = (): string => path.resolve(process.env.CODEX_HOME || path.join(homedir(), ".codex"));
const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A chat (Codex thread `id`) of `folder`, with its rollout transcript. */
export interface Binding {
  folder: string;
  id: string;
  transcript: string;
}

const registryDir = (): string => path.join(codexHome(), "message-bus-bindings");
const bindingFile = (folder: string, id: string): string => path.join(registryDir(), `${shortHash(folder)}-${id}.json`);

// The transcript comes from the trusted root hook (or an explicit, verified upgrade seed).
export function bindingFor(folder: string, id: unknown, transcript: unknown): Binding | undefined {
  if (typeof id !== "string" || !isThreadId(id) || typeof transcript !== "string") return undefined;
  try {
    const file = realpathSync(transcript);
    if (
      !file.startsWith(realpathSync(path.join(codexHome(), "sessions")) + path.sep) ||
      !path.basename(file).startsWith("rollout-") ||
      !file.endsWith(`-${id}.jsonl`) ||
      !statSync(file).isFile()
    ) {
      return undefined;
    }
    return { folder: realpathSync(folder), id, transcript: file };
  } catch {
    return undefined;
  }
}

export function remember(binding: Binding): void {
  mkdirSync(registryDir(), { recursive: true, mode: 0o700 });
  const dest = bindingFile(binding.folder, binding.id);
  const tmp = `${dest}.${randomUUID()}`;
  writeFileSync(tmp, JSON.stringify(binding), { mode: 0o600, flag: "wx" });
  renameSync(tmp, dest);
}

function remembered(folder: string, id: string): Binding | undefined {
  try {
    const saved = JSON.parse(readFileSync(bindingFile(folder, id), "utf8"));
    if (saved.folder === folder && saved.id === id) return bindingFor(folder, saved.id, saved.transcript);
  } catch {
    // First visit, removed or invalid binding.
  }
  return undefined;
}

const locksDir = (): string => path.join(codexHome(), "thread-writer-locks");

/** The writer lock file's identity (with the parent pid), or undefined when the chat is not loaded. */
function lockIdentity(id: string, parent: number): string | undefined {
  try {
    const stat = lstatSync(path.join(locksDir(), `${id}.lock`), { bigint: true });
    if (stat.isFile()) return [parent, stat.dev, stat.ino, stat.birthtimeNs].join(":");
  } catch {
    // Unloaded.
  }
  return undefined;
}

/** The lock identity when `parent` really holds chat `id`'s writer lock open (macOS only), else undefined. */
async function lockGeneration(id: string, parent: number): Promise<string | undefined> {
  if (process.platform !== "darwin" || parent <= 1 || !isThreadId(id)) return undefined;
  const file = path.join(locksDir(), `${id}.lock`);
  const before = lockIdentity(id, parent);
  if (!before) return undefined;
  try {
    const { stdout } = await exec("/usr/sbin/lsof", ["-nP", "-a", "-p", String(parent), "-Fp", file], { timeout: 1800 });
    if (stdout.split("\n").includes(`p${parent}`) && before === lockIdentity(id, parent)) return before;
  } catch {
    // Stale file, different owner, or unsupported Codex runtime: stay offline.
  }
  return undefined;
}

function socketBase(binding: Binding, url: string, generation: string): string {
  // Short enough for macOS sockaddr_un even for a long CODEX_HOME.
  const uid = process.getuid!();
  const dir = `/tmp/message-bus-codex-${uid}`;
  mkdirSync(dir, { mode: 0o700, recursive: true });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== uid || stat.mode & 0o077) throw new Error("unsafe presence socket directory");
  return path.join(dir, shortHash(JSON.stringify([codexHome(), binding.folder, binding.id, url, generation])));
}

type Call = { name: string; args: Record<string, unknown> };

/** One call to a presence worker: a JSON line out, a JSON line back. */
function rpc(socket: string, call: Call): Promise<McpToolResult> {
  return new Promise((resolve, reject) => {
    const conn = createConnection(socket);
    let data = "";
    const fail = (err: Error): void => {
      conn.destroy();
      reject(err);
    };
    conn.setTimeout(call.name === "ping" ? 800 : 30_000, () => fail(new Error("presence timeout")));
    conn.on("error", fail);
    conn.on("connect", () => conn.write(`${JSON.stringify(call)}\n`));
    conn.setEncoding("utf8");
    conn.on("data", (chunk) => {
      data += chunk;
      if (!data.includes("\n")) return;
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
      conn.destroy();
    });
    conn.on("close", () => reject(new Error("presence connection closed")));
  });
}

async function ensureWorker(binding: Binding, url: string, parent: number): Promise<string | undefined> {
  const generation = await lockGeneration(binding.id, parent);
  if (!generation) return undefined;
  const base = socketBase(binding, url, generation);
  // Never unlink a socket another process could own. Skip stale paths left by a killed worker.
  for (let slot = 0; slot < WORKER_SLOTS; slot++) {
    const socket = `${base}.${slot}`;
    const ping = (): Promise<boolean> => rpc(socket, { name: "ping", args: {} }).then(() => true, () => false);
    if (existsSync(socket)) {
      if (await ping()) return socket;
      continue;
    }
    const child = spawn(
      process.execPath,
      [process.argv[1]!, "--presence-worker", JSON.stringify({ b: binding, url, parent, gen: generation, slot })],
      { detached: true, stdio: "ignore", env: process.env }
    );
    child.on("error", () => {});
    child.unref();
    for (let attempt = 0; attempt < 30; attempt++) {
      await sleep(60);
      if (await ping()) return socket;
    }
    return undefined;
  }
  return undefined;
}

// All MCP instances restoring one verified chat share the same receiver. A discovery
// process can launch it, but cannot consume messages on behalf of a different chat.
export class Reopen {
  private readonly boot: Promise<{ id: string; socket: string } | undefined>;
  private confirmed?: string;
  private saved?: string;
  private route?: Promise<string | undefined>;
  private lostRoute = false;

  constructor(
    private readonly folder: string,
    private readonly url: string,
    private readonly log: (line: string) => void
  ) {
    this.boot = this.restore().catch((err) => {
      this.log(`restore presence: ${err.message}`);
      return undefined;
    });
  }

  private async restore(): Promise<{ id: string; socket: string } | undefined> {
    if (process.platform !== "darwin" || !existsSync(registryDir()) || !existsSync(locksDir())) return undefined;
    for (const delay of [0, 250, 750]) {
      if (delay) await sleep(delay);
      // The lock directory is an index, not proof: stale files are common after crashes.
      const known = readdirSync(locksDir())
        .filter((name) => name.endsWith(".lock"))
        .map((name) => name.slice(0, -5))
        .filter(isThreadId)
        .map((id) => remembered(this.folder, id))
        .filter((binding): binding is Binding => !!binding);
      const active = (
        await Promise.all(known.map(async (binding) => ((await lockGeneration(binding.id, process.ppid)) ? binding : undefined)))
      ).filter((binding) => !!binding);
      if (active.length > 1) return undefined; // A folder address isn't an unambiguous cold-start target.
      if (active[0]) {
        const socket = await this.open(active[0]);
        if (socket) return { id: active[0].id, socket };
      }
    }
    return undefined;
  }

  private open(binding: Binding): Promise<string | undefined> {
    return ensureWorker(binding, this.url, process.ppid).catch((err) => {
      this.log(`presence: ${err.message}`);
      return undefined;
    });
  }

  /** The result of the call from this chat's presence worker, or undefined when this server handles it itself. */
  async call(name: string, args: Record<string, unknown>): Promise<McpToolResult | undefined> {
    if (name === HOOK_TOOL) {
      if (!HOOK_EVENTS.includes(args.event as HookEvent)) return undefined;
      const id = args.session_id;
      // Another chat's hook, or a subagent's before the root hook confirmed the chat: nothing to add.
      if (this.confirmed && this.confirmed !== id) return { ...textResult("{}"), structuredContent: {} };
      if (args.agent_id && !this.confirmed) return { ...textResult("{}"), structuredContent: {} };
      if (typeof id !== "string" || !isThreadId(id)) return undefined;
      this.confirmed = id;
      const binding = this.saved !== id ? bindingFor(this.folder, id, args.transcript_path) : undefined;
      if (binding && this.saved !== id) {
        try {
          remember(binding);
          this.saved = id;
        } catch (err) {
          this.log(`could not save chat binding: ${err}`);
        }
        this.route ??= this.boot.then((cold) => (!this.lostRoute && cold?.id === id ? cold.socket : this.open(binding)));
      }
    }
    if (!this.confirmed || !this.route) return undefined;
    const socket = await this.route;
    if (!socket) return undefined;
    // Do not repeat a tool call on ambiguous transport failure: it may already have sent a message.
    try {
      return await rpc(socket, { name, args });
    } catch (err) {
      this.route = undefined;
      this.saved = undefined;
      this.lostRoute = true;
      return { ...textResult(`Presence connection lost; check the result before retrying: ${err}`), isError: true };
    }
  }
}

/** The presence worker (`server.mjs --presence-worker <json>`): serves one loaded chat until Codex unloads it. */
export async function worker(input: string, log: (line: string) => void): Promise<void> {
  const { b: raw, url, parent, gen: generation, slot } = JSON.parse(input);
  const binding = bindingFor(raw.folder, raw.id, raw.transcript);
  if (
    !binding ||
    !Number.isInteger(parent) ||
    !Number.isInteger(slot) ||
    slot < 0 ||
    slot >= WORKER_SLOTS ||
    !generation ||
    (await lockGeneration(binding.id, parent)) !== generation
  ) {
    return;
  }
  const socket = `${socketBase(binding, url, generation)}.${slot}`;
  let session: CodexSession | undefined;
  const server = createServer((conn) => {
    let data = "";
    let dispatched = false;
    conn.on("error", () => {});
    conn.setEncoding("utf8");
    conn.setTimeout(35_000, () => conn.destroy());
    conn.on("data", async (chunk) => {
      if (dispatched) return;
      data += chunk;
      if (data.length > 1024 * 1024) {
        conn.destroy();
        return;
      }
      if (!data.includes("\n")) return;
      dispatched = true;
      try {
        const { name, args } = JSON.parse(data) as Call;
        let result: McpToolResult;
        if (name === "ping") result = textResult("ready");
        else if (!session) throw new Error("presence not ready");
        else {
          await session.waitForStartup();
          if (name === HOOK_TOOL && args.session_id === binding.id && HOOK_EVENTS.includes(args.event as HookEvent)) {
            const answer = session.hook(args.event as HookEvent, args as HookInput);
            result = { ...textResult(JSON.stringify(answer)), structuredContent: answer };
          } else if (name === TOOL_NAME) {
            result = textResult(await session.runTool(args as unknown as MessageBusToolParams));
          } else {
            throw new Error("invalid presence call");
          }
        }
        conn.end(`${JSON.stringify(result)}\n`);
      } catch (err) {
        conn.end(`${JSON.stringify({ ...textResult(String(err)), isError: true })}\n`);
      }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
  } catch {
    return; // Another MCP process won the same atomic bind.
  }
  chmodSync(socket, 0o600);
  session = new CodexSession(binding.folder, url, log, async (id) => {
    if ((await lockGeneration(id, parent)) !== generation) throw new Error("chat is no longer loaded");
    await queueWake(id);
  });
  session.bindTask(binding.id, binding.transcript); // No hook simulation, model call or wake on reopen.
  log(`serving loaded chat ${binding.id}`);
  const stop = (): void => {
    session?.close();
    server.close();
  };
  process.once("SIGTERM", stop);
  for (let tick = 0; ; tick++) {
    await sleep(2000);
    if (!server.listening || lockIdentity(binding.id, parent) !== generation) break;
    try {
      process.kill(parent, 0);
    } catch {
      break;
    }
    if (tick % 15 === 14 && (await lockGeneration(binding.id, parent)) !== generation) break;
  }
  stop();
}
