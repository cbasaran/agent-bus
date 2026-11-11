// One Claude Code session on the bus. Claude Code starts the plugin's MCP server once per session (one `claude`
// process), so this server is the session's bus agent: it joins with the project folder (the same identity rule as
// omp), serves the `message-bus` tool, and gets the session's hooks over a local socket.
//
// How messages reach the model (Claude Code has no "send to this session" call):
// - idle, wake → a channel event (`notifications/claude/channel`): Claude Code starts a turn with it.
// - busy, wake → held, and added to the running turn by the next PostToolUse hook (`additionalContext`), like omp's
//   `aside`; if the turn ends first (Stop, or an interrupt), sent as a channel event then. A channel event sent while
//   busy would only arrive after the turn anyway.
// - quiet (@all from agents) and receipt notices → held for the next UserPromptSubmit or PostToolUse hook.
// - seen: once the delivery header is in the session transcript (Claude Code writes what goes to the model there).
// Channel events reach the session only when Claude Code was started with this plugin's channel enabled. When a channel
// event is not in the transcript a while later, the plugin stops relying on them and holds wake messages for the next
// hook instead (the user's next prompt delivers them).
import * as os from "node:os";
import { ActivityLog } from "../../client/src/activity";
import { BusConnection, type Delivery } from "../../client/src/connection";
import { HeldQueue, UnseenSeqs } from "../../client/src/held";
import { StatusTracker } from "../../client/src/status";
import { BusTool, deliveryText, type MessageBusToolParams } from "../../client/src/tool";
import { deliveryHeaderSeqs } from "../../protocol/src/address";
import type { ReceiptFrame } from "../../protocol/src/types";
import { TranscriptFollower, transcriptPathFor } from "./transcript";

/** A channel event not in the transcript after this long did not reach the session. */
const CHANNEL_CHECK_MS = Number(process.env.AGENT_BUS_CHANNEL_CHECK_MS) || 20_000;
/** After this many dropped channel events in a row the channel counts as not enabled (one can be lost to timing). */
const CHANNEL_MAX_DROPS = 2;

/** The hook input fields used here (Claude Code sends more). */
export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  source?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  /** UserPromptSubmit: the prompt; for a turn started by channel events, their `<channel …>` text. */
  prompt?: string;
  /** Set when the hook runs inside a subagent. */
  agent_id?: string;
}

export type HookEvent = "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop";

export interface ClaudeSessionOptions {
  folder: string;
  busUrl: string;
  /** From CLAUDE_CODE_SESSION_ID: finds the transcript before the first hook arrives. */
  sessionId?: string;
  /** Sends a channel event into the session. */
  sendChannel: (content: string, meta: Record<string, string>) => Promise<void>;
  /**
   * Resolves when channel events can be sent. Claude Code drops events that arrive while a session is still starting
   * (seen on 10 Nov: the join backlog, sent as the channel registered during a resume, never reached the session).
   * Wake messages are held until then. Default: at once.
   */
  channelReady?: Promise<void>;
  log: (line: string) => void;
}

export class ClaudeSession {
  readonly folder: string;
  readonly conn: BusConnection;
  readonly tool: BusTool;

  /** Given to the session (channel or hook), not yet seen in the transcript. */
  private readonly unseen = new UnseenSeqs((seq) => this.conn.markSeen(seq));
  /** Messages waiting for a hook (or for the turn to end). */
  private readonly held = new HeldQueue(this.unseen);
  /** Sent as channel events, not yet seen in the transcript: seq → text (resent at the next hook if lost). */
  private readonly onChannel = new Map<number, string>();
  /** False once channel events keep not arriving: wake messages then wait for the next hook. */
  private channelWorks = true;
  /** Channel events dropped in a row. */
  private channelDrops = 0;
  /** Claude Code is ready for channel events (see `channelReady`). */
  private channelOpen = false;
  private channelCheck: NodeJS.Timeout | undefined;
  private channelSentAt = 0;
  /** Last hook that shows the session doing something (not SessionStart). */
  private lastActivityAt = 0;

  private readonly status: StatusTracker;
  private readonly activityLog: ActivityLog;
  private readonly transcript: TranscriptFollower;
  private readonly sendChannel: ClaudeSessionOptions["sendChannel"];
  private readonly log: (line: string) => void;

  constructor(options: ClaudeSessionOptions) {
    this.folder = options.folder;
    this.sendChannel = options.sendChannel;
    this.log = options.log;
    this.status = new StatusTracker(this.log);
    this.activityLog = new ActivityLog((events, replay) => this.conn.sendActivity(events, replay));
    this.transcript = new TranscriptFollower(
      { onHeaders: (seqs) => this.seenInTranscript(seqs), onInterrupted: () => this.turnEnded() },
      this.activityLog
    );
    if (options.sessionId) this.transcript.follow(transcriptPathFor(options.folder, options.sessionId));
    this.conn = new BusConnection({
      url: options.busUrl,
      host: os.hostname(),
      harness: "claude",
      path: options.folder,
      onDeliver: (delivery) => this.deliver(delivery),
      onReceipt: (receipt) => this.receipt(receipt),
      onWatch: (on) => this.activityLog.setWatching(on),
      onJoined: (id) => this.log(`on the bus as @${id} (${this.folder})`),
      onLog: (line) => this.log(line),
    });
    this.tool = new BusTool(this.conn);
    this.conn.connect();
    this.status.attach(this.conn);
    void (options.channelReady ?? Promise.resolve()).then(() => {
      this.channelOpen = true;
      if (!this.status.busy) this.wakeHeld();
    });
  }

  close(): void {
    this.status.detach();
    clearTimeout(this.channelCheck);
    this.transcript.stop();
    this.activityLog.dispose();
    this.conn.close();
  }

  runTool(params: MessageBusToolParams): Promise<string> {
    if (!this.conn.id) throw new Error("Not connected to the message bus yet (still trying).");
    return this.tool.run(params, this.folder);
  }

  // ---- Deliveries ----

  private async deliver(delivery: Delivery): Promise<void> {
    const text = await deliveryText(this.conn, delivery);
    const seq = delivery.message.seq;
    this.unseen.add(seq);
    if (delivery.wake && !this.status.busy && this.channelWorks && this.channelOpen) await this.toChannel(text, seq);
    else this.held.push({ text, seq, wake: delivery.wake });
  }

  private receipt(receipt: ReceiptFrame): void {
    const notice = this.tool.receiptNotice(receipt);
    if (notice) this.held.push({ text: notice, wake: false });
  }

  /** Starts a turn with `text` (Claude Code queues it behind a running turn). */
  private async toChannel(text: string, seq: number): Promise<void> {
    await this.sendChannel(text, { message_id: String(seq) });
    this.onChannel.set(seq, text);
    this.channelSentAt = Date.now();
    this.status.setBusy();
    this.channelCheck ??= setTimeout(() => this.checkChannel(), CHANNEL_CHECK_MS);
  }

  /**
   * Channel events still missing from the transcript did not reach the session: hold them again, and resend them if
   * the session is idle. After CHANNEL_MAX_DROPS drops in a row the channel counts as not enabled, and held messages
   * wait for the next hook (the user's next prompt).
   */
  private checkChannel(): void {
    this.channelCheck = undefined;
    this.transcript.read();
    if (this.onChannel.size === 0) return;
    this.channelDrops += 1;
    const seqs = [...this.onChannel.keys()].map((seq) => `#${seq}`).join(", ");
    if (this.channelWorks && this.channelDrops >= CHANNEL_MAX_DROPS) {
      this.channelWorks = false;
      this.log(
        `channel events (${seqs}) did not reach this session ${this.channelDrops} times in a row; is Claude Code started with ` +
          "--dangerously-load-development-channels plugin:message-bus@agent-bus? Bus messages now wait for the next prompt"
      );
    } else {
      this.log(`channel event(s) ${seqs} not in the transcript after ${CHANNEL_CHECK_MS} ms; trying again`);
    }
    for (const [seq, text] of this.onChannel) this.held.push({ text, seq, wake: true });
    this.onChannel.clear();
    // No hook ran since: the turn the events were meant to start never did (resends them while the channel works).
    if (this.lastActivityAt < this.channelSentAt) this.turnEnded();
  }

  private seenInTranscript(seqs: number[]): void {
    for (const seq of seqs) {
      if (this.onChannel.delete(seq)) {
        this.channelDrops = 0;
        this.channelWorks = true;
      }
      this.unseen.seen(seq);
    }
  }

  /** The turn ended (Stop, interrupt): held wake messages start the next one. */
  private turnEnded(): void {
    this.status.setIdle();
    this.wakeHeld();
  }

  /** Sends held wake messages as channel events (when the channel works and is open). */
  private wakeHeld(): void {
    if (!this.channelWorks || !this.channelOpen) return;
    // Quiet ones stay held; the channel turn's first hook (if it runs a tool) or the next prompt takes them.
    for (const item of this.held.takeWake()) {
      this.toChannel(item.text, item.seq as number).catch((err: Error) => {
        this.log(`channel send of #${item.seq} failed: ${err.message}; it waits for the next prompt`);
        this.held.push(item);
      });
    }
  }

  // ---- Hooks ----

  /** Answers one hook. Subagents' hooks only count for the status (their context is not the session's). */
  hook(event: HookEvent, input: HookInput): Record<string, unknown> {
    if (event !== "SessionStart") this.lastActivityAt = Date.now();
    if (input.transcript_path && !input.agent_id) this.transcript.follow(input.transcript_path);
    // Up to date before deciding: what is already in the transcript is seen, not resent.
    this.transcript.read();
    const sub = Boolean(input.agent_id);
    switch (event) {
      case "SessionStart":
        // Compaction can happen inside a turn; the other sources start an idle conversation.
        if (input.source === "compact" || sub) return {};
        // A fresh conversation (/clear, resume): whatever was given to the old one but never seen goes to this one.
        for (const [seq, text] of this.onChannel) this.held.push({ text, seq, wake: true });
        this.onChannel.clear();
        this.turnEnded();
        return {};
      case "UserPromptSubmit": {
        this.status.setBusy();
        // Channel events run this hook too (with their text as the prompt), before the transcript has them: what the
        // prompt carries has arrived.
        const prompt = input.prompt ?? "";
        this.seenInTranscript(deliveryHeaderSeqs(prompt));
        // A typed prompt: channel events still missing (lost to a restart, or channels not enabled) go along with it.
        // A channel prompt: the others may follow as their own turn.
        if (!prompt.trimStart().startsWith("<channel")) {
          for (const [seq, text] of this.onChannel) this.held.unshift({ text, seq, wake: true });
          this.onChannel.clear();
        }
        return this.context("UserPromptSubmit");
      }
      case "PreToolUse":
        this.status.setBusy();
        this.status.toolStarted(
          input.tool_use_id ?? `${Date.now()}`,
          input.tool_name ?? "tool",
          sub ? undefined : input.tool_input?.description
        );
        return {};
      case "PostToolUse":
        this.status.toolEnded(input.tool_use_id ?? "");
        return sub ? {} : this.context("PostToolUse");
      case "Stop":
        if (!sub) this.turnEnded();
        return {};
    }
  }

  /** Held messages as additionalContext for `event`; they are seen once in the transcript. */
  private context(event: "UserPromptSubmit" | "PostToolUse"): Record<string, unknown> {
    const text = this.held.take();
    return text ? { hookSpecificOutput: { hookEventName: event, additionalContext: text } } : {};
  }
}
