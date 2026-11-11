// Only render Codex UI items. The rollout also contains model inputs, instructions and private
// reasoning: never fall back to serializing arbitrary records, arguments or content blocks.
import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ActivityLog } from "../../client/src/activity";
import type { ActivityEvent } from "../../protocol/src/types";
import { WAKE_SIGNAL } from "./wake";

/** At most this much of the rollout's end is read: on the first read, and when it grew more than this since. */
const WINDOW_BYTES = 512 * 1024;
const POLL_MS = 400;
const THREAD_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function isThreadId(id: string): boolean {
  return THREAD_ID.test(id);
}

/** A rollout record (`event_msg` records carry the UI items rendered here). */
interface RolloutRecord {
  type?: string;
  timestamp?: string;
  /** Untyped JSON: every field used is checked before use. */
  payload?: Record<string, any>;
}

export class LiveOutput {
  private thread?: string;
  private file?: string;
  private timer?: ReturnType<typeof setInterval>;
  private log?: ActivityLog;
  private offset = 0;
  /** Bytes after the last complete line (a line, or a UTF-8 character, still being written). */
  private carry = Buffer.alloc(0);
  /** The next line is cut (read from a window start, or longer than the window): skip it. */
  private skip = false;
  private watching = false;

  constructor(
    private readonly send: (events: ActivityEvent[], replay: boolean) => void,
    private readonly sessions = path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "sessions")
  ) {}

  bind(thread: string, file: unknown): void {
    if (this.file || !isThreadId(thread) || typeof file !== "string" || !path.isAbsolute(file)) return;
    try {
      const resolved = realpathSync(file);
      if (
        !resolved.startsWith(realpathSync(this.sessions) + path.sep) ||
        !path.basename(resolved).startsWith("rollout-") ||
        !resolved.endsWith(`-${thread}.jsonl`)
      ) {
        return;
      }
      this.thread = thread;
      this.file = resolved;
      if (this.watching) this.watch(true);
    } catch {
      // A later hook retries once the rollout exists.
    }
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
      this.timer = setInterval(() => this.read(), POLL_MS);
    }
    this.log.setWatching(true);
  }

  private read(): void {
    if (!this.file || !this.log) return;
    let fd: number | undefined;
    try {
      fd = openSync(this.file, "r");
      const size = fstatSync(fd).size;
      if (size < this.offset || size - this.offset > WINDOW_BYTES) {
        this.offset = Math.max(0, size - WINDOW_BYTES);
        this.carry = Buffer.alloc(0);
        this.skip = this.offset > 0;
      }
      if (size === this.offset) return;
      const buf = Buffer.alloc(size - this.offset);
      const bytesRead = readSync(fd, buf, 0, buf.length, this.offset);
      this.offset += bytesRead;
      const data = Buffer.concat([this.carry, buf.subarray(0, bytesRead)]);
      let start = 0;
      let end: number;
      while ((end = data.indexOf(10, start)) >= 0) {
        if (!this.skip) {
          try {
            this.item(JSON.parse(data.toString("utf8", start, end)));
          } catch {
            // Unknown or malformed record.
          }
        }
        this.skip = false;
        start = end + 1;
      }
      this.skip ||= data.length - start > WINDOW_BYTES;
      this.carry = this.skip ? Buffer.alloc(0) : Buffer.from(data.subarray(start));
    } catch {
      // A temporarily unavailable transcript must not break bus delivery.
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  private item(record: RolloutRecord): void {
    const payload = record.payload;
    const item = payload?.item;
    if (
      !this.log ||
      !this.thread ||
      !payload ||
      record.type !== "event_msg" ||
      payload.thread_id !== this.thread ||
      !["item_started", "item_completed"].includes(payload.type) ||
      typeof item?.id !== "string"
    ) {
      return;
    }
    const done = payload.type === "item_completed";
    const id = item.id;
    const at = Date.parse(record.timestamp || "") || Date.now();
    const text = (type: string): string =>
      Array.isArray(item.content)
        ? item.content
            .filter((block: { type?: unknown; text?: unknown }) => block?.type === type && typeof block.text === "string")
            .map((block: { text: string }) => block.text)
            .join("\n")
        : "";
    if (item.type === "AgentMessage" && ["commentary", "final_answer"].includes(item.phase)) {
      this.log.assistant(at, text("Text"), "", done, id);
    } else if (item.type === "UserMessage") {
      const prompt = text("text");
      if (prompt.trim() !== WAKE_SIGNAL) this.log.user(at, prompt, id);
    } else {
      let name: string;
      let detail = "";
      let output = "";
      if (item.type === "CommandExecution") {
        name = "Command";
        detail = Array.isArray(item.command) ? item.command.filter((part: unknown) => typeof part === "string").join(" ") : "";
        output = typeof item.aggregated_output === "string" ? item.aggregated_output : "";
      } else if (item.type === "FileChange") {
        name = "File change";
        detail = Object.keys(item.changes ?? {}).join(", ");
      } else if (item.type === "McpToolCall" && typeof item.tool === "string") {
        name = item.tool; // Raw connector arguments/results may contain hidden metadata.
      } else if (item.type === "WebSearch") {
        name = "Web search";
        detail = typeof item.query === "string" ? item.query : "";
      } else {
        return;
      }
      this.log.toolStart(id, name, { command: detail }, undefined, at);
      if (done) {
        const failed = item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0);
        this.log.toolOutput(id, output, failed ? "error" : "done");
      }
    }
  }
}
