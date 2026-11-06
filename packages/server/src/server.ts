import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  baseAgentId,
  ALL_CONVERSATION_ID,
  DEFAULT_BUS_PORT,
  isJsonObject,
  parseAddress,
  PROTOCOL_VERSION,
  replyAddress,
  shouldWake,
  slugifyId,
  type AgentServerFrame,
  type Conversation,
  type AgentSettings,
  type AgentStatus,
  type FileRef,
  type HealthResponse,
  type Message,
  type MessagesResponse,
  type ParsedAddress,
  type Participant,
  type PostMessageResponse,
  type StateResponse,
  type Receipt,
  type ReceiptFrame,
  type ViewerServerFrame,
  type AgentIdentity,
} from "@agent-bus/protocol";
import { BusDatabase, type ParticipantRecord } from "./db";
import { resolveLanAddresses } from "./lan";

export interface BusServerOptions {
  host?: string;
  /** 0 picks a free port. */
  port?: number;
  dataDir?: string;
  humans?: string[];
  /**
   * Also serve everything over TLS on a second port (browsers need https for notifications). Agents keep
   * using the plain port. The files are read at startup; a renewed certificate takes effect on restart.
   */
  https?: { port: number; certFile: string; keyFile: string };
}

export interface BusServerHandle {
  url: string;
  port: number;
  lanUrls: string[];
  /** Set when `https` was given. */
  httpsPort?: number;
  httpsLanUrls?: string[];
  dataDir: string;
  dbPath: string;
  stop(): Promise<void>;
}

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_HUMANS = ["can", "umit"];
const MAX_TEXT_LENGTH = 100_000;
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const BACKLOG_LIMIT = 100;
const MAX_RECEIPT_WAIT_MS = 30_000;
const DEFAULT_PAGE = 100;
const MAX_PAGE = 500;
const SETTING_VALUES = ["wake", "quiet"] as const;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

type SocketData =
  | {
      kind: "agent";
      host: string | null;
      path: string | null;
      name: string | null;
      harness: string | null;
      /** Assigned on open; "" until joined. */
      id: string;
      /** Latest status this connection reported, when, and when its first report arrived. */
      status?: AgentStatus;
      statusAt?: number;
      reportingSince?: number;
    }
  | { kind: "viewer" };

type Socket = Bun.ServerWebSocket<SocketData>;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: CORS_HEADERS });
}

function resolveHumans(option: string[] | undefined): string[] {
  const raw = option ?? process.env.BUS_HUMANS?.split(",") ?? DEFAULT_HUMANS;
  const out: string[] = [];
  for (const entry of raw) {
    const id = slugifyId(entry);
    if (id && id !== ALL_CONVERSATION_ID && !out.includes(id)) out.push(id);
  }
  if (out.length === 0) throw new Error(`No valid human ids in ${JSON.stringify(raw)}`);
  return out;
}

function nonEmptyParam(url: URL, key: string): string | null {
  const value = url.searchParams.get(key)?.trim();
  return value ? value : null;
}

/** A valid `status` frame body, trimmed to display sizes; undefined otherwise. */
function parseStatus(raw: unknown): AgentStatus | undefined {
  if (!isJsonObject(raw)) return undefined;
  const { state, since, tool, toolSince, activity } = raw;
  if ((state !== "idle" && state !== "busy") || typeof since !== "number" || !Number.isFinite(since)) return undefined;
  const status: AgentStatus = { state, since };
  if (typeof tool === "string" && tool.length > 0) status.tool = tool.slice(0, 64);
  if (typeof toolSince === "number" && Number.isFinite(toolSince)) status.toolSince = toolSince;
  if (typeof activity === "string" && activity.length > 0) status.activity = activity.slice(0, 200);
  return status;
}

async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "Body must be JSON");
  }
  if (!isJsonObject(body)) throw new HttpError(400, "Body must be a JSON object");
  return body;
}

export function createBusServer(options: BusServerOptions = {}): BusServerHandle {
  const host = options.host ?? DEFAULT_HOST;
  const dataDir = path.resolve(
    options.dataDir ?? process.env.AGENT_BUS_DATA_DIR ?? path.join(homedir(), ".agent-bus")
  );
  const filesDir = path.join(dataDir, "files");
  mkdirSync(filesDir, { recursive: true });
  const dbPath = path.join(dataDir, "message-bus.sqlite");
  const humans = resolveHumans(options.humans);
  const humanSet = new Set(humans);
  const db = new BusDatabase(dbPath, humans);
  // Nobody is connected yet: apply the logoff rule to everyone (also cleans up after a crash).
  for (const agent of db.listAgents()) db.removeIfIdle(agent.id);
  const startedAt = Date.now();

  const packageRoot = path.resolve(import.meta.dir, "..");
  const uiDir = path.join(packageRoot, "ui");
  const publicDir = path.join(packageRoot, "public");

  /** Live agent sockets by participant id. */
  const agentSockets = new Map<string, Set<Socket>>();
  const viewers = new Set<Socket>();
  /** GET /api/messages/:seq?waitMs= callers, resolved once `done` holds for every receipt of the message. */
  const receiptWaiters = new Map<number, Set<{ done: (r: Receipt) => boolean; resolve: () => void }>>();

  /** Status of an agent: a busy connection beats an idle one; among equals, the latest report wins. */
  const statusOf = (id: string): AgentStatus | undefined => {
    let best: { status: AgentStatus; at: number } | undefined;
    for (const ws of agentSockets.get(id) ?? []) {
      const data = ws.data;
      if (data.kind !== "agent" || !data.status) continue;
      const at = data.statusAt ?? 0;
      const busy = data.status.state === "busy";
      const bestBusy = best?.status.state === "busy";
      if (!best || (busy && !bestBusy) || (busy === bestBusy && at > best.at)) best = { status: data.status, at };
    }
    return best?.status;
  };

  /**
   * Messages waiting for an agent's model, counted only since its status-reporting connection joined: a harness
   * that reports status also reports `seen`; older sessions never do, so their deliveries would count forever.
   */
  const waitingOf = (id: string): number | undefined => {
    let since: number | undefined;
    for (const ws of agentSockets.get(id) ?? []) {
      const data = ws.data;
      if (data.kind === "agent" && data.reportingSince !== undefined) {
        since = Math.min(since ?? data.reportingSince, data.reportingSince);
      }
    }
    return since === undefined ? undefined : db.waitingCount(id, since);
  };

  const toParticipant = (record: ParticipantRecord): Participant => {
    const connections = record.kind === "agent" ? (agentSockets.get(record.id)?.size ?? 0) : 0;
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
      const status = statusOf(record.id);
      if (status) participant.status = status;
      const waiting = waitingOf(record.id);
      if (waiting !== undefined) participant.waiting = waiting;
    }
    return participant;
  };

  /** Agents and configured humans; online first, then by id. */
  const listParticipants = (): Participant[] =>
    db
      .listParticipants()
      .filter((p) => p.kind === "agent" || humanSet.has(p.id))
      .map(toParticipant)
      .sort((a, b) => Number(b.online) - Number(a.online) || a.id.localeCompare(b.id));

  /** Status and waiting counts change often; viewers get them coalesced, agents not at all. */
  let viewerParticipantsTimer: Timer | undefined;
  const scheduleViewerParticipants = (): void => {
    if (viewerParticipantsTimer || viewers.size === 0) return;
    viewerParticipantsTimer = setTimeout(() => {
      viewerParticipantsTimer = undefined;
      const frame = JSON.stringify({ type: "participants", participants: listParticipants() });
      for (const ws of viewers) ws.send(frame);
    }, 250);
  };

  /** Returns the participant if `id` may act as a writer: any stored agent or a configured human. */
  const knownParticipant = (id: string): ParticipantRecord | null => {
    const record = db.getParticipant(id);
    if (!record) return null;
    return record.kind === "agent" || humanSet.has(record.id) ? record : null;
  };

  const knownIds = (): string[] =>
    db
      .listParticipants()
      .filter((p) => p.kind === "agent" || humanSet.has(p.id))
      .map((p) => p.id);

  const sendFrame = (ws: Socket, frame: AgentServerFrame | ViewerServerFrame): void => {
    ws.send(JSON.stringify(frame));
  };

  const broadcastParticipants = (): void => {
    const frame = JSON.stringify({ type: "participants", participants: listParticipants() });
    for (const sockets of agentSockets.values()) {
      for (const ws of sockets) ws.send(frame);
    }
    for (const ws of viewers) ws.send(frame);
  };

  const deliverFrame = (
    message: Message,
    conversation: Conversation,
    recipient: ParticipantRecord
  ): AgentServerFrame => ({
    type: "deliver",
    message,
    conversation,
    replyTo: replyAddress(conversation, recipient.id),
    wake: shouldWake(conversation.kind, message.fromKind, recipient.settings),
  });

  /** Agents a new message goes to: every agent for `all`, the addressed agents of a group; never the writer. */
  const recipientsFor = (conversation: Conversation, writerId: string): ParticipantRecord[] =>
    (conversation.kind === "all"
      ? db.listAgents()
      : conversation.addressed
          .map((id) => db.getParticipant(id))
          .filter((p): p is ParticipantRecord => p !== null && p.kind === "agent")
    ).filter((p) => p.id !== writerId);

  const publishMessage = (message: Message, conversation: Conversation): void => {
    for (const { to } of message.receipts) {
      const recipient = db.getParticipant(to);
      const sockets = agentSockets.get(to);
      if (!recipient || !sockets || sockets.size === 0) continue;
      const frame = JSON.stringify(deliverFrame(message, conversation, recipient));
      for (const ws of sockets) ws.send(frame);
    }
    const viewerFrame = JSON.stringify({ type: "message", message, conversation });
    for (const ws of viewers) ws.send(viewerFrame);
  };

  /** Records `agentId`'s ack/seen of `seq` and tells viewers, the writer's agent connections and receipt waiters. */
  const recordReceipt = (agentId: string, seq: number, state: "ack" | "seen"): void => {
    const receipt = db.markReceipt(agentId, seq, state);
    if (!receipt || receipt.deliveredAt === null) return;
    scheduleViewerParticipants();
    const message = db.getMessage(seq);
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
    for (const ws of viewers) ws.send(frame);
    for (const ws of agentSockets.get(message.from) ?? []) ws.send(frame);
    for (const waiter of receiptWaiters.get(seq) ?? []) {
      if (message.receipts.every(waiter.done)) waiter.resolve();
    }
  };

  const handleAgentOpen = (ws: Socket): void => {
    const data = ws.data;
    if (data.kind !== "agent") return;
    const fail = (error: string): void => {
      sendFrame(ws, { type: "error", error });
      ws.close(1008, error.slice(0, 120));
    };
    if (data.host === null) {
      fail("Missing host query parameter");
      return;
    }
    if ((data.path === null) === (data.name === null)) {
      fail("Give exactly one of the path or name query parameters");
      return;
    }
    const identity: AgentIdentity =
      data.path !== null ? { host: data.host, path: data.path } : { host: data.host, name: data.name ?? "" };
    if ("name" in identity && baseAgentId(identity) === "") {
      fail(`Name "${identity.name}" has no usable id characters`);
      return;
    }
    const { participant, isNew } = db.joinAgent(identity, data.harness, humanSet);
    data.id = participant.id;
    let sockets = agentSockets.get(participant.id);
    if (!sockets) {
      sockets = new Set();
      agentSockets.set(participant.id, sockets);
    }
    sockets.add(ws);

    sendFrame(ws, { type: "joined", id: participant.id, participants: listParticipants() });
    if (!isNew) {
      const conversations = new Map<string, Conversation>();
      for (const message of db.backlogFor(participant.id, participant.deliveredSeq, BACKLOG_LIMIT)) {
        let conversation = conversations.get(message.conversationId);
        if (!conversation) {
          conversation = db.getConversation(message.conversationId) ?? undefined;
          if (!conversation) continue;
          conversations.set(conversation.id, conversation);
        }
        sendFrame(ws, deliverFrame(message, conversation, participant));
      }
    }
    broadcastParticipants();
  };

  const handleAgentMessage = (ws: Socket, raw: string | Buffer): void => {
    const data = ws.data;
    if (data.kind !== "agent" || data.id === "") return;
    let frame: unknown;
    try {
      frame = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
    } catch {
      sendFrame(ws, { type: "error", error: "Frames must be JSON" });
      return;
    }
    if (
      isJsonObject(frame) &&
      (frame.type === "ack" || frame.type === "seen") &&
      typeof frame.seq === "number" &&
      Number.isSafeInteger(frame.seq) &&
      frame.seq >= 0
    ) {
      if (frame.type === "ack") db.ackDelivered(data.id, frame.seq);
      recordReceipt(data.id, frame.seq, frame.type);
      return;
    }
    if (isJsonObject(frame) && frame.type === "status") {
      const status = parseStatus(frame.status);
      if (status) {
        data.status = status;
        data.statusAt = Date.now();
        data.reportingSince ??= data.statusAt;
        scheduleViewerParticipants();
        return;
      }
    }
    sendFrame(ws, {
      type: "error",
      error: 'Expected {"type":"ack"|"seen","seq":<integer>} or {"type":"status","status":{state,since,…}}',
    });
  };

  const handleClose = (ws: Socket): void => {
    const data = ws.data;
    if (data.kind === "viewer") {
      viewers.delete(ws);
      return;
    }
    if (data.id === "") return;
    const sockets = agentSockets.get(data.id);
    if (!sockets) return;
    sockets.delete(ws);
    if (sockets.size === 0) {
      agentSockets.delete(data.id);
      // An agent that never took part (no message written, in no group) is forgotten when it logs off.
      if (!db.removeIfIdle(data.id)) db.touchParticipant(data.id);
    } else {
      db.touchParticipant(data.id);
    }
    broadcastParticipants();
  };

  // ---- HTTP handlers ----

  const getState = (): StateResponse => ({
    participants: listParticipants(),
    conversations: db.listConversations(),
    humans,
  });

  const getMessages = (conversationId: string, url: URL): MessagesResponse => {
    const conversation = db.getConversation(conversationId);
    if (!conversation) {
      throw new HttpError(404, `Unknown conversation "${conversationId}"`);
    }
    const parseIntParam = (key: string): number | null => {
      const raw = url.searchParams.get(key);
      if (raw === null || raw === "") return null;
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new HttpError(400, `${key} must be a positive integer`);
      }
      return value;
    };
    const beforeSeq = parseIntParam("beforeSeq");
    const limit = Math.min(parseIntParam("limit") ?? DEFAULT_PAGE, MAX_PAGE);
    return { messages: db.listMessages(conversation.id, beforeSeq, limit) };
  };

  /**
   * The message with its receipts; with `waitMs`, first waits (≤ 30 s) until every recipient has it
   * (`until=delivered`, default) or has seen it (`until=seen`).
   */
  const getMessageReceipts = async (seq: number, url: URL): Promise<{ message: Message }> => {
    const current = db.getMessage(seq);
    if (!current) throw new HttpError(404, `Unknown message ${seq}`);
    const until = url.searchParams.get("until") ?? "delivered";
    if (until !== "delivered" && until !== "seen") throw new HttpError(400, 'until must be "delivered" or "seen"');
    const done = until === "seen" ? (r: Receipt) => r.seenAt !== null : (r: Receipt) => r.deliveredAt !== null;
    const waitMs = Math.min(Math.max(Number(url.searchParams.get("waitMs") ?? 0) || 0, 0), MAX_RECEIPT_WAIT_MS);
    if (waitMs === 0 || current.receipts.every(done)) return { message: current };
    const { promise, resolve } = Promise.withResolvers<void>();
    const waiter = { done, resolve };
    let waiters = receiptWaiters.get(seq);
    if (!waiters) receiptWaiters.set(seq, (waiters = new Set()));
    waiters.add(waiter);
    const timer = setTimeout(resolve, waitMs);
    await promise;
    clearTimeout(timer);
    waiters.delete(waiter);
    if (waiters.size === 0) receiptWaiters.delete(seq);
    const latest = db.getMessage(seq);
    if (!latest) throw new HttpError(404, `Unknown message ${seq}`);
    return { message: latest };
  };

  const postMessage = async (req: Request): Promise<PostMessageResponse> => {
    const body = await readJsonObject(req);
    if (typeof body.from !== "string") throw new HttpError(400, "from must be a participant id");
    const writer = knownParticipant(body.from.trim().toLowerCase());
    if (!writer) {
      throw new HttpError(400, `Unknown participant "${body.from}". Known ids: ${knownIds().join(", ")}`);
    }
    // A reply goes to the conversation of the message it answers (then it is a conversationId post) and quotes it.
    let replyToSeq: number | undefined;
    if (body.replyToSeq !== undefined && body.replyToSeq !== null) {
      if (typeof body.replyToSeq !== "number" || !Number.isSafeInteger(body.replyToSeq)) {
        throw new HttpError(400, "replyToSeq must be a message number");
      }
      if (body.to != null || body.conversationId != null) {
        throw new HttpError(400, "Give exactly one of to, conversationId or replyToSeq");
      }
      const original = db.getMessage(body.replyToSeq);
      if (!original) throw new HttpError(404, `Unknown message #${body.replyToSeq}`);
      body.conversationId = original.conversationId;
      replyToSeq = original.seq;
    }
    const hasTo = body.to !== undefined && body.to !== null;
    const hasConversation = body.conversationId !== undefined && body.conversationId !== null;
    if (hasTo === hasConversation) throw new HttpError(400, "Give exactly one of to, conversationId or replyToSeq");

    const text = body.text ?? "";
    if (typeof text !== "string") throw new HttpError(400, "text must be a string");
    if (text.length > MAX_TEXT_LENGTH) {
      throw new HttpError(400, `text is longer than ${MAX_TEXT_LENGTH} characters`);
    }
    const fileIds = body.fileIds ?? [];
    if (!Array.isArray(fileIds) || !fileIds.every((id): id is string => typeof id === "string")) {
      throw new HttpError(400, "fileIds must be an array of file ids");
    }
    const files: FileRef[] = [];
    for (const fileId of fileIds) {
      const file = db.getFile(fileId);
      if (!file) throw new HttpError(400, `Unknown file "${fileId}"`);
      files.push(file);
    }
    if (text.trim() === "" && files.length === 0) throw new HttpError(400, "text is required");

    const now = Date.now();
    let conversation: Conversation;
    if (hasTo) {
      if (typeof body.to !== "string") throw new HttpError(400, "to must be an address string");
      let parsed: ParsedAddress;
      try {
        parsed = parseAddress(body.to);
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : String(error));
      }
      if (parsed.kind === "all") {
        const all = db.getConversation(ALL_CONVERSATION_ID);
        if (!all) throw new Error("The all conversation is missing");
        conversation = all;
      } else {
        const unknown = parsed.ids.filter((id) => !knownParticipant(id));
        if (unknown.length > 0) {
          throw new HttpError(
            400,
            `Unknown id${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}. Known ids: ${knownIds().join(", ")}`
          );
        }
        const addressed = Array.from(new Set([writer.id, ...parsed.ids])).sort();
        if (addressed.length < 2) throw new HttpError(400, "Cannot write only to yourself");
        conversation = db.getOrCreateGroup(addressed, now);
      }
    } else {
      if (typeof body.conversationId !== "string") throw new HttpError(400, "conversationId must be a string");
      const existing = db.getConversation(body.conversationId);
      if (!existing) throw new HttpError(404, `Unknown conversation "${body.conversationId}"`);
      conversation = existing;
      if (conversation.kind === "group") {
        if (writer.kind === "agent" && !conversation.members.includes(writer.id)) {
          throw new HttpError(403, `${writer.id} is not in conversation ${conversation.id}`);
        }
        if (writer.kind === "human" && !conversation.members.includes(writer.id)) {
          db.addMember(conversation.id, writer.id);
        }
      }
    }

    const message = db.insertMessage({
      conversationId: conversation.id,
      from: writer.id,
      fromKind: writer.kind,
      text,
      files,
      createdAt: now,
      recipients: recipientsFor(conversation, writer.id).map((p) => p.id),
      replyToSeq,
    });
    if (writer.kind === "human") db.touchParticipant(writer.id, now);
    const updated = db.getConversation(conversation.id);
    if (!updated) throw new Error(`Conversation ${conversation.id} vanished`);
    publishMessage(message, updated);
    return { message, conversation: updated };
  };

  const postFile = async (req: Request, url: URL): Promise<{ file: FileRef }> => {
    const from = nonEmptyParam(url, "from");
    if (!from || !knownParticipant(from.toLowerCase())) {
      throw new HttpError(400, `Unknown participant "${from ?? ""}". Known ids: ${knownIds().join(", ")}`);
    }
    const name = nonEmptyParam(url, "name");
    if (!name) throw new HttpError(400, "name query parameter is required");
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > MAX_FILE_BYTES) throw new HttpError(413, "File is larger than 200 MB");
    if (!req.body) throw new HttpError(400, "Body is empty");

    const id = `f_${crypto.randomUUID().replaceAll("-", "")}`;
    const finalPath = path.join(filesDir, id);
    const tempPath = `${finalPath}.part`;
    const hasher = new Bun.CryptoHasher("sha256");
    const writer = Bun.file(tempPath).writer();
    let size = 0;
    const reader = req.body.getReader();
    try {
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        size += chunk.value.byteLength;
        if (size > MAX_FILE_BYTES) throw new HttpError(413, "File is larger than 200 MB");
        hasher.update(chunk.value);
        writer.write(chunk.value);
      }
      await writer.end();
    } catch (error) {
      await writer.end();
      rmSync(tempPath, { force: true });
      throw error;
    }
    renameSync(tempPath, finalPath);
    const file: FileRef = {
      id,
      name: path.basename(name),
      size,
      mimeType: req.headers.get("content-type") || "application/octet-stream",
      sha256: hasher.digest("hex"),
    };
    db.insertFile(file, from.toLowerCase());
    return { file };
  };

  const getFile = (fileId: string): Response => {
    const file = db.getFile(fileId);
    const blobPath = path.join(filesDir, fileId);
    if (!file || !existsSync(blobPath)) throw new HttpError(404, `Unknown file "${fileId}"`);
    return new Response(Bun.file(blobPath), {
      headers: {
        ...CORS_HEADERS,
        "Content-Type": file.mimeType,
        "Content-Length": String(file.size),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      },
    });
  };

  const postSetting = async (req: Request): Promise<{ participant: Participant }> => {
    const body = await readJsonObject(req);
    const participant = typeof body.from === "string" ? db.getParticipant(body.from) : null;
    if (!participant || participant.kind !== "agent") {
      throw new HttpError(400, "from must be an agent id; settings are per agent");
    }
    if (body.key !== "all") {
      throw new HttpError(400, `Unknown setting "${String(body.key)}". Valid keys: all`);
    }
    const value = body.value === "wake" || body.value === "quiet" ? body.value : null;
    if (value === null) {
      throw new HttpError(
        400,
        `Invalid value ${JSON.stringify(body.value)} for "all". Valid values: ${SETTING_VALUES.join(", ")}`
      );
    }
    const settings: AgentSettings = { ...participant.settings, all: value };
    db.setSettings(participant.id, settings);
    broadcastParticipants();
    return { participant: toParticipant({ ...participant, settings }) };
  };

  // ---- Website ----

  const mtime = (file: string): number => (existsSync(file) ? statSync(file).mtimeMs : -1);
  let bundledApp: { mtime: number; code: string } | null = null;

  /** Built `public/<asset>` when it is at least as new as its `ui/` source, else the source. */
  const serveUiAsset = async (asset: "index.html" | "styles.css" | "app.js"): Promise<Response> => {
    const sourceName = asset === "app.js" ? "app.ts" : asset;
    const sourcePath = path.join(uiDir, sourceName);
    const builtPath = path.join(publicDir, asset);
    const sourceMtime = mtime(sourcePath);
    const contentType =
      asset === "app.js"
        ? "application/javascript; charset=utf-8"
        : asset === "index.html"
          ? "text/html; charset=utf-8"
          : "text/css; charset=utf-8";
    const headers = { "Content-Type": contentType, "Cache-Control": "no-cache" };
    if (existsSync(builtPath) && statSync(builtPath).mtimeMs >= sourceMtime) {
      return new Response(Bun.file(builtPath), { headers });
    }
    if (sourceMtime < 0) return json({ error: `Website asset ${asset} not found` }, 404);
    if (asset !== "app.js") return new Response(Bun.file(sourcePath), { headers });
    if (!bundledApp || bundledApp.mtime !== sourceMtime) {
      const result = await Bun.build({ entrypoints: [sourcePath], target: "browser", format: "esm" });
      const output = result.outputs[0];
      if (!result.success || !output) {
        const detail = result.logs.map((log) => log.message).join("; ");
        return json({ error: `Failed to bundle the website: ${detail}` }, 500);
      }
      bundledApp = { mtime: sourceMtime, code: await output.text() };
    }
    return new Response(bundledApp.code, { headers });
  };

  const handleApi = async (req: Request, url: URL): Promise<Response> => {
    const { pathname } = url;
    const method = req.method;
    if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (method === "GET" && pathname === "/api/health") {
      const health: HealthResponse = {
        ok: true,
        version: PROTOCOL_VERSION,
        uptimeMs: Date.now() - startedAt,
        lanUrls,
      };
      return json(health);
    }
    if (method === "GET" && pathname === "/api/state") return json(getState());
    const messagesMatch = /^\/api\/conversations\/([^/]+)\/messages$/.exec(pathname);
    if (method === "GET" && messagesMatch?.[1]) {
      return json(getMessages(decodeURIComponent(messagesMatch[1]), url));
    }
    if (method === "POST" && pathname === "/api/messages") return json(await postMessage(req));
    const messageMatch = /^\/api\/messages\/(\d+)$/.exec(pathname);
    if (method === "GET" && messageMatch?.[1]) return json(await getMessageReceipts(Number(messageMatch[1]), url));
    if (method === "POST" && pathname === "/api/files") return json(await postFile(req, url));
    const fileMatch = /^\/api\/files\/([^/]+)$/.exec(pathname);
    if (method === "GET" && fileMatch?.[1]) return getFile(decodeURIComponent(fileMatch[1]));
    if (method === "POST" && pathname === "/api/settings") return json(await postSetting(req));
    return json({ error: `No route for ${method} ${pathname}` }, 404);
  };

  let lanUrls: string[] = [];

  const listen = (listenPort: number, tls?: { cert: Bun.BunFile; key: Bun.BunFile }): Bun.Server<SocketData> =>
    Bun.serve<SocketData>({
    hostname: host,
    port: listenPort,
    tls,
    // Uploads are streamed and capped at MAX_FILE_BYTES in postFile; leave headroom for the cap check.
    maxRequestBodySize: MAX_FILE_BYTES + 1024 * 1024,
    // Bun closes requests idle for 10 s by default, which would cut GET /api/messages/:seq?waitMs= short.
    idleTimeout: MAX_RECEIPT_WAIT_MS / 1000 + 10,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const { pathname } = url;
      if (pathname === "/ws/agent") {
        const data: SocketData = {
          kind: "agent",
          host: nonEmptyParam(url, "host"),
          path: nonEmptyParam(url, "path"),
          name: nonEmptyParam(url, "name"),
          harness: nonEmptyParam(url, "harness"),
          id: "",
        };
        if (srv.upgrade(req, { data })) return undefined;
        return json({ error: "Expected a WebSocket upgrade" }, 400);
      }
      if (pathname === "/ws/viewer") {
        if (srv.upgrade(req, { data: { kind: "viewer" } })) return undefined;
        return json({ error: "Expected a WebSocket upgrade" }, 400);
      }
      if (pathname.startsWith("/api/")) {
        try {
          return await handleApi(req, url);
        } catch (error) {
          if (error instanceof HttpError) return json({ error: error.message }, error.status);
          console.error(error);
          return json({ error: error instanceof Error ? error.message : String(error) }, 500);
        }
      }
      if (req.method === "GET") {
        if (pathname === "/" || pathname === "/index.html") return serveUiAsset("index.html");
        if (pathname === "/app.js") return serveUiAsset("app.js");
        if (pathname === "/styles.css") return serveUiAsset("styles.css");
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        if (ws.data.kind === "viewer") {
          viewers.add(ws);
          sendFrame(ws, { type: "participants", participants: listParticipants() });
          return;
        }
        handleAgentOpen(ws);
      },
      message(ws, raw) {
        handleAgentMessage(ws, raw);
      },
      close(ws) {
        handleClose(ws);
      },
    },
  });

  const server = listen(options.port ?? DEFAULT_BUS_PORT);
  const port = server.port;
  if (port === undefined) throw new Error("Server did not bind a port");
  const lan = resolveLanAddresses(port, host);
  lanUrls = lan.lanUrls;

  let secure: Bun.Server<SocketData> | undefined;
  if (options.https) {
    const { certFile, keyFile } = options.https;
    for (const file of [certFile, keyFile]) {
      if (!existsSync(file)) throw new Error(`TLS file not found: ${file}`);
    }
    secure = listen(options.https.port, { cert: Bun.file(certFile), key: Bun.file(keyFile) });
  }
  const httpsPort = secure?.port;

  let stopped = false;
  return {
    url: lan.localUrl,
    port,
    lanUrls,
    httpsPort,
    httpsLanUrls:
      httpsPort === undefined
        ? undefined
        : resolveLanAddresses(httpsPort, host).lanUrls.map((u) => u.replace(/^http:/, "https:")),
    dataDir,
    dbPath,
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const waiters of receiptWaiters.values()) for (const waiter of waiters) waiter.resolve();
      receiptWaiters.clear();
      clearTimeout(viewerParticipantsTimer);
      await Promise.all([server.stop(true), secure?.stop(true)]);
      agentSockets.clear();
      viewers.clear();
      db.close();
    },
  };
}
