// Harness-neutral client for the message bus: one agent connection (WS /ws/agent) with reconnect,
// in-order delivery handling with acks, receipts for this agent's own messages, and the
// write/send/set calls. Harness bindings decide how a delivery reaches their session.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ActivityEvent,
  AgentClientFrame,
  Conversation,
  ReadResponse,
  AgentStatus,
  AgentServerFrame,
  FileRef,
  Message,
  Participant,
  PostMessageResponse,
  ReceiptFrame,
} from "../../protocol/src/types";
import type { ReservationResponse, ResourcesResponse } from "../../protocol/src/resources";

/**
 * This machine account's agent token (`~/.agent-bus/agent-token`, mode 0600; `AGENT_BUS_TOKEN_FILE` overrides),
 * created on first use. The bus binds an agent id to the first token that joins as it, so nobody else on the
 * network can join or write as that agent. Agents of one account share it (they could read each other's files anyway).
 */
export function agentToken(): string {
  const file = process.env.AGENT_BUS_TOKEN_FILE || path.join(os.homedir(), ".agent-bus", "agent-token");
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    mkdirSync(path.dirname(file), { recursive: true });
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    try {
      writeFileSync(file, `${token}\n`, { mode: 0o600, flag: "wx" });
      return token;
    } catch {
      // Another agent of this account created it at the same moment: use theirs.
      return readFileSync(file, "utf8").trim();
    }
  }
}

export type Delivery = Extract<AgentServerFrame, { type: "deliver" }>;

export interface BusConnectionOptions {
  /** Bus base URL, e.g. http://127.0.0.1:7800 */
  url: string;
  host: string;
  harness: string;
  /** Exactly one of `path` (folder-based harnesses) or `name`. */
  path?: string;
  name?: string;
  /** Called for every delivery, one at a time in seq order; the seq is acked after it resolves. */
  onDeliver: (delivery: Delivery) => Promise<void>;
  onJoined?: (id: string) => void;
  /** A recipient's harness accepted a message this agent wrote. */
  onReceipt?: (receipt: ReceiptFrame) => void;
  /** Someone started (true) or stopped (false) watching this agent's live output on the website. */
  onWatch?: (on: boolean) => void;
  onLog?: (line: string) => void;
  /** The agent token; default this account's (`agentToken()`). */
  token?: string;
}

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/** Upload types by extension (the website previews images and renders markdown); everything else is generic. */
const MIME_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".heic": "image/heic", ".pdf": "application/pdf", ".md": "text/markdown",
  ".markdown": "text/markdown", ".txt": "text/plain", ".log": "text/plain", ".csv": "text/csv", ".json": "application/json",
  ".html": "text/html", ".patch": "text/x-diff", ".diff": "text/x-diff", ".zip": "application/zip",
  ".gz": "application/gzip", ".tar": "application/x-tar", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".mp4": "video/mp4",
};

function mimeType(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export class BusConnection {
  /** Bus id assigned by the server; undefined until the first `joined`. */
  id: string | undefined;
  participants: Participant[] = [];
  private socket: WebSocket | null = null;
  private closed = false;
  private reconnectDelay = RECONNECT_MIN_MS;
  private reconnectTimer: Timer | undefined;
  private deliveryChain: Promise<void> = Promise.resolve();
  /** `seen` reports made while disconnected; sent after the next join. */
  private unsentSeen = new Set<number>();
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(private readonly options: BusConnectionOptions) {
    this.baseUrl = options.url.replace(/\/+$/, "");
    this.token = options.token ?? agentToken();
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN && this.id !== undefined;
  }

  connect(): void {
    if (this.closed) return;
    const wsUrl = new URL(`${this.baseUrl.replace(/^http/, "ws")}/ws/agent`);
    wsUrl.searchParams.set("host", this.options.host);
    wsUrl.searchParams.set("harness", this.options.harness);
    if (this.options.path) wsUrl.searchParams.set("path", this.options.path);
    if (this.options.name) wsUrl.searchParams.set("name", this.options.name);
    wsUrl.searchParams.set("token", this.token);

    const socket = new WebSocket(wsUrl.toString());
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      try {
        this.handleFrame(JSON.parse(String(event.data)) as AgentServerFrame);
      } catch (err) {
        this.log(`bad frame: ${(err as Error).message}`);
      }
    });
    socket.addEventListener("close", (event) => {
      if (this.socket === socket) {
        this.socket = null;
        this.options.onWatch?.(false); // A new connection must receive its own watch request.
      }
      // 4401: the id is bound to another token. Retrying cannot help; the error frame said how to free it.
      if (event.code === 4401) {
        this.closed = true;
        this.log("not on the bus: this agent id belongs to another agent token");
        return;
      }
      this.scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      // "close" follows and schedules the reconnect.
    });
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.socket?.close();
    this.socket = null;
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  private handleFrame(frame: AgentServerFrame): void {
    switch (frame.type) {
      case "joined":
        this.id = frame.id;
        this.participants = frame.participants;
        this.reconnectDelay = RECONNECT_MIN_MS;
        for (const seq of this.unsentSeen) this.markSeen(seq);
        if (this.status) this.sendFrame({ type: "status", status: this.status });
        this.options.onJoined?.(frame.id);
        return;
      case "participants":
        this.participants = frame.participants;
        return;
      case "deliver": {
        const socket = this.socket;
        this.deliveryChain = this.deliveryChain.then(async () => {
          try {
            await this.options.onDeliver(frame);
            const ack: AgentClientFrame = { type: "ack", seq: frame.message.seq };
            if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(ack));
          } catch (err) {
            // Not acked: the server re-sends it as backlog on the next join.
            this.log(`delivery of seq ${frame.message.seq} failed: ${(err as Error).message}`);
          }
        });
        return;
      }
      case "receipt":
        this.options.onReceipt?.(frame);
        return;
      case "watch":
        this.options.onWatch?.(frame.on);
        return;
      case "error":
        this.log(`server: ${frame.error}`);
        return;
    }
  }

  /** Reports that delivery `seq` was handed to the model (queued until reconnected if offline). */
  markSeen(seq: number): void {
    const frame: AgentClientFrame = { type: "seen", seq };
    if (this.socket?.readyState === WebSocket.OPEN && this.id !== undefined) {
      this.socket.send(JSON.stringify(frame));
      this.unsentSeen.delete(seq);
    } else {
      this.unsentSeen.add(seq);
    }
  }

  private status: AgentStatus | undefined;

  /** Reports what this agent is doing (resent after every join). Never reaches a model. */
  reportStatus(status: AgentStatus): void {
    this.status = status;
    this.sendFrame({ type: "status", status });
  }

  /** Live output for watchers; dropped when not connected (a later watch gets a fresh replay). */
  sendActivity(events: ActivityEvent[], replay: boolean): void {
    this.sendFrame({ type: "activity", events, ...(replay ? { replay: true } : {}) });
  }

  private sendFrame(frame: AgentClientFrame): void {
    if (this.socket?.readyState === WebSocket.OPEN && this.id !== undefined) this.socket.send(JSON.stringify(frame));
  }

  private requireId(): string {
    if (!this.connected || !this.id) {
      throw new Error(`Not connected to the message bus at ${this.baseUrl} (it may be down; retrying in the background).`);
    }
    return this.id;
  }

  private async request<T>(pathname: string, init: RequestInit): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("X-Agent-Token", this.token);
    const res = await fetch(`${this.baseUrl}${pathname}`, { ...init, headers });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status} from ${pathname}`);
    return body;
  }

  /** Posts to an address (`{ to: "@x" }`) or into the conversation of a message being answered (`{ replyToSeq }`). */
  write(target: { to: string } | { replyToSeq: number }, text: string, fileIds?: string[]): Promise<PostMessageResponse> {
    const from = this.requireId();
    return this.request<PostMessageResponse>("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from, ...target, text, fileIds }),
    });
  }

  /** Messages sent to this agent (newest `limit`, after `sinceSeq`). Reads only: no turns for anyone. */
  inbox(sinceSeq: number, limit: number): Promise<ReadResponse> {
    const qs = new URLSearchParams({ for: this.requireId(), sinceSeq: String(sinceSeq), limit: String(limit) });
    return this.request<ReadResponse>(`/api/inbox?${qs}`, { method: "GET" });
  }

  /** The newest `limit` messages of a conversation: by address (as this agent would write to it) or id. */
  history(target: { to: string } | { conversationId: string }, limit: number, all: boolean): Promise<ReadResponse> {
    const qs = new URLSearchParams({ from: this.requireId(), ...target, limit: String(limit), scope: all ? "all" : "mine" });
    return this.request<ReadResponse>(`/api/history?${qs}`, { method: "GET" });
  }

  /** Messages whose text contains `q` and/or from `sender`, newest `limit`. */
  search(q: string, sender: string | undefined, limit: number, all: boolean): Promise<ReadResponse> {
    const qs = new URLSearchParams({ from: this.requireId(), q, limit: String(limit), scope: all ? "all" : "mine" });
    if (sender) qs.set("sender", sender);
    return this.request<ReadResponse>(`/api/search?${qs}`, { method: "GET" });
  }

  /** One message by number, with its conversation. */
  message(seq: number): Promise<{ message: Message; conversation: Conversation }> {
    return this.request<{ message: Message; conversation: Conversation }>(`/api/messages/${seq}`, { method: "GET" });
  }

  /** The resource schedule (experimental): resources, reservations, what probes see, warnings. */
  resources(): Promise<ResourcesResponse> {
    return this.request<ResourcesResponse>("/api/resources", { method: "GET" });
  }

  /** A schedule change as this agent: POST /api/reservations, /api/reservations/:id/release or …/extend. */
  schedule(pathname: string, body: Record<string, unknown>): Promise<ReservationResponse> {
    const from = this.requireId();
    return this.request<ReservationResponse>(pathname, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from, ...body }),
    });
  }

  /** The message with its receipts, after waiting up to `waitMs` for every recipient to have seen it. */
  async waitForReceipts(seq: number, waitMs: number): Promise<Message> {
    const res = await this.request<{ message: Message }>(`/api/messages/${seq}?waitMs=${waitMs}&until=seen`, { method: "GET" });
    return res.message;
  }

  async uploadFile(filePath: string): Promise<FileRef> {
    const from = this.requireId();
    let body: Buffer;
    try {
      body = await readFile(filePath);
    } catch {
      throw new Error(`File not found: ${filePath}`);
    }
    const qs = new URLSearchParams({ from, name: path.basename(filePath) });
    const res = await this.request<{ file: FileRef }>(`/api/files?${qs}`, {
      method: "POST",
      headers: { "Content-Type": mimeType(filePath) },
      body: new Uint8Array(body),
    });
    return res.file;
  }

  async downloadFile(ref: FileRef, destDir: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/files/${encodeURIComponent(ref.id)}`);
    if (!res.ok) throw new Error(`Download of ${ref.name} failed: HTTP ${res.status}`);
    const dest = path.join(destDir, `${ref.id}-${ref.name.replace(/[\\/]/g, "_")}`);
    await mkdir(destDir, { recursive: true });
    await writeFile(dest, new Uint8Array(await res.arrayBuffer()));
    return dest;
  }

  set(key: string, value: string): Promise<{ participant: Participant }> {
    const from = this.requireId();
    return this.request<{ participant: Participant }>("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from, key, value }),
    });
  }

  private log(line: string): void {
    this.options.onLog?.(line);
  }
}
