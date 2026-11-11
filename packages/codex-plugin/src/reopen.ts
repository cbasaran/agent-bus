// Desktop starts identical stdio servers for discovery and resumed chats. A folder, a PID
// or the mere existence of an old lock file is not a chat identity. On macOS verify the
// specific writer file is open in our parent before advertising an already known chat.
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { isThreadId } from "./live-output";
import { CodexSession, HOOK_EVENTS, HOOK_TOOL, type HookEvent, type HookInput } from "./session";
import { TOOL_NAME, type MessageBusToolParams } from "../../client/src/tool";
import { queueWake } from "./wake";

const exec = promisify(execFile);
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 24);
const home = () => path.resolve(process.env.CODEX_HOME || path.join(homedir(), ".codex"));
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export interface Binding { folder: string; id: string; transcript: string }
const registry = () => path.join(home(), "message-bus-bindings");
const bindingFile = (folder: string, id: string) => path.join(registry(), hash(folder) + "-" + id + ".json");

// The transcript comes from the trusted root hook (or an explicit, verified upgrade seed).
export function bindingFor(folder: string, id: unknown, transcript: unknown): Binding | undefined {
  if (typeof id !== "string" || !isThreadId(id) || typeof transcript !== "string") return;
  try {
    const file = realpathSync(transcript);
    if (!file.startsWith(realpathSync(path.join(home(), "sessions")) + path.sep) ||
      !path.basename(file).startsWith("rollout-") || !file.endsWith(`-${id}.jsonl`) || !statSync(file).isFile()) return;
    return { folder: realpathSync(folder), id, transcript: file };
  } catch { return; }
}

export function remember(b: Binding): void {
  mkdirSync(registry(), {recursive:true, mode:0o700});
  const dest = bindingFile(b.folder,b.id), tmp = dest + "." + randomUUID();
  writeFileSync(tmp, JSON.stringify(b), {mode:0o600, flag:"wx"});
  renameSync(tmp, dest);
}
function remembered(folder: string, id: string): Binding | undefined {
  try {
    const b = JSON.parse(readFileSync(bindingFile(folder,id), "utf8"));
    if (b.folder === folder && b.id === id) return bindingFor(folder, b.id, b.transcript);
  } catch { /* First visit, removed or invalid binding. */ }
}

const locks = () => path.join(home(), "thread-writer-locks");
function lockIdentity(id: string, parent: number): string | undefined {
  try {
    const s = lstatSync(path.join(locks(), id + ".lock"), {bigint:true});
    if (s.isFile()) return [parent,s.dev,s.ino,s.birthtimeNs].join(":");
  } catch { /* Unloaded. */ }
}
async function generation(id: string, parent: number): Promise<string | undefined> {
  if (process.platform !== "darwin" || parent <= 1 || !isThreadId(id)) return;
  const file = path.join(locks(), id + ".lock"), before = lockIdentity(id,parent);
  if (!before) return;
  try {
    const {stdout} = await exec("/usr/sbin/lsof", ["-nP", "-a", "-p", String(parent), "-Fp", file], {timeout:1800});
    if (stdout.split("\n").includes("p" + parent) && before === lockIdentity(id,parent)) return before;
  } catch { /* Stale file, different owner, or unsupported Codex runtime: stay offline. */ }
}

function socketBase(b: Binding, url: string, gen: string): string {
  // Short enough for macOS sockaddr_un even for a long CODEX_HOME.
  const uid = process.getuid!(), dir = "/tmp/message-bus-codex-" + uid;
  mkdirSync(dir, {mode:0o700, recursive:true});
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.uid !== uid || (st.mode & 0o077)) throw new Error("unsafe presence socket directory");
  return path.join(dir, hash(JSON.stringify([home(), b.folder, b.id, url, gen])));
}
type Call = { name: string; args: Record<string, unknown> };
type Result = { content: {type:"text"; text:string}[]; structuredContent?: Record<string, unknown>; isError?: boolean };
const textResult = (text: string): Result => ({content:[{type:"text",text}]});

function rpc(socket: string, call: Call): Promise<Result> {
  return new Promise((resolve, reject) => {
    const conn = createConnection(socket); let data = "";
    const fail = (e: Error) => { conn.destroy(); reject(e); };
    conn.setTimeout(call.name === "ping" ? 800 : 30_000, () => fail(new Error("presence timeout")));
    conn.on("error", fail);
    conn.on("connect", () => conn.write(JSON.stringify(call) + "\n"));
    conn.setEncoding("utf8");
    conn.on("data", chunk => { data += chunk; if (data.includes("\n")) {
      try { resolve(JSON.parse(data)); } catch (e) {reject(e);} conn.destroy();
    }});
    conn.on("close", () => reject(new Error("presence connection closed")));
  });
}

async function ensureWorker(b: Binding, url: string, parent: number): Promise<string | undefined> {
  const gen = await generation(b.id, parent);
  if (!gen) return;
  const base = socketBase(b, url, gen);
  // Never unlink a socket another process could own. Skip stale paths left by a killed worker.
  for (let slot=0; slot<8; slot++) {
    const socket = base + "." + slot;
    const ping = () => rpc(socket, {name:"ping",args:{}}).then(() => true, () => false);
    if (existsSync(socket)) { if (await ping()) return socket; continue; }
    const child = spawn(process.execPath, [process.argv[1]!, "--presence-worker", JSON.stringify({b,url,parent,gen,slot})],
      {detached:true, stdio:"ignore", env:process.env});
    child.on("error", () => {}); child.unref();
    for (let n=0;n<30;n++) { await sleep(60); if (await ping()) return socket; }
    return;
  }
}

// All MCP instances restoring one verified chat share the same receiver. A discovery
// process can launch it, but cannot consume messages on behalf of a different chat.
export class Reopen {
  private readonly boot: Promise<{id:string;socket:string} | undefined>;
  private confirmed?: string;
  private saved?: string;
  private route?: Promise<string | undefined>;
  private lostRoute = false;
  constructor(private readonly folder: string, private readonly url: string, private readonly log: (line:string)=>void) {
    this.boot = this.restore().catch(e => {this.log("restore presence: " + e.message); return undefined;});
  }
  private async restore() {
    if (process.platform !== "darwin" || !existsSync(registry()) || !existsSync(locks())) return;
    for (const delay of [0,250,750]) {
      if (delay) await sleep(delay);
      // The lock directory is an index, not proof: stale files are common after crashes.
      const known = readdirSync(locks()).filter(n => n.endsWith(".lock")).map(n=>n.slice(0,-5))
        .filter(isThreadId).map(id=>remembered(this.folder,id)).filter((b): b is Binding=>!!b);
      const active = (await Promise.all(known.map(async b=>await generation(b.id,process.ppid) ? b : undefined))).filter(b=>!!b);
      if (active.length > 1) return; // A folder address isn't an unambiguous cold-start target.
      if (active[0]) {
        const socket = await this.open(active[0]);
        if (socket) return {id:active[0].id,socket};
      }
    }
  }
  private open(b: Binding) { return ensureWorker(b,this.url,process.ppid).catch(e => {this.log("presence: " + e.message); return undefined;}); }
  async call(name: string, args: Record<string, unknown>): Promise<Result | undefined> {
    if (name === HOOK_TOOL) {
      if (!HOOK_EVENTS.includes(args.event as HookEvent)) return;
      const id = args.session_id;
      if (this.confirmed && this.confirmed !== id) return {...textResult("{}"),structuredContent:{}};
      if (args.agent_id && !this.confirmed) return {...textResult("{}"),structuredContent:{}};
      if (typeof id !== "string" || !isThreadId(id)) return;
      this.confirmed = id;
      const b = this.saved !== id ? bindingFor(this.folder, id, args.transcript_path) : undefined;
      if (b && this.saved !== id) {
        try { remember(b); this.saved = id; } catch (e) {this.log("could not save chat binding: " + e);}
        this.route ??= this.boot.then(cold => !this.lostRoute && cold?.id === id ? cold.socket : this.open(b));
      }
    }
    if (!this.confirmed || !this.route) return;
    const socket = await this.route;
    if (!socket) return;
    // Do not repeat a tool call on ambiguous transport failure: it may already have sent a message.
    try { return await rpc(socket,{name,args}); } catch (e) {
      this.route = undefined; this.saved = undefined; this.lostRoute = true;
      return {...textResult("Presence connection lost; check the result before retrying: " + e),isError:true};
    }
  }
}

export async function worker(input: string, log: (line:string)=>void): Promise<void> {
  const {b:raw,url,parent,gen,slot} = JSON.parse(input);
  const b = bindingFor(raw.folder,raw.id,raw.transcript);
  if (!b || !Number.isInteger(parent) || !Number.isInteger(slot) || slot<0 || slot>=8 || !gen ||
    await generation(b.id,parent) !== gen) return;
  const socket = socketBase(b,url,gen) + "." + slot;
  let session: CodexSession | undefined;
  const server = createServer(conn => {
    let data = "", dispatched = false;
    conn.on("error",()=>{});
    conn.setEncoding("utf8"); conn.setTimeout(35_000,()=>conn.destroy());
    conn.on("data", async chunk => {
      if (dispatched) return;
      data += chunk;
      if (data.length>1024*1024) {conn.destroy();return;}
      if (!data.includes("\n")) return;
      dispatched = true;
      try {
        const {name,args} = JSON.parse(data) as Call; let result: Result;
        if (name === "ping") result = textResult("ready");
        else if (!session) throw new Error("presence not ready");
        else {
          await session.waitForStartup();
          if (name === HOOK_TOOL && args.session_id === b.id && HOOK_EVENTS.includes(args.event as HookEvent)) {
            const out = session.hook(args.event as HookEvent,args as HookInput);
            result = {...textResult(JSON.stringify(out)),structuredContent:out};
          } else if (name === TOOL_NAME) result = textResult(await session.runTool(args as unknown as MessageBusToolParams));
          else throw new Error("invalid presence call");
        }
        conn.end(JSON.stringify(result)+"\n");
      } catch(e) {conn.end(JSON.stringify({...textResult(String(e)),isError:true})+"\n");}
    });
  });
  try { await new Promise<void>((ok,no)=>{server.once("error",no);server.listen(socket,ok);}); }
  catch { return; } // Another MCP process won the same atomic bind.
  chmodSync(socket,0o600);
  session = new CodexSession(b.folder,url,log,async id=>{
    if (await generation(id,parent) !== gen) throw new Error("chat is no longer loaded");
    await queueWake(id);
  });
  session.bindTask(b.id,b.transcript); // No hook simulation, model call or wake on reopen.
  log("serving loaded chat " + b.id);
  const stop = () => {session?.close();server.close();};
  process.once("SIGTERM",stop);
  for (let tick=0;;tick++) {
    await sleep(2000);
    if (!server.listening || lockIdentity(b.id,parent) !== gen) break;
    try { process.kill(parent,0); } catch { break; }
    if (tick % 15 === 14 && await generation(b.id,parent) !== gen) break;
  }
  stop();
}
