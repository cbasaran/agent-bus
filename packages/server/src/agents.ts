// Agents and viewers on their sockets (join with the token check, backlog, acks and seen, status, live output),
// agent settings, and forgetting agents that stay offline.
import {
  baseAgentId,
  isJsonObject,
  RESOURCES_AGENT_ID,
  type ActivityEvent,
  type AgentIdentity,
  type AgentSettings,
  type AgentStatus,
  type Conversation,
  type Participant,
} from "@agent-bus/protocol";
import { tokenHash, type BusContext } from "./context";
import { HttpError, readJsonObject } from "./http";
import { sendFrame, type Socket, type SocketData } from "./hub";

const BACKLOG_LIMIT = 100;
const SETTING_VALUES = ["wake", "quiet"] as const;

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

/** The `websocket` handlers of `Bun.serve` for `/ws/agent` and `/ws/viewer`. */
export function socketHandlers(ctx: BusContext): Bun.WebSocketHandler<SocketData> {
  const { db, hub } = ctx;
  /** Ids no agent can take: humans and the built-in @resources. */
  const reservedIds = new Set([...ctx.humans, RESOURCES_AGENT_ID]);

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
    const { participant, isNew } = db.joinAgent(identity, data.harness, reservedIds);
    // An agent id belongs to the first token that joins as it (trust on first use, like ssh host keys).
    const bound = db.agentTokenHash(participant.id);
    const given = data.token ? tokenHash(data.token) : null;
    if (bound !== null && bound !== given) {
      sendFrame(ws, {
        type: "error",
        error: `@${participant.id} is bound to another agent token (another machine or account joined as it first). On the bus's host, \`agent-bus reset-agent ${participant.id}\` frees it.`,
      });
      ws.close(4401, "agent token does not match");
      return;
    }
    if (bound === null && given !== null) db.setAgentTokenHash(participant.id, given);
    data.id = participant.id;
    hub.addAgentSocket(participant.id, ws);

    sendFrame(ws, { type: "joined", id: participant.id, participants: hub.listParticipants() });
    if (hub.isWatched(participant.id)) sendFrame(ws, { type: "watch", on: true });
    if (!isNew) {
      const conversations = new Map<string, Conversation>();
      for (const message of db.backlogFor(participant.id, participant.deliveredSeq, BACKLOG_LIMIT)) {
        let conversation = conversations.get(message.conversationId);
        if (!conversation) {
          conversation = db.getConversation(message.conversationId) ?? undefined;
          if (!conversation) continue;
          conversations.set(conversation.id, conversation);
        }
        sendFrame(ws, hub.deliverFrame(message, conversation, participant));
      }
    }
    hub.broadcastParticipants();
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
      hub.recordReceipt(data.id, frame.seq, frame.type);
      return;
    }
    if (isJsonObject(frame) && frame.type === "status") {
      const status = parseStatus(frame.status);
      if (status) {
        data.status = status;
        data.statusAt = Date.now();
        data.reportingSince ??= data.statusAt;
        hub.scheduleViewerParticipants();
        return;
      }
    }
    if (isJsonObject(frame) && frame.type === "activity" && Array.isArray(frame.events)) {
      // Relayed as is (never stored) to the viewers watching this agent; the website renders it as text only.
      hub.relayActivity({
        type: "activity",
        agentId: data.id,
        events: frame.events as ActivityEvent[],
        ...(frame.replay === true ? { replay: true } : {}),
      });
      return;
    }
    sendFrame(ws, {
      type: "error",
      error: 'Expected {"type":"ack"|"seen","seq":<integer>}, {"type":"status",…} or {"type":"activity",…}',
    });
  };

  const handleViewerMessage = (ws: Socket, raw: string | Buffer): void => {
    let frame: unknown;
    try {
      frame = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
    } catch {
      return;
    }
    if (!isJsonObject(frame) || frame.type !== "watch") return;
    const agentId = typeof frame.agentId === "string" && frame.agentId !== "" ? frame.agentId : undefined;
    hub.setWatching(ws, agentId);
  };

  const handleClose = (ws: Socket): void => {
    const data = ws.data;
    if (data.kind === "viewer") {
      hub.removeViewer(ws);
      return;
    }
    if (data.id === "") return;
    const remaining = hub.removeAgentSocket(data.id, ws);
    if (remaining === undefined) return;
    if (remaining === 0) {
      // An agent that never took part (no message written, in no group) is forgotten when it logs off.
      if (!db.removeIfIdle(data.id)) db.touchParticipant(data.id);
    } else {
      db.touchParticipant(data.id);
    }
    hub.broadcastParticipants();
  };

  return {
    open(ws) {
      if (ws.data.kind === "viewer") hub.addViewer(ws);
      else handleAgentOpen(ws);
    },
    message(ws, raw) {
      if (ws.data.kind === "viewer") handleViewerMessage(ws, raw);
      else handleAgentMessage(ws, raw);
    },
    close(ws) {
      handleClose(ws);
    },
  };
}

/** POST /api/settings {from, key, value}: an agent's own settings. */
export async function postSetting(ctx: BusContext, req: Request): Promise<{ participant: Participant }> {
  const body = await readJsonObject(req);
  const participant = typeof body.from === "string" ? ctx.db.getParticipant(body.from.trim().toLowerCase()) : null;
  if (!participant || participant.kind !== "agent") {
    throw new HttpError(400, "from must be an agent id; settings are per agent");
  }
  ctx.checkWriter(req, participant);
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
  ctx.db.setSettings(participant.id, settings);
  ctx.hub.broadcastParticipants();
  return { participant: ctx.hub.toParticipant({ ...participant, settings }) };
}

/** Forgets agents offline for more than `days` days (0: never): their participant record and pending receipts. */
export function forgetOfflineAgents(ctx: BusContext, days: number): void {
  if (days <= 0) return;
  const keep = new Set([...ctx.hub.onlineAgentIds(), RESOURCES_AGENT_ID]);
  const gone = ctx.db.forgetAgentsSeenBefore(Date.now() - days * 24 * 3600_000, keep);
  if (gone.length === 0) return;
  console.log(`forgot agents offline for more than ${days} days: ${gone.join(", ")}`);
  ctx.hub.broadcastParticipants();
}
