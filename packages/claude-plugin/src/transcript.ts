// Follows a Claude Code session transcript (`~/.claude/projects/<project>/<session>.jsonl`, append-only, one JSON
// record per line). Everything the model gets is written there before the request goes out, so it tells the plugin
// which bus deliveries the model has seen (their `[message-bus] #n @` header is in it) and when the user interrupted
// a turn. Its records also feed the live output on the website.
import * as os from "node:os";
import * as path from "node:path";
import { contentText, contentThinking, type ActivityLog } from "../../client/src/activity";
import { LineTail } from "../../client/src/tail";
import { deliveryHeaderSeqs } from "../../protocol/src/address";

const POLL_MS = 500;
/** On start, only this much of the end of a long transcript is read (the live-output log keeps 60 entries anyway). */
const START_BYTES = 512 * 1024;

/** Claude Code writes this as a user message when the user stops a running turn (Esc); no Stop hook follows. */
const INTERRUPTED = "[Request interrupted by user";

interface ContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface TranscriptRecord {
  type?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  timestamp?: string;
  uuid?: string;
  message?: { id?: string; role?: string; content?: unknown };
  /** Hook output and other context Claude Code attaches to the conversation. */
  attachment?: { type?: string; content?: unknown };
}

/** Where Claude Code keeps a session's transcript: the project path with every other character than [A-Za-z0-9] as "-". */
export function transcriptPathFor(projectDir: string, sessionId: string): string {
  return path.join(os.homedir(), ".claude", "projects", projectDir.replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`);
}

/** A channel event as the model gets it (`<channel source="…">text</channel>`): just the text. */
function unwrapChannel(text: string): string {
  const match = /^\s*<channel\b[^>]*>\n?([\s\S]*?)\n?<\/channel>\s*$/.exec(text);
  return match?.[1] ?? text;
}

/** Text of a tool_result's content (a string or text blocks). */
function resultText(content: unknown): string {
  return typeof content === "string" ? content : contentText(content);
}

export interface TranscriptEvents {
  /** Delivery headers (`[message-bus] #n @`) found in what goes to the model. */
  onHeaders(seqs: number[]): void;
  /** The user interrupted the running turn. */
  onInterrupted(): void;
}

export class TranscriptFollower {
  private readonly tail = new LineTail((line, live) => this.line(line, live));
  private timer: NodeJS.Timeout | undefined;
  /** Text and thinking of each assistant message so far (Claude Code writes one record per content block). */
  private readonly assistant = new Map<string, { at: number; text: string; thinking: string }>();

  constructor(
    private readonly events: TranscriptEvents,
    private readonly log: ActivityLog
  ) {}

  /** Follows `file` from now on (after `/clear` or a resume the session writes a new one). */
  follow(file: string): void {
    if (file === this.tail.file) return;
    this.assistant.clear();
    this.tail.open(file, START_BYTES);
    this.timer ??= setInterval(() => this.tail.read(), POLL_MS);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Reads what was appended since the last read (hooks call this so they act on an up-to-date view). */
  read(): void {
    this.tail.read();
  }

  /** `live`: false for the cut start of a long transcript (an interrupt there is old). */
  private line(line: string, live: boolean): void {
    let record: TranscriptRecord;
    try {
      record = JSON.parse(line) as TranscriptRecord;
    } catch {
      return; // cut by the start offset
    }
    // A header anywhere in a record (prompt, channel event, hook context, request log) reached the model; queued
    // input is logged before it does.
    if (record.type !== "queue-operation" && line.includes("[message-bus] #")) {
      const seqs = deliveryHeaderSeqs(line);
      if (seqs.length > 0) this.events.onHeaders(seqs);
    }
    this.record(record, live);
  }

  private record(record: TranscriptRecord, live: boolean): void {
    if (record.isSidechain) return; // subagents
    const at = Date.parse(record.timestamp ?? "") || Date.now();
    const id = record.uuid ?? `${at}`;
    if (record.type === "attachment") {
      // Hook context added to the conversation (`hook_additional_context`, content: string[]): the plugin's held bus
      // messages among others.
      if (record.attachment?.type !== "hook_additional_context") return;
      const content = record.attachment.content;
      const text = (Array.isArray(content) ? content : [content]).filter((c): c is string => typeof c === "string").join("\n\n");
      if (text.includes("[message-bus] #")) this.log.user(at, text, `u:${id}`);
      return;
    }
    const content = record.message?.content;
    if (record.type === "user") {
      if (typeof content === "string") {
        if (content.startsWith(INTERRUPTED)) {
          if (live) this.events.onInterrupted();
          return;
        }
        if (!record.isMeta) this.log.user(at, unwrapChannel(content), `u:${id}`);
        return;
      }
      if (!Array.isArray(content)) return;
      for (const block of content as ContentBlock[]) {
        if (block.type === "tool_result" && block.tool_use_id) {
          this.log.toolOutput(`t:${block.tool_use_id}`, resultText(block.content), block.is_error ? "error" : "done");
        } else if (block.type === "text" && typeof block.text === "string") {
          if (block.text.startsWith(INTERRUPTED)) {
            if (live) this.events.onInterrupted();
          } else if (!record.isMeta) {
            this.log.user(at, unwrapChannel(block.text), `u:${id}`);
          }
        }
      }
      return;
    }
    if (record.type === "assistant" && Array.isArray(content)) {
      const messageId = record.message?.id ?? id;
      const so = this.assistant.get(messageId) ?? { at, text: "", thinking: "" };
      this.assistant.set(messageId, so);
      const text = contentText(content);
      const thinking = contentThinking(content);
      if (text) so.text = so.text ? `${so.text}\n${text}` : text;
      if (thinking) so.thinking = so.thinking ? `${so.thinking}\n\n${thinking}` : thinking;
      if (text || thinking) this.log.assistant(so.at, so.text, so.thinking, true, `a:${messageId}`);
      for (const block of content as ContentBlock[]) {
        if (block.type === "tool_use" && block.id) this.log.toolStart(`t:${block.id}`, block.name ?? "tool", block.input ?? {}, undefined, at);
      }
      // Keep the map small: only recent messages can still get blocks.
      if (this.assistant.size > 20) this.assistant.delete(this.assistant.keys().next().value as string);
    }
  }
}
