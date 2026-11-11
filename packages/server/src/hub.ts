// The bus's live state: the agents' and viewers' sockets and everything sent over them (participant lists with
// status, deliveries, receipts, live-output watching). Everything else is in the database.
import {
  replyAddress,
  shouldWake,
  type AgentServerFrame,
  type AgentStatus,
  type Conversation,
  type Message,
  type Participant,
  type Receipt,
  type ReceiptFrame,
  type ViewerServerFrame,
} from "@agent-bus/protocol";
import type { BusDatabase, ParticipantRecord } from "./db";

export type SocketData =
  | {
      kind: "agent";
      host: string | null;
      path: string | null;
      name: string | null;
      harness: string | null;
      /** The agent's token (query `token`); binds or must match its id. */
      token: string | null;
      /** Assigned on open; "" until joined. */
      id: string;
      /** Latest status this connection reported, when, and when its first report arrived. */
      status?: AgentStatus;
      statusAt?: number;
      reportingSince?: number;
    }
  | {
      kind: "viewer";
      /** Agent whose live output this viewer watches. */
      watching?: string;
    };

export type Socket = Bun.ServerWebSocket<SocketData>;

export function sendFrame(ws: Socket, frame: AgentServerFrame | ViewerServerFrame): void {
  ws.send(JSON.stringify(frame));
}

type ReceiptWaiter = { done: (r: Receipt) => boolean; resolve: () => void };

export class Hub {
  /** Live agent sockets by participant id. */
  private readonly agentSockets = new Map<string, Set<Socket>>();
  private readonly viewers = new Set<Socket>();
  /** Viewers by the agent they watch; the agent streams while it has at least one. */
  private readonly watchers = new Map<string, Set<Socket>>();
  /** GET /api/messages/:seq?waitMs= callers, resolved once `done` holds for every receipt of the message. */
  private readonly receiptWaiters = new Map<number, Set<ReceiptWaiter>>();
  private viewerParticipantsTimer: Timer | undefined;
  private resourcesTimer: Timer | undefined;

  constructor(
    private readonly db: BusDatabase,
    /** Configured human ids; other stored humans are not participants. */
    private readonly humans: ReadonlySet<string>
  ) {}

  // ---- Participants ----

  /** Returns the participant if `id` may act as a writer: any stored agent or a configured human. */
  knownParticipant(id: string): ParticipantRecord | null {
    const record = this.db.getParticipant(id);
    if (!record) return null;
    return record.kind === "agent" || this.humans.has(record.id) ? record : null;
  }

  knownIds(): string[] {
    return this.knownRecords().map((p) => p.id);
  }

  private knownRecords(): ParticipantRecord[] {
    return this.db.listParticipants().filter((p) => p.kind === "agent" || this.humans.has(p.id));
  }

  isHuman(id: string): boolean {
    return this.humans.has(id);
  }

  isOnline(id: string): boolean {
    return (this.agentSockets.get(id)?.size ?? 0) > 0;
  }

  /** Ids of the agents connected now. */
  onlineAgentIds(): Iterable<string> {
    return this.agentSockets.keys();
  }

  /** Status of an agent: a busy connection beats an idle one; among equals, the latest report wins. */
  private statusOf(id: string): AgentStatus | undefined {
    let best: { status: AgentStatus; at: number } | undefined;
    for (const ws of this.agentSockets.get(id) ?? []) {
      const data = ws.data;
      if (data.kind !== "agent" || !data.status) continue;
      const at = data.statusAt ?? 0;
      const busy = data.status.state === "busy";
      const bestBusy = best?.status.state === "busy";
      if (!best || (busy && !bestBusy) || (busy === bestBusy && at > best.at)) best = { status: data.status, at };
    }
    return best?.status;
  }

  /**
   * Messages waiting for an agent's model, counted only since its status-reporting connection joined: a harness
   * that reports status also reports `seen`; older sessions never do, so their deliveries would count forever.
   */
  private waitingOf(id: string): number | undefined {
    let since: number | undefined;
    for (const ws of this.agentSockets.get(id) ?? []) {
      const data = ws.data;
      if (data.kind === "agent" && data.reportingSince !== undefined) {
        since = Math.min(since ?? data.reportingSince, data.reportingSince);
      }
    }
    return since === undefined ? undefined : this.db.waitingCount(id, since);
  }

  toParticipant(record: ParticipantRecord): Participant {
    const connections = record.kind === "agent" ? (this.agentSockets.get(record.id)?.size ?? 0) : 0;
    const participant: Participant = {
      id: record.id,
      kind: record.kind,
      online: connections > 0,
      connections,
      lastSeenAt: record.lastSeenAt,
      settings: record.settings,
    };
    if (record.harness !== null) participant.harness = record.harness;
    if (record.path !== null) participant.path = record.path;
    if (record.host !== null) participant.host = record.host;
    if (record.kind === "agent") {
      const status = this.statusOf(record.id);
      if (status) participant.status = status;
      const waiting = this.waitingOf(record.id);
      if (waiting !== undefined) participant.waiting = waiting;
    }
    return participant;
  }

  /** Agents and configured humans; online first, then by id. */
  listParticipants(): Participant[] {
    return this.knownRecords()
      .map((record) => this.toParticipant(record))
      .sort((a, b) => Number(b.online) - Number(a.online) || a.id.localeCompare(b.id));
  }

  broadcastParticipants(): void {
    const frame = JSON.stringify({ type: "participants", participants: this.listParticipants() });
    for (const sockets of this.agentSockets.values()) {
      for (const ws of sockets) ws.send(frame);
    }
    for (const ws of this.viewers) ws.send(frame);
  }

  /** Status and waiting counts change often; viewers get them coalesced, agents not at all. */
  scheduleViewerParticipants(): void {
    if (this.viewerParticipantsTimer || this.viewers.size === 0) return;
    this.viewerParticipantsTimer = setTimeout(() => {
      this.viewerParticipantsTimer = undefined;
      const frame = JSON.stringify({ type: "participants", participants: this.listParticipants() });
      for (const ws of this.viewers) ws.send(frame);
    }, 250);
  }

  /** The schedule changed: viewers refetch GET /api/resources (coalesced). */
  resourcesChanged(): void {
    if (this.resourcesTimer || this.viewers.size === 0) return;
    this.resourcesTimer = setTimeout(() => {
      this.resourcesTimer = undefined;
      const frame = JSON.stringify({ type: "resources" } satisfies ViewerServerFrame);
      for (const ws of this.viewers) ws.send(frame);
    }, 250);
  }

  // ---- Sockets ----

  addAgentSocket(id: string, ws: Socket): void {
    let sockets = this.agentSockets.get(id);
    if (!sockets) {
      sockets = new Set();
      this.agentSockets.set(id, sockets);
    }
    sockets.add(ws);
  }

  /** Drops one connection of `id`; returns how many it still has, or undefined when it had none. */
  removeAgentSocket(id: string, ws: Socket): number | undefined {
    const sockets = this.agentSockets.get(id);
    if (!sockets) return undefined;
    sockets.delete(ws);
    if (sockets.size === 0) this.agentSockets.delete(id);
    return sockets.size;
  }

  addViewer(ws: Socket): void {
    this.viewers.add(ws);
    sendFrame(ws, { type: "participants", participants: this.listParticipants() });
  }

  removeViewer(ws: Socket): void {
    this.setWatching(ws, undefined);
    this.viewers.delete(ws);
  }

  // ---- Messages and receipts ----

  deliverFrame(message: Message, conversation: Conversation, recipient: ParticipantRecord): AgentServerFrame {
    return {
      type: "deliver",
      message,
      conversation,
      replyTo: replyAddress(conversation, recipient.id),
      wake: shouldWake(conversation.kind, message.fromKind, recipient.settings),
    };
  }

  /** Delivers a new message to its connected recipients and shows it to the viewers. */
  publishMessage(message: Message, conversation: Conversation): void {
    for (const { to } of message.receipts) {
      const recipient = this.db.getParticipant(to);
      const sockets = this.agentSockets.get(to);
      if (!recipient || !sockets || sockets.size === 0) continue;
      const frame = JSON.stringify(this.deliverFrame(message, conversation, recipient));
      for (const ws of sockets) ws.send(frame);
    }
    const viewerFrame = JSON.stringify({ type: "message", message, conversation });
    for (const ws of this.viewers) ws.send(viewerFrame);
  }

  /** Records `agentId`'s ack/seen of `seq` and tells viewers, the writer's agent connections and receipt waiters. */
  recordReceipt(agentId: string, seq: number, state: "ack" | "seen"): void {
    const receipt = this.db.markReceipt(agentId, seq, state);
    if (!receipt || receipt.deliveredAt === null) return;
    this.scheduleViewerParticipants();
    const message = this.db.getMessage(seq);
    if (!message) return;
    const update: ReceiptFrame = {
      type: "receipt",
      seq,
      conversationId: message.conversationId,
      to: agentId,
      deliveredAt: receipt.deliveredAt,
      seenAt: receipt.seenAt,
    };
    const frame = JSON.stringify(update);
    for (const ws of this.viewers) ws.send(frame);
    for (const ws of this.agentSockets.get(message.from) ?? []) ws.send(frame);
    for (const waiter of this.receiptWaiters.get(seq) ?? []) {
      if (message.receipts.every(waiter.done)) waiter.resolve();
    }
  }

  /** Resolves once `done` holds for every receipt of message `seq` (checked on each receipt), or after `waitMs`. */
  async waitForReceipts(seq: number, done: (r: Receipt) => boolean, waitMs: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const waiter = { done, resolve };
    let waiters = this.receiptWaiters.get(seq);
    if (!waiters) this.receiptWaiters.set(seq, (waiters = new Set()));
    waiters.add(waiter);
    const timer = setTimeout(resolve, waitMs);
    await promise;
    clearTimeout(timer);
    waiters.delete(waiter);
    if (waiters.size === 0) this.receiptWaiters.delete(seq);
  }

  // ---- Live output ----

  isWatched(agentId: string): boolean {
    return this.watchers.has(agentId);
  }

  private sendToAgent(agentId: string, frame: AgentServerFrame): void {
    for (const ws of this.agentSockets.get(agentId) ?? []) sendFrame(ws, frame);
  }

  setWatching(viewer: Socket, agentId: string | undefined): void {
    const data = viewer.data;
    if (data.kind !== "viewer" || data.watching === agentId) return;
    const previous = data.watching;
    if (previous !== undefined) {
      const set = this.watchers.get(previous);
      set?.delete(viewer);
      if (set && set.size === 0) {
        this.watchers.delete(previous);
        this.sendToAgent(previous, { type: "watch", on: false });
      }
    }
    data.watching = agentId;
    if (agentId === undefined) return;
    let set = this.watchers.get(agentId);
    if (!set) {
      set = new Set();
      this.watchers.set(agentId, set);
    }
    set.add(viewer);
    // Sent for every new watcher, not just the first: each one needs the agent's replay of recent entries.
    this.sendToAgent(agentId, { type: "watch", on: true });
  }

  /** Sends an `activity` frame to the viewers watching its agent. */
  relayActivity(frame: Extract<ViewerServerFrame, { type: "activity" }>): void {
    const text = JSON.stringify(frame);
    for (const viewer of this.watchers.get(frame.agentId) ?? []) viewer.send(text);
  }

  // ---- Shutdown ----

  /** Before the servers stop: resolves every receipt waiter and cancels the coalescing timers. */
  stop(): void {
    for (const waiters of this.receiptWaiters.values()) for (const waiter of waiters) waiter.resolve();
    this.receiptWaiters.clear();
    clearTimeout(this.viewerParticipantsTimer);
    clearTimeout(this.resourcesTimer);
  }

  /** After the servers stopped. */
  dropSockets(): void {
    this.agentSockets.clear();
    this.viewers.clear();
  }
}
