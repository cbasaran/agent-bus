// Writing messages (recipients, online-only delivery, replies that quote, the @resources notices) and the website's
// message reads: conversation pages and a message with its receipts.
import {
  ALL_CONVERSATION_ID,
  RESOURCES_AGENT_ID,
  type Conversation,
  type FileRef,
  type Message,
  type MessagesResponse,
  type PostMessageResponse,
  type Receipt,
} from "@agent-bus/protocol";
import type { BusContext } from "./context";
import type { ParticipantRecord } from "./db";
import { HttpError, readJsonObject } from "./http";

const MAX_TEXT_LENGTH = 100_000;
export const MAX_RECEIPT_WAIT_MS = 30_000;
const DEFAULT_PAGE = 100;
const MAX_PAGE = 500;

/** Agents a new message goes to: every agent for `all`, the addressed agents of a group; never the writer. */
function recipientsFor(ctx: BusContext, conversation: Conversation, writerId: string): ParticipantRecord[] {
  return (
    conversation.kind === "all"
      ? ctx.db.listAgents()
      : conversation.addressed
          .map((id) => ctx.db.getParticipant(id))
          .filter((p): p is ParticipantRecord => p !== null && p.kind === "agent")
  ).filter((p) => p.id !== writerId);
}

/**
 * Messages go only to agents that are online now (Can, #4105): a group with an offline agent is refused, also one
 * whose agent was forgotten after a long time offline.
 */
function refuseOffline(ctx: BusContext, ids: readonly string[], writerId: string): void {
  const offline = ids.filter((id) => id !== writerId && !ctx.hub.isHuman(id) && !ctx.hub.isOnline(id));
  if (offline.length === 0) return;
  throw new HttpError(
    409,
    `${offline.map((id) => `@${id}`).join(", ")} ${offline.length > 1 ? "are" : "is"} offline; messages go only to agents that are online. Nothing was sent.`
  );
}

/** POST /api/messages {from, to | conversationId | replyToSeq, text, fileIds?}. */
export async function postMessage(ctx: BusContext, req: Request): Promise<PostMessageResponse> {
  const { db, hub } = ctx;
  const body = await readJsonObject(req);
  if (typeof body.from !== "string") throw new HttpError(400, "from must be a participant id");
  const writer = hub.knownParticipant(body.from.trim().toLowerCase());
  if (!writer) {
    throw new HttpError(400, `Unknown participant "${body.from}". Known ids: ${hub.knownIds().join(", ")}`);
  }
  const verified = ctx.checkWriter(req, writer);
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
    const parsed = ctx.knownAddress(body.to);
    if (parsed.kind === "all") {
      const all = db.getConversation(ALL_CONVERSATION_ID);
      if (!all) throw new Error("The all conversation is missing");
      conversation = all;
    } else {
      const addressed = Array.from(new Set([writer.id, ...parsed.ids])).sort();
      if (addressed.length < 2) throw new HttpError(400, "Cannot write only to yourself");
      refuseOffline(ctx, addressed, writer.id);
      conversation = db.getOrCreateGroup(addressed, now);
    }
  } else {
    if (typeof body.conversationId !== "string") throw new HttpError(400, "conversationId must be a string");
    const existing = db.getConversation(body.conversationId);
    if (!existing) throw new HttpError(404, `Unknown conversation "${body.conversationId}"`);
    conversation = existing;
    if (conversation.kind === "group") {
      refuseOffline(ctx, conversation.addressed, writer.id);
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
    // Only agents connected now: @all skips offline ones (they would wait for it forever, e.g. a test agent
    // that never comes back), and group posts with an offline agent were refused above.
    recipients: recipientsFor(ctx, conversation, writer.id)
      .filter((p) => hub.isOnline(p.id))
      .map((p) => p.id),
    replyToSeq,
    ...(verified === undefined ? {} : { verified }),
  });
  if (writer.kind === "human") db.touchParticipant(writer.id, now);
  const updated = db.getConversation(conversation.id);
  if (!updated) throw new Error(`Conversation ${conversation.id} vanished`);
  hub.publishMessage(message, updated);
  return { message, conversation: updated };
}

/** A notice from @resources to one holder, in their own conversation with it (an agent's turn starts, as for a DM). */
export function postResourcesNotice(ctx: BusContext, holder: string, text: string): void {
  const { db } = ctx;
  const recipient = db.getParticipant(holder);
  if (!recipient) return;
  const writer = db.ensureBuiltInAgent(RESOURCES_AGENT_ID, "bus");
  const now = Date.now();
  const conversation = db.getOrCreateGroup([writer.id, holder], now);
  const message = db.insertMessage({
    conversationId: conversation.id,
    from: writer.id,
    fromKind: "agent",
    text,
    files: [],
    createdAt: now,
    recipients: recipientsFor(ctx, conversation, writer.id).map((p) => p.id),
  });
  ctx.hub.publishMessage(message, db.getConversation(conversation.id) ?? conversation);
}

/** GET /api/conversations/:id/messages?beforeSeq=&limit= (the website's pages). */
export function getMessages(ctx: BusContext, conversationId: string, url: URL): MessagesResponse {
  const conversation = ctx.db.getConversation(conversationId);
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
  return { messages: ctx.db.listMessages(conversation.id, beforeSeq, limit) };
}

/**
 * GET /api/messages/:seq: the message with its receipts and its conversation; with `waitMs`, first waits (≤ 30 s)
 * until every recipient has it (`until=delivered`, default) or has seen it (`until=seen`).
 */
export async function getMessageReceipts(
  ctx: BusContext,
  seq: number,
  url: URL
): Promise<{ message: Message; conversation: Conversation }> {
  const current = ctx.db.getMessage(seq);
  if (!current) throw new HttpError(404, `Unknown message ${seq}`);
  const withConversation = (message: Message): { message: Message; conversation: Conversation } => {
    const conversation = ctx.db.getConversation(message.conversationId);
    if (!conversation) throw new Error(`Conversation ${message.conversationId} of message ${seq} is missing`);
    return { message, conversation };
  };
  const until = url.searchParams.get("until") ?? "delivered";
  if (until !== "delivered" && until !== "seen") throw new HttpError(400, 'until must be "delivered" or "seen"');
  const done = until === "seen" ? (r: Receipt) => r.seenAt !== null : (r: Receipt) => r.deliveredAt !== null;
  const waitMs = Math.min(Math.max(Number(url.searchParams.get("waitMs") ?? 0) || 0, 0), MAX_RECEIPT_WAIT_MS);
  if (waitMs === 0 || current.receipts.every(done)) return withConversation(current);
  await ctx.hub.waitForReceipts(seq, done, waitMs);
  const latest = ctx.db.getMessage(seq);
  if (!latest) throw new HttpError(404, `Unknown message ${seq}`);
  return withConversation(latest);
}
