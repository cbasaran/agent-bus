// One bus agent per workspace folder (the same identity rule as omp: the folder names the agent). Antigravity runs one
// plugin daemon for the whole app, so the daemon keeps one of these per folder that has a main conversation, and
// bus messages go to the folder's most recently active conversation.
import * as os from "node:os";
import { ActivityLog } from "../../client/src/activity";
import { BusConnection, type Delivery } from "../../client/src/connection";
import { StatusTracker } from "../../client/src/status";
import { BusTool, deliveryText } from "../../client/src/tool";
import type { ReceiptFrame } from "../../protocol/src/types";
import type { AgentApi } from "./antigravity";
import { fullTranscriptPath, TranscriptActivity } from "./transcript";

/** Antigravity's tool hooks carry no call id: the latest PreToolUse names the running tool, kept under this key. */
const RUNNING_TOOL = "tool";

export interface FolderAgentOptions {
  folder: string;
  busUrl: string;
  agentApi: AgentApi;
  log: (line: string) => void;
}

export class FolderAgent {
  readonly folder: string;
  readonly conn: BusConnection;
  readonly tool: BusTool;
  /** The folder's most recently active main conversation: bus messages that wake the agent go there. */
  conversationId: string | undefined;
  private transcriptPath: string | undefined;

  /** The active conversation's full transcript, when known. */
  get transcript(): string | undefined {
    return this.transcriptPath;
  }

  /** Texts for the next model call of any of the folder's conversations: quiet messages, receipt notices, retries. */
  private readonly queued: Array<{ text: string; seq?: number }> = [];
  /** Seqs put into a conversation with agentapi, seen at its next model call. */
  private readonly sentTo = new Map<string, Set<number>>();
  private readonly agentApi: AgentApi;
  private readonly log: (line: string) => void;

  private readonly status: StatusTracker;
  private readonly activityLog: ActivityLog;
  private follower: TranscriptActivity | undefined;
  private watching = false;

  constructor(options: FolderAgentOptions) {
    this.folder = options.folder;
    this.agentApi = options.agentApi;
    this.log = options.log;
    this.status = new StatusTracker(this.log);
    this.activityLog = new ActivityLog((events, replay) => this.conn.sendActivity(events, replay));
    this.conn = new BusConnection({
      url: options.busUrl,
      host: os.hostname(),
      harness: "antigravity",
      path: options.folder,
      onDeliver: (delivery) => this.deliver(delivery),
      onReceipt: (receipt) => this.receipt(receipt),
      onWatch: (on) => this.watch(on),
      onJoined: (id) => this.log(`on the bus as @${id} (${this.folder})`),
      onLog: (line) => this.log(line),
    });
    this.tool = new BusTool(this.conn);
    this.conn.connect();
    this.status.attach(this.conn);
  }

  close(): void {
    this.status.detach();
    this.follower?.stop();
    this.activityLog.dispose();
    this.conn.close();
  }

  // ---- Deliveries ----

  private async deliver(delivery: Delivery): Promise<void> {
    const text = await deliveryText(this.conn, delivery);
    const seq = delivery.message.seq;
    const conversation = this.conversationId;
    if (!delivery.wake || !conversation) {
      this.queued.push({ text, seq });
      return;
    }
    try {
      // Idle: starts a turn. Busy: joins after the current tool call.
      await this.agentApi.sendMessage(conversation, text);
      let seqs = this.sentTo.get(conversation);
      if (!seqs) this.sentTo.set(conversation, (seqs = new Set()));
      seqs.add(seq);
    } catch (err) {
      this.log(`${(err as Error).message}; #${seq} waits for the next model call instead`);
      this.queued.push({ text, seq });
    }
  }

  private receipt(receipt: ReceiptFrame): void {
    const notice = this.tool.receiptNotice(receipt);
    if (notice) this.queued.push({ text: notice });
  }

  /**
   * A model call of `conversationId` is about to run (Antigravity's PreInvocation): what it was sent is now seen,
   * and the queued texts go in with it. Returns those texts, if any.
   */
  beforeModelCall(conversationId: string): string | undefined {
    const sent = this.sentTo.get(conversationId);
    if (sent) {
      for (const seq of sent) this.conn.markSeen(seq);
      this.sentTo.delete(conversationId);
    }
    this.status.setBusy();
    if (this.queued.length === 0) return undefined;
    const taken = this.queued.splice(0);
    for (const item of taken) if (item.seq !== undefined) this.conn.markSeen(item.seq);
    return taken.map((item) => item.text).join("\n\n");
  }

  /** A main conversation of this folder is active: it becomes the one bus messages go to. */
  activate(conversationId: string, transcriptPath: string | undefined): void {
    const changed = conversationId !== this.conversationId;
    this.conversationId = conversationId;
    if (transcriptPath) this.transcriptPath = fullTranscriptPath(transcriptPath);
    if (changed && this.watching) this.follow();
  }

  // ---- Status (website, GET /api/state) ----

  toolStarted(name: string, summary: unknown): void {
    this.status.setBusy();
    this.status.toolStarted(RUNNING_TOOL, name, summary);
  }

  toolEnded(): void {
    this.status.toolEnded(RUNNING_TOOL);
  }

  /** The conversation's execution loop ended (Antigravity's Stop). */
  stopped(): void {
    this.status.setIdle();
  }

  // ---- Live output (only while someone watches the agent's page) ----

  private watch(on: boolean): void {
    this.watching = on;
    if (!on) {
      this.activityLog.setWatching(false);
      this.follower?.stop();
      this.follower = undefined;
      return;
    }
    if (!this.follower) this.follow();
    // Every new watcher gets the replay.
    this.activityLog.setWatching(true);
  }

  /** Starts following the current conversation's transcript (reading its recent steps first). */
  private follow(): void {
    this.follower?.stop();
    this.follower = undefined;
    if (!this.transcriptPath || !this.conversationId) return;
    this.follower = new TranscriptActivity(this.transcriptPath, this.activityLog, this.conversationId.slice(0, 8));
    this.follower.start();
  }
}
