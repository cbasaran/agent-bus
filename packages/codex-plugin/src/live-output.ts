// Only render Codex UI items. The rollout also contains model inputs, instructions and private
// reasoning: never fall back to serializing arbitrary records, arguments or content blocks.
import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ActivityLog } from "../../client/src/activity";
import type { ActivityEvent } from "../../protocol/src/types";
import { WAKE_SIGNAL } from "./wake";

const WINDOW = 512 * 1024;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function isThreadId(id: string): boolean { return uuid.test(id); }

export class LiveOutput {
  private thread?: string;
  private file?: string;
  private timer?: ReturnType<typeof setInterval>;
  private log?: ActivityLog;
  private offset = 0;
  private carry = Buffer.alloc(0);
  private skip = false;
  private watching = false;

  constructor(private readonly send: (events: ActivityEvent[], replay: boolean) => void,
    private readonly sessions = path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "sessions")) {}

  bind(thread: string, file: unknown): void {
    if (this.file || !isThreadId(thread) || typeof file !== "string" || !path.isAbsolute(file)) return;
    try {
      const resolved = realpathSync(file);
      if (!resolved.startsWith(realpathSync(this.sessions) + path.sep) ||
        !path.basename(resolved).startsWith("rollout-") || !resolved.endsWith(`-${thread}.jsonl`)) return;
      this.thread = thread;
      this.file = resolved;
      if (this.watching) this.watch(true);
    } catch { /* A later hook retries once the rollout exists. */ }
  }

  watch(on: boolean): void {
    this.watching = on;
    if (!on) {
      clearInterval(this.timer);
      this.timer = undefined;
      this.log?.dispose();
      this.log = undefined;
      this.carry = Buffer.alloc(0);
      return;
    }
    if (!this.file) return;
    if (!this.log) {
      this.log = new ActivityLog(this.send);
      this.offset = 0;
      this.skip = false;
      this.read();
      this.timer = setInterval(() => this.read(), 400);
    }
    this.log.setWatching(true);
  }

  private read(): void {
    if (!this.file || !this.log) return;
    let fd: number | undefined;
    try {
      fd = openSync(this.file, "r");
      const size = fstatSync(fd).size;
      if (size < this.offset || size - this.offset > WINDOW) {
        this.offset = Math.max(0, size - WINDOW);
        this.carry = Buffer.alloc(0);
        this.skip = this.offset > 0;
      }
      if (size === this.offset) return;
      const buf = Buffer.alloc(size - this.offset);
      const n = readSync(fd, buf, 0, buf.length, this.offset);
      this.offset += n;
      const data = Buffer.concat([this.carry, buf.subarray(0, n)]);
      let start = 0, end: number;
      while ((end = data.indexOf(10, start)) >= 0) {
        if (!this.skip) {
          try { this.item(JSON.parse(data.toString("utf8", start, end))); } catch { /* unknown or malformed record */ }
        }
        this.skip = false;
        start = end + 1;
      }
      this.skip ||= data.length - start > WINDOW;
      this.carry = this.skip ? Buffer.alloc(0) : Buffer.from(data.subarray(start));
    } catch { /* A temporarily unavailable transcript must not break bus delivery. */ }
    finally { if (fd !== undefined) closeSync(fd); }
  }

  private item(record: { type?: string; timestamp?: string; payload?: Record<string, any> }): void {
    const p = record.payload, i = p?.item;
    if (!this.log || !this.thread || !p || record.type !== "event_msg" || p.thread_id !== this.thread ||
      !["item_started", "item_completed"].includes(p.type) || typeof i?.id !== "string") return;
    const done = p.type === "item_completed", id = i.id, at = Date.parse(record.timestamp || "") || Date.now();
    const text = (type: string) => Array.isArray(i.content) ? i.content.filter((c: any) =>
      c?.type === type && typeof c.text === "string").map((c: any) => c.text).join("\n") : "";
    if (i.type === "AgentMessage" && ["commentary", "final_answer"].includes(i.phase)) {
      this.log.assistant(at, text("Text"), "", done, id);
    } else if (i.type === "UserMessage") {
      const prompt = text("text");
      if (prompt.trim() !== WAKE_SIGNAL) this.log.user(at, prompt, id);
    } else {
      let name: string, detail = "", output = "";
      if (i.type === "CommandExecution") {
        name = "Command";
        detail = Array.isArray(i.command) ? i.command.filter((s: unknown) => typeof s === "string").join(" ") : "";
        output = typeof i.aggregated_output === "string" ? i.aggregated_output : "";
      } else if (i.type === "FileChange") {
        name = "File change"; detail = Object.keys(i.changes ?? {}).join(", ");
      } else if (i.type === "McpToolCall" && typeof i.tool === "string") {
        name = i.tool; // Raw connector arguments/results may contain hidden metadata.
      } else if (i.type === "WebSearch") {
        name = "Web search"; detail = typeof i.query === "string" ? i.query : "";
      } else return;
      this.log.toolStart(id, name, { command: detail }, undefined, at);
      if (done) this.log.toolOutput(id, output, i.status === "failed" || (typeof i.exit_code === "number" && i.exit_code !== 0) ? "error" : "done");
    }
  }
}
