// Live output for the bus website: turns a harness's prompts, model text and tool calls into `ActivityEvent` entries,
// keeps the most recent ones, and streams changes only while someone watches the agent's page. Nothing here reaches
// the model.
import type { ActivityEvent } from "../../protocol/src/types";

/** Entries kept for the replay a new watcher gets. */
const KEEP = 60;
/** Changes are sent at most this often while watched (streaming text updates many times a second). */
const FLUSH_MS = 300;
const MAX_TEXT = 20_000;
const MAX_INPUT = 600;
const MAX_OUTPUT = 4_000;

interface ContentBlock {
  type?: unknown;
  text?: unknown;
  thinking?: unknown;
}

/** Text blocks of an omp message content array, joined (thinking and tool-call blocks are left out). */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: ContentBlock) => b && b.type === "text" && typeof b.text === "string")
    .map((b: ContentBlock) => b.text as string)
    .join("\n");
}

/** Thinking blocks (`{ type: "thinking", thinking }`) of an assistant message, joined; "" when there are none. */
export function contentThinking(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: ContentBlock) => b && b.type === "thinking" && typeof b.thinking === "string")
    .map((b: ContentBlock) => b.thinking as string)
    .join("\n\n");
}

function head(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function tail(text: string, max: number): string {
  return text.length > max ? `…${text.slice(text.length - max + 1)}` : text;
}

/** The command (or path, query, URL) for tools that have one, else the arguments as JSON. omp, Claude Code and Antigravity names. */
export function toolInput(args: unknown): string {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const record = args as Record<string, unknown>;
    for (const key of ["command", "cmd", "code", "path", "file_path", "pattern", "query", "url", "prompt", "CommandLine", "AbsolutePath", "Path", "TargetFile", "Query", "Url"]) {
      if (typeof record[key] === "string") return head(record[key] as string, MAX_INPUT);
    }
  }
  try {
    return head(JSON.stringify(args) ?? "", MAX_INPUT);
  } catch {
    return "";
  }
}

export class ActivityLog {
  private entries = new Map<string, ActivityEvent>();
  private changed = new Set<string>();
  private watching = false;
  private timer: Timer | undefined;

  constructor(private readonly send: (events: ActivityEvent[], replay: boolean) => void) {}

  /** Watching starts (again, for a new viewer: everyone gets the replay) or stops. */
  setWatching(on: boolean): void {
    this.watching = on;
    this.changed.clear();
    clearTimeout(this.timer);
    this.timer = undefined;
    if (on) this.send([...this.entries.values()], true);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** `id` defaults to one derived from `at`; harnesses whose timestamps can repeat pass their own. */
  user(at: number, text: string, id = `u:${at}`): void {
    if (!text.trim()) return;
    this.upsert({ id, at, kind: "user", text: head(text, MAX_TEXT) });
  }

  assistant(at: number, text: string, thinking: string, done: boolean, id = `a:${at}`): void {
    if (!text.trim() && !thinking.trim() && !this.entries.has(id)) return;
    this.upsert({
      id,
      at,
      kind: "assistant",
      text: head(text, MAX_TEXT),
      ...(thinking.trim() ? { thinking: head(thinking, MAX_TEXT) } : {}),
      done,
    });
  }

  toolStart(id: string, name: string, args: unknown, intent: unknown, at = Date.now()): void {
    this.upsert({
      id,
      at,
      kind: "tool",
      name,
      ...(typeof intent === "string" && intent.trim() ? { intent: intent.trim() } : {}),
      input: toolInput(args),
      output: "",
      state: "running",
    });
  }

  toolOutput(id: string, output: string, state: "running" | "done" | "error"): void {
    const entry = this.entries.get(id);
    if (entry?.kind !== "tool") return;
    this.upsert({ ...entry, output: tail(output, MAX_OUTPUT), state });
  }

  private upsert(entry: ActivityEvent): void {
    // Re-inserting keeps the map in order of first appearance; only new ids grow it.
    this.entries.set(entry.id, entry);
    while (this.entries.size > KEEP) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    if (!this.watching) return;
    this.changed.add(entry.id);
    if (!this.timer) this.timer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  private flush(): void {
    this.timer = undefined;
    if (!this.watching || this.changed.size === 0) return;
    const events = [...this.changed].map((id) => this.entries.get(id)).filter((e): e is ActivityEvent => e !== undefined);
    this.changed.clear();
    if (events.length > 0) this.send(events, false);
  }
}
