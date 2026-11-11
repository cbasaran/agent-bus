// One Codex task on the bus. Deliveries are held until a lifecycle hook can add them to model context.
import * as os from "node:os";
import { BusConnection, type Delivery } from "../../client/src/connection";
import { BusTool, deliveryText, type MessageBusToolParams } from "../../client/src/tool";
import { replyAddress, shouldWake } from "../../protocol/src/address";
import { DEFAULT_AGENT_SETTINGS, type AgentStatus, type ReceiptFrame } from "../../protocol/src/types";
import { queueWake } from "./wake";
import { LiveOutput, isThreadId } from "./live-output";

const STATUS_COALESCE_MS = 250;
const CONTEXT_BUDGET = 9_500;

export const HOOK_TOOL = "codex_bus_hook";
export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "Interrupt"] as const;
export type HookEvent = typeof HOOK_EVENTS[number];
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

interface Held { text: string; seq?: number; wake: boolean }

export class CodexSession {
  readonly conn: BusConnection;
  readonly tool: BusTool;
  private readonly held: Held[] = [];
  private readonly unseen = new Set<number>();
  private busy = false;
  private since = Date.now();
  private readonly runningTools = new Map<string, { name: string; since: number }>();
  private statusTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly startup = Promise.withResolvers<void>();
  private restoring = false;
  private readonly restored = new Set<number>();
  private startupWait?: Promise<void>;
  private threadId?: string;
  private wakeTimer?: ReturnType<typeof setTimeout>;
  private wakePending = false;
  private closed = false;
  private readonly live = new LiveOutput((events, replay) => this.conn.sendActivity(events, replay));

  // Allow the first prompt to include an old queued delivery, without stalling hooks when offline.
  waitForStartup(): Promise<void> {
    return this.startupWait ??= new Promise((resolve) => {
      const timer = setTimeout(resolve, 1000);
      void this.startup.promise.then(() => { clearTimeout(timer); resolve(); });
    });
  }

  constructor(readonly folder: string, busUrl: string, private readonly log: (line: string) => void = () => {},
    private readonly wake: (threadId: string) => Promise<void> = queueWake) {
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
          void this.restoreHeld(id).catch((err) => this.log(`restore inbox: ${err}`)).finally(() => this.startup.resolve());
        }
      },
      onLog: this.log,
    });
    this.tool = new BusTool(this.conn);
    this.conn.connect();
    this.publishStatus();
  }

  close(): void {
    this.closed = true;
    this.live.watch(false);
    clearTimeout(this.wakeTimer);
    clearTimeout(this.statusTimer);
    this.conn.close();
  }

  // The bus replays unacknowledged deliveries. Recover the complementary case on restart:
  // a previous process queued and acknowledged the delivery, but no hook ever handed it over.
  private async restoreHeld(id: string): Promise<void> {
    const { messages, conversations } = await this.conn.inbox(0, 100);
    const settings = this.conn.participants.find((p) => p.id === id)?.settings ?? DEFAULT_AGENT_SETTINGS;
    for (const message of messages) {
      const r = message.receipts.find((r) => r.to === id);
      if (!r?.deliveredAt || r.seenAt !== null) continue;
      const conversation = conversations.find((c) => c.id === message.conversationId);
      if (!conversation) continue;
      await this.deliver({ type: "deliver", message, conversation, replyTo: replyAddress(conversation, id),
        wake: shouldWake(conversation.kind, message.fromKind, settings) });
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
    if (!id || this.closed || this.busy || this.wakePending || this.wakeTimer) return;
    // Coalesce a burst and allow a racing user prompt to consume the delivery first.
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      if (this.busy || !this.held.some((item) => item.wake)) return;
      this.wakePending = true;
      void this.wake(id).catch((err) => {
        this.wakePending = false;
        this.log(`could not queue idle wake for ${id}; messages remain queued: ${err.message ?? err}`);
      });
    }, 150);
  }

  private receipt(receipt: ReceiptFrame): void {
    const text = this.tool.receiptNotice(receipt);
    if (text) this.held.push({ text, wake: false });
  }

  private takeHeld(): string | undefined {
    if (this.held.length === 0) return undefined;
    const parts: string[] = [];
    let size = 0;
    while (this.held.length) {
      const item = this.held[0] as Held;
      let text = item.text;
      if (text.length > CONTEXT_BUDGET) {
        text = `${text.slice(0, CONTEXT_BUDGET - 200)}\n… (cut here; message-bus op=show message_id ${item.seq ?? "?"} for all of it)`;
      }
      if (parts.length && size + text.length > CONTEXT_BUDGET) break;
      this.held.shift();
      if (item.seq !== undefined && this.unseen.delete(item.seq)) this.conn.markSeen(item.seq);
      parts.push(text);
      size += text.length + 2;
    }
    return parts.join("\n\n");
  }

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
      if (!this.bindTask(input.session_id,input.transcript_path)) return {};
    }
    switch (event) {
      case "SessionStart":
        if (sub) return {};
        if (input.source !== "compact") this.setIdle();
        return this.context("SessionStart");
      case "UserPromptSubmit":
        this.setBusy();
        return sub ? {} : this.context("UserPromptSubmit");
      case "PreToolUse":
        this.setBusy();
        this.runningTools.set(input.tool_use_id ?? `${Date.now()}`, { name: input.tool_name ?? "tool", since: Date.now() });
        this.statusChanged();
        return {};
      case "PostToolUse":
        this.runningTools.delete(input.tool_use_id ?? "");
        this.statusChanged();
        return sub ? {} : this.context("PostToolUse");
      case "Interrupt":
        if (!sub) {
          this.setIdle();
          if (this.held.some((item) => item.wake)) this.scheduleWake();
        }
        return {};
      case "Stop": {
        if (sub) return {};
        const shouldWake = this.held.some((item) => item.wake);
        if (!shouldWake) {
          this.setIdle();
          return {};
        }
        const text = this.takeHeld();
        // Codex passes the blocking reason to the model as the continuation prompt.
        return text ? { decision: "block", reason: text } : {};
      }
    }
  }

  private context(event: "SessionStart" | "UserPromptSubmit" | "PostToolUse"): Record<string, unknown> {
    const text = this.takeHeld();
    return text ? { hookSpecificOutput: { hookEventName: event, additionalContext: text } } : {};
  }

  private setBusy(): void {
    if (this.busy) return;
    this.busy = true;
    this.since = Date.now();
    this.statusChanged();
  }

  private setIdle(): void {
    this.wakePending = false;
    this.busy = false;
    this.since = Date.now();
    this.runningTools.clear();
    this.statusChanged();
  }

  private statusChanged(): void {
    if (!this.statusTimer) this.statusTimer = setTimeout(() => this.publishStatus(), STATUS_COALESCE_MS);
  }

  private publishStatus(): void {
    this.statusTimer = undefined;
    const status: AgentStatus = { state: this.busy ? "busy" : "idle", since: this.since };
    const oldest = [...this.runningTools.values()].sort((a, b) => a.since - b.since)[0];
    if (this.busy && oldest) {
      status.tool = oldest.name;
      status.toolSince = oldest.since;
    }
    this.conn.reportStatus(status);
  }
}
