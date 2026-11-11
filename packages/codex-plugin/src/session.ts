// One Codex task on the bus. Deliveries are held until a lifecycle hook can add them to model context; an idle task
// gets a wake signal queued into it (`codex queue`), whose turn's hooks then hand the messages over.
import * as os from "node:os";
import { BusConnection, type Delivery } from "../../client/src/connection";
import { HeldQueue, UnseenSeqs } from "../../client/src/held";
import { StatusTracker } from "../../client/src/status";
import { BusTool, deliveryText, type MessageBusToolParams } from "../../client/src/tool";
import { replyAddress, shouldWake } from "../../protocol/src/address";
import { DEFAULT_AGENT_SETTINGS, type ReceiptFrame } from "../../protocol/src/types";
import { isThreadId, LiveOutput } from "./live-output";
import { queueWake } from "./wake";

/** A wake signal waits this long, so a burst needs one and a racing user prompt can take the delivery first. */
const WAKE_DELAY_MS = 150;
/** How long a hook may wait for the startup inbox recovery before it answers without it (offline bus). */
const STARTUP_WAIT_MS = 1000;

/** The MCP tool the plugin's hooks call (Codex hooks of type `mcp_tool`). */
export const HOOK_TOOL = "codex_bus_hook";
export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "Interrupt"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface HookInput {
  session_id?: string;
  transcript_path?: string | null;
  cwd?: string;
  source?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  agent_id?: string;
}

export class CodexSession {
  readonly conn: BusConnection;
  readonly tool: BusTool;
  private readonly unseen = new UnseenSeqs((seq) => this.conn.markSeen(seq));
  private readonly held = new HeldQueue(this.unseen);
  private readonly status: StatusTracker;
  private readonly startup = Promise.withResolvers<void>();
  private restoring = false;
  /** Seqs recovered from the inbox at startup: their live delivery (a replay) is not held twice. */
  private readonly restored = new Set<number>();
  private startupWait?: Promise<void>;
  private threadId?: string;
  private wakeTimer?: ReturnType<typeof setTimeout>;
  private wakePending = false;
  private closed = false;
  private readonly live = new LiveOutput((events, replay) => this.conn.sendActivity(events, replay));

  constructor(
    readonly folder: string,
    busUrl: string,
    private readonly log: (line: string) => void = () => {},
    private readonly wake: (threadId: string) => Promise<void> = queueWake
  ) {
    this.status = new StatusTracker(log);
    this.conn = new BusConnection({
      url: busUrl,
      host: os.hostname(),
      harness: "codex",
      path: folder,
      onDeliver: async (delivery) => {
        await this.startup.promise;
        if (!this.restored.delete(delivery.message.seq)) await this.deliver(delivery);
      },
      onReceipt: (receipt) => this.receipt(receipt),
      onWatch: (on) => this.live.watch(on),
      onJoined: (id) => {
        this.log(`on the bus as @${id} (${folder})`);
        if (!this.restoring) {
          this.restoring = true;
          void this.restoreHeld(id)
            .catch((err) => this.log(`restore inbox: ${err}`))
            .finally(() => this.startup.resolve());
        }
      },
      onLog: this.log,
    });
    this.tool = new BusTool(this.conn);
    this.conn.connect();
    this.status.attach(this.conn);
  }

  /** Lets the first prompt include an old queued delivery, without stalling hooks when the bus is offline. */
  waitForStartup(): Promise<void> {
    return (this.startupWait ??= new Promise((resolve) => {
      const timer = setTimeout(resolve, STARTUP_WAIT_MS);
      void this.startup.promise.then(() => {
        clearTimeout(timer);
        resolve();
      });
    }));
  }

  close(): void {
    this.closed = true;
    this.live.watch(false);
    clearTimeout(this.wakeTimer);
    this.status.detach();
    this.conn.close();
  }

  // The bus replays unacknowledged deliveries. Recover the complementary case on restart:
  // a previous process queued and acknowledged the delivery, but no hook ever handed it over.
  private async restoreHeld(id: string): Promise<void> {
    const { messages, conversations } = await this.conn.inbox(0, 100);
    const settings = this.conn.participants.find((participant) => participant.id === id)?.settings ?? DEFAULT_AGENT_SETTINGS;
    for (const message of messages) {
      const receipt = message.receipts.find((r) => r.to === id);
      if (!receipt?.deliveredAt || receipt.seenAt !== null) continue;
      const conversation = conversations.find((c) => c.id === message.conversationId);
      if (!conversation) continue;
      await this.deliver({
        type: "deliver",
        message,
        conversation,
        replyTo: replyAddress(conversation, id),
        wake: shouldWake(conversation.kind, message.fromKind, settings),
      });
      this.restored.add(message.seq);
    }
  }

  runTool(params: MessageBusToolParams): Promise<string> {
    if (!this.conn.id) throw new Error("Not connected to the message bus yet (still trying).");
    return this.tool.run(params, this.folder);
  }

  private async deliver(delivery: Delivery): Promise<void> {
    const text = await deliveryText(this.conn, delivery);
    this.unseen.add(delivery.message.seq);
    this.held.push({ text, seq: delivery.message.seq, wake: delivery.wake });
    if (delivery.wake) this.scheduleWake();
  }

  private scheduleWake(): void {
    const id = this.threadId;
    if (!id || this.closed || this.status.busy || this.wakePending || this.wakeTimer) return;
    // Coalesce a burst and allow a racing user prompt to consume the delivery first.
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      if (this.status.busy || !this.held.hasWake()) return;
      this.wakePending = true;
      void this.wake(id).catch((err) => {
        this.wakePending = false;
        this.log(`could not queue idle wake for ${id}; messages remain queued: ${err.message ?? err}`);
      });
    }, WAKE_DELAY_MS);
  }

  private receipt(receipt: ReceiptFrame): void {
    const text = this.tool.receiptNotice(receipt);
    if (text) this.held.push({ text, wake: false });
  }

  /** Binds this session to Codex task `id` (once; another id is refused) and follows its transcript. */
  bindTask(id: string, transcript: unknown): boolean {
    if (!isThreadId(id) || (this.threadId && this.threadId !== id)) return false;
    this.threadId = id;
    this.live.bind(id, transcript);
    return true;
  }

  hook(event: HookEvent, input: HookInput): Record<string, unknown> {
    const sub = Boolean(input.agent_id);
    if (!sub && typeof input.session_id === "string") {
      // Bind once from Codex hook metadata, never a folder name or a field in a bus message.
      if (!this.bindTask(input.session_id, input.transcript_path)) return {};
    }
    switch (event) {
      case "SessionStart":
        if (sub) return {};
        if (input.source !== "compact") this.setIdle();
        return this.context("SessionStart");
      case "UserPromptSubmit":
        this.status.setBusy();
        return sub ? {} : this.context("UserPromptSubmit");
      case "PreToolUse":
        this.status.setBusy();
        this.status.toolStarted(input.tool_use_id ?? `${Date.now()}`, input.tool_name ?? "tool");
        return {};
      case "PostToolUse":
        this.status.toolEnded(input.tool_use_id ?? "");
        return sub ? {} : this.context("PostToolUse");
      case "Interrupt":
        if (!sub) {
          this.setIdle();
          if (this.held.hasWake()) this.scheduleWake();
        }
        return {};
      case "Stop": {
        if (sub) return {};
        if (!this.held.hasWake()) {
          this.setIdle();
          return {};
        }
        const text = this.held.take();
        // Codex passes the blocking reason to the model as the continuation prompt.
        return text ? { decision: "block", reason: text } : {};
      }
    }
  }

  private context(event: "SessionStart" | "UserPromptSubmit" | "PostToolUse"): Record<string, unknown> {
    const text = this.held.take();
    return text ? { hookSpecificOutput: { hookEventName: event, additionalContext: text } } : {};
  }

  private setIdle(): void {
    this.wakePending = false;
    this.status.setIdle();
  }
}
