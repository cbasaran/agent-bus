// Live output for Antigravity: follows a conversation's `transcript_full.jsonl` (append-only, one JSON step per line;
// the plain `transcript.jsonl` truncates thinking and long outputs) and turns its steps into activity entries.
// Only runs while someone watches the agent's page on the website.
import { existsSync } from "node:fs";
import type { ActivityLog } from "../../client/src/activity";
import { LineTail } from "../../client/src/tail";

const POLL_MS = 500;
/** On start, only this much of the end of a long transcript is read (the log keeps the last 60 entries anyway). */
const START_BYTES = 2 * 1024 * 1024;

interface Step {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  created_at?: string;
  content?: string;
  thinking?: string;
  error?: string;
  tool_calls?: Array<{ name?: string; args?: Record<string, unknown> }>;
}

/** The full transcript beside the path the hooks report (which may be the truncated one). */
export function fullTranscriptPath(transcriptPath: string): string {
  const full = transcriptPath.replace(/transcript\.jsonl$/, "transcript_full.jsonl");
  return existsSync(full) ? full : transcriptPath;
}

/** A prompt as the user typed it: Antigravity wraps it in <USER_REQUEST> and appends metadata. */
function userText(content: string): string {
  const request = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(content);
  return request?.[1] ?? content;
}

/** Feeds transcript steps into an ActivityLog. Tool results follow their call's step in order. */
export class TranscriptActivity {
  private readonly tail = new LineTail((line) => {
    try {
      this.step(JSON.parse(line) as Step);
    } catch {
      // A line cut by the start offset, or not JSON: skip it.
    }
  });
  private timer: NodeJS.Timeout | undefined;
  private readonly openTools: string[] = [];

  /** `idPrefix` keeps entry ids apart when the agent's conversation changes (step numbers restart). */
  constructor(
    private readonly file: string,
    private readonly log: ActivityLog,
    private readonly idPrefix: string
  ) {}

  /** Reads what is there (the tail of a long file) and keeps following appends. */
  start(): void {
    try {
      this.tail.open(this.file, START_BYTES);
    } catch {
      // Not readable yet: the poll picks it up once it is.
    }
    this.timer = setInterval(() => this.tail.read(), POLL_MS);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private step(step: Step): void {
    const n = `${this.idPrefix}:${step.step_index ?? 0}`;
    const at = Date.parse(step.created_at ?? "") || Date.now();
    if (step.type === "USER_INPUT") {
      this.log.user(at, userText(step.content ?? ""), `s:${n}`);
    } else if (step.type === "SYSTEM_MESSAGE" && step.content?.includes("[message-bus]")) {
      // A bus delivery (agentapi send-message): show the delivery, not Antigravity's wrapper around it.
      const content = step.content;
      this.log.user(at, content.slice(content.indexOf("[message-bus]")).replace(/\s*<\/SYSTEM_MESSAGE>\s*$/, ""), `s:${n}`);
    } else if (step.type === "PLANNER_RESPONSE") {
      this.log.assistant(at, step.content ?? "", step.thinking ?? "", true, `s:${n}`);
      (step.tool_calls ?? []).forEach((call, i) => {
        const id = `t:${n}:${i}`;
        this.log.toolStart(id, call.name ?? "tool", call.args ?? {}, call.args?.toolSummary, at);
        this.openTools.push(id);
      });
    } else if (step.type === "GENERIC") {
      const id = this.openTools.shift();
      if (!id) return;
      const state = step.error ? "error" : step.status === "RUNNING" ? "running" : "done";
      this.log.toolOutput(id, step.error ? `${step.error}\n${step.content ?? ""}` : (step.content ?? ""), state);
    }
  }
}
