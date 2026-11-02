import { Database } from "bun:sqlite";
import {
  ALL_CONVERSATION_ID,
  DEFAULT_AGENT_SETTINGS,
  isJsonObject,
  type AgentSettings,
  type Conversation,
  type FileRef,
  type Message,
  type ParticipantKind,
  type Receipt,
} from "@agent-bus/protocol";

/** Stored participant; `online`/`connections` are live state added by the server. */
export interface ParticipantRecord {
  id: string;
  kind: ParticipantKind;
  harness: string | null;
  path: string | null;
  name: string | null;
  host: string | null;
  settings: AgentSettings;
  deliveredSeq: number;
  createdAt: number;
  lastSeenAt: number;
}

/** How an agent identifies itself on join: by project folder or by name, always with its host. */
export type AgentIdentity = { host: string; path: string } | { host: string; name: string };

export interface JoinResult {
  participant: ParticipantRecord;
  /** True when this (host, path|name) had never joined before. */
  isNew: boolean;
}

export interface NewMessage {
  conversationId: string;
  from: string;
  fromKind: ParticipantKind;
  text: string;
  files: FileRef[];
  createdAt: number;
  /** Agent ids the message is sent to (receipts start undelivered). */
  recipients: string[];
}

interface ReceiptRow {
  seq: number;
  recipient: string;
  delivered_at: number | null;
  seen_at: number | null;
}

interface ParticipantRow {
  id: string;
  kind: string;
  harness: string | null;
  path: string | null;
  name: string | null;
  host: string | null;
  settings_json: string;
  delivered_seq: number;
  created_at: number;
  last_seen_at: number;
}

interface ConversationRow {
  id: string;
  kind: string;
  addressed_json: string;
  created_at: number;
  last_message_at: number;
}

interface MessageRow {
  seq: number;
  id: string;
  conversation_id: string;
  from_id: string;
  from_kind: string;
  text: string;
  files_json: string;
  created_at: number;
}

interface FileRow {
  id: string;
  name: string;
  size: number;
  mime_type: string;
  sha256: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('agent', 'human')),
  harness TEXT,
  path TEXT,
  name TEXT,
  host TEXT,
  settings_json TEXT NOT NULL,
  delivered_seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS participants_agent_path
  ON participants(host, path) WHERE kind = 'agent' AND path IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS participants_agent_name
  ON participants(host, name) WHERE kind = 'agent' AND name IS NOT NULL;

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('all', 'group')),
  addressed_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_message_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  participant_id TEXT NOT NULL,
  PRIMARY KEY (conversation_id, participant_id)
);
CREATE INDEX IF NOT EXISTS conversation_members_participant
  ON conversation_members(participant_id);

CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  from_id TEXT NOT NULL,
  from_kind TEXT NOT NULL,
  text TEXT NOT NULL,
  files_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_conversation_seq ON messages(conversation_id, seq);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS receipts (
  seq INTEGER NOT NULL REFERENCES messages(seq),
  recipient TEXT NOT NULL,
  delivered_at INTEGER,
  seen_at INTEGER,
  PRIMARY KEY (seq, recipient)
);
CREATE INDEX IF NOT EXISTS receipts_pending ON receipts(recipient) WHERE delivered_at IS NULL;
`;

/** Highest id an agent may get; matches the address grammar in @agent-bus/protocol. */
const MAX_ID_LENGTH = 48;

function parseSettings(json: string): AgentSettings {
  const parsed: unknown = JSON.parse(json);
  if (isJsonObject(parsed) && (parsed.all === "wake" || parsed.all === "quiet")) {
    return { all: parsed.all };
  }
  return { ...DEFAULT_AGENT_SETTINGS };
}

function parseStringArray(json: string): string[] {
  const parsed: unknown = JSON.parse(json);
  return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
}

function parseFiles(json: string): FileRef[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) return [];
  const out: FileRef[] = [];
  for (const item of parsed) {
    if (
      isJsonObject(item) &&
      typeof item.id === "string" &&
      typeof item.name === "string" &&
      typeof item.size === "number" &&
      typeof item.mimeType === "string" &&
      typeof item.sha256 === "string"
    ) {
      out.push({
        id: item.id,
        name: item.name,
        size: item.size,
        mimeType: item.mimeType,
        sha256: item.sha256,
      });
    }
  }
  return out;
}

function toKind(kind: string): ParticipantKind {
  return kind === "human" ? "human" : "agent";
}

function toParticipant(row: ParticipantRow): ParticipantRecord {
  return {
    id: row.id,
    kind: toKind(row.kind),
    harness: row.harness,
    path: row.path,
    name: row.name,
    host: row.host,
    settings: parseSettings(row.settings_json),
    deliveredSeq: row.delivered_seq,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

function toMessage(row: MessageRow, receipts: Receipt[]): Message {
  return {
    seq: row.seq,
    id: row.id,
    conversationId: row.conversation_id,
    from: row.from_id,
    fromKind: toKind(row.from_kind),
    text: row.text,
    files: parseFiles(row.files_json),
    createdAt: row.created_at,
    receipts,
  };
}

/** `"g_" + sha256(sorted ids joined by ",").hex.slice(0, 12)` */
export function groupConversationId(addressed: readonly string[]): string {
  const hex = new Bun.CryptoHasher("sha256").update(addressed.join(",")).digest("hex");
  return `g_${hex.slice(0, 12)}`;
}

export class BusDatabase {
  readonly db: Database;

  constructor(dbPath: string, humans: readonly string[], now = Date.now()) {
    this.db = new Database(dbPath, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    // Databases created before "seen" receipts lack the column.
    const receiptColumns = this.db.query<{ name: string }, []>("PRAGMA table_info(receipts)").all();
    if (!receiptColumns.some((c) => c.name === "seen_at")) {
      this.db.exec("ALTER TABLE receipts ADD COLUMN seen_at INTEGER");
    }
    this.seed(humans, now);
  }

  close(): void {
    this.db.close();
  }

  private seed(humans: readonly string[], now: number): void {
    this.db
      .query(
        `INSERT OR IGNORE INTO conversations (id, kind, addressed_json, created_at, last_message_at)
         VALUES (?1, 'all', '[]', ?2, ?2)`
      )
      .run(ALL_CONVERSATION_ID, now);
    const insertHuman = this.db.query(
      `INSERT OR IGNORE INTO participants (id, kind, settings_json, created_at, last_seen_at)
       VALUES (?1, 'human', ?2, ?3, ?3)`
    );
    for (const id of humans) {
      insertHuman.run(id, JSON.stringify(DEFAULT_AGENT_SETTINGS), now);
    }
  }

  maxSeq(): number {
    const row = this.db.query<{ seq: number | null }, []>("SELECT MAX(seq) AS seq FROM messages").get();
    return row?.seq ?? 0;
  }

  getParticipant(id: string): ParticipantRecord | null {
    const row = this.db
      .query<ParticipantRow, [string]>("SELECT * FROM participants WHERE id = ?1")
      .get(id);
    return row ? toParticipant(row) : null;
  }

  listParticipants(): ParticipantRecord[] {
    return this.db
      .query<ParticipantRow, []>("SELECT * FROM participants ORDER BY id")
      .all()
      .map(toParticipant);
  }

  listAgents(): ParticipantRecord[] {
    return this.db
      .query<ParticipantRow, []>("SELECT * FROM participants WHERE kind = 'agent' ORDER BY id")
      .all()
      .map(toParticipant);
  }

  /**
   * Deletes agent `id` if it never wrote a message and is a member of no group conversation (e.g. a scratch
   * omp session that joined and left), with its receipts. Returns whether it was deleted. Callers make sure
   * the agent has no live connection.
   */
  removeIfIdle(id: string): boolean {
    return this.db.transaction((): boolean => {
      const idle = this.db
        .query<{ id: string }, [string]>(
          `SELECT id FROM participants p WHERE id = ?1 AND kind = 'agent'
             AND NOT EXISTS (SELECT 1 FROM messages WHERE from_id = p.id)
             AND NOT EXISTS (SELECT 1 FROM conversation_members WHERE participant_id = p.id)`
        )
        .get(id);
      if (!idle) return false;
      this.db.query("DELETE FROM receipts WHERE recipient = ?1").run(id);
      this.db.query("DELETE FROM participants WHERE id = ?1").run(id);
      return true;
    })();
  }

  /**
   * Finds or creates the agent for `identity`. A new agent takes the first candidate id nobody holds
   * (ids held by humans, by other agents, or listed in `reservedIds` are skipped), else
   * `${candidates[0]}-2`, `-3`, ….
   */
  joinAgent(
    identity: AgentIdentity,
    harness: string | null,
    candidates: readonly string[],
    reservedIds: ReadonlySet<string>,
    now = Date.now()
  ): JoinResult {
    return this.db.transaction((): JoinResult => {
      const existing =
        "path" in identity
          ? this.db
              .query<ParticipantRow, [string, string]>(
                "SELECT * FROM participants WHERE kind = 'agent' AND host = ?1 AND path = ?2"
              )
              .get(identity.host, identity.path)
          : this.db
              .query<ParticipantRow, [string, string]>(
                "SELECT * FROM participants WHERE kind = 'agent' AND host = ?1 AND name = ?2"
              )
              .get(identity.host, identity.name);
      if (existing) {
        this.db
          .query("UPDATE participants SET last_seen_at = ?2, harness = COALESCE(?3, harness) WHERE id = ?1")
          .run(existing.id, now, harness);
        return {
          participant: toParticipant({ ...existing, last_seen_at: now, harness: harness ?? existing.harness }),
          isNew: false,
        };
      }

      const id = this.pickFreeId(candidates, reservedIds);
      const deliveredSeq = this.maxSeq();
      this.db
        .query(
          `INSERT INTO participants
             (id, kind, harness, path, name, host, settings_json, delivered_seq, created_at, last_seen_at)
           VALUES (?1, 'agent', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`
        )
        .run(
          id,
          harness,
          "path" in identity ? identity.path : null,
          "name" in identity ? identity.name : null,
          identity.host,
          JSON.stringify(DEFAULT_AGENT_SETTINGS),
          deliveredSeq,
          now
        );
      const created = this.getParticipant(id);
      if (!created) throw new Error(`Failed to create participant ${id}`);
      return { participant: created, isNew: true };
    })();
  }

  private pickFreeId(candidates: readonly string[], reservedIds: ReadonlySet<string>): string {
    const taken = (id: string): boolean =>
      id === ALL_CONVERSATION_ID ||
      reservedIds.has(id) ||
      this.db.query<{ id: string }, [string]>("SELECT id FROM participants WHERE id = ?1").get(id) !== null;
    for (const candidate of candidates) {
      if (!taken(candidate)) return candidate;
    }
    const base = candidates[0] ?? "agent";
    for (let n = 2; ; n++) {
      const suffix = `-${n}`;
      const id = `${base.slice(0, MAX_ID_LENGTH - suffix.length)}${suffix}`;
      if (!taken(id)) return id;
    }
  }

  touchParticipant(id: string, now = Date.now()): void {
    this.db.query("UPDATE participants SET last_seen_at = ?2 WHERE id = ?1").run(id, now);
  }

  ackDelivered(id: string, seq: number): void {
    this.db
      .query("UPDATE participants SET delivered_seq = MAX(delivered_seq, ?2) WHERE id = ?1")
      .run(id, seq);
  }

  setSettings(id: string, settings: AgentSettings): void {
    this.db
      .query("UPDATE participants SET settings_json = ?2 WHERE id = ?1")
      .run(id, JSON.stringify(settings));
  }

  private membersOf(conversationId: string): string[] {
    return this.db
      .query<{ participant_id: string }, [string]>(
        "SELECT participant_id FROM conversation_members WHERE conversation_id = ?1 ORDER BY participant_id"
      )
      .all(conversationId)
      .map((r) => r.participant_id);
  }

  private toConversation(row: ConversationRow, members: string[]): Conversation {
    return {
      id: row.id,
      kind: row.kind === "group" ? "group" : "all",
      addressed: parseStringArray(row.addressed_json),
      members,
      createdAt: row.created_at,
      lastMessageAt: row.last_message_at,
    };
  }

  getConversation(id: string): Conversation | null {
    const row = this.db
      .query<ConversationRow, [string]>("SELECT * FROM conversations WHERE id = ?1")
      .get(id);
    return row ? this.toConversation(row, this.membersOf(row.id)) : null;
  }

  /** `all` first, then groups by lastMessageAt desc. */
  listConversations(): Conversation[] {
    const rows = this.db
      .query<ConversationRow, []>(
        `SELECT * FROM conversations
         ORDER BY (kind = 'all') DESC, last_message_at DESC, id`
      )
      .all();
    const members = new Map<string, string[]>();
    for (const m of this.db
      .query<{ conversation_id: string; participant_id: string }, []>(
        "SELECT conversation_id, participant_id FROM conversation_members ORDER BY participant_id"
      )
      .all()) {
      const list = members.get(m.conversation_id);
      if (list) list.push(m.participant_id);
      else members.set(m.conversation_id, [m.participant_id]);
    }
    return rows.map((row) => this.toConversation(row, members.get(row.id) ?? []));
  }

  /**
   * The group for an address set (`ids` sorted, unique, writer included): the conversation whose members are
   * exactly `ids` (so writing back to everyone in a conversation a human joined lands in it), else the one
   * addressed to `ids`, created if needed. When several conversations have exactly these members, the most
   * recently active wins.
   */
  getOrCreateGroup(ids: readonly string[], now = Date.now()): Conversation {
    const byMembers = this.db
      .query<{ id: string }, [string, number]>(
        `SELECT c.id FROM conversations c
         WHERE c.kind = 'group'
           AND (SELECT COUNT(*) FROM conversation_members m WHERE m.conversation_id = c.id) = ?2
           AND NOT EXISTS (
             SELECT 1 FROM conversation_members m WHERE m.conversation_id = c.id
               AND m.participant_id NOT IN (SELECT value FROM json_each(?1)))
         ORDER BY c.last_message_at DESC LIMIT 1`
      )
      .get(JSON.stringify(ids), ids.length);
    if (byMembers) {
      const existing = this.getConversation(byMembers.id);
      if (existing) return existing;
    }
    const addressed = ids;
    const id = groupConversationId(addressed);
    return this.db.transaction((): Conversation => {
      const inserted = this.db
        .query(
          `INSERT OR IGNORE INTO conversations (id, kind, addressed_json, created_at, last_message_at)
           VALUES (?1, 'group', ?2, ?3, ?3)`
        )
        .run(id, JSON.stringify(addressed), now);
      if (inserted.changes > 0) {
        const addMember = this.db.query(
          "INSERT OR IGNORE INTO conversation_members (conversation_id, participant_id) VALUES (?1, ?2)"
        );
        for (const member of addressed) addMember.run(id, member);
      }
      const conversation = this.getConversation(id);
      if (!conversation) throw new Error(`Failed to create conversation ${id}`);
      return conversation;
    })();
  }

  addMember(conversationId: string, participantId: string): void {
    this.db
      .query("INSERT OR IGNORE INTO conversation_members (conversation_id, participant_id) VALUES (?1, ?2)")
      .run(conversationId, participantId);
  }

  insertMessage(input: NewMessage): Message {
    const id = `m_${crypto.randomUUID().replaceAll("-", "")}`;
    return this.db.transaction((): Message => {
      const result = this.db
        .query(
          `INSERT INTO messages (id, conversation_id, from_id, from_kind, text, files_json, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
        )
        .run(
          id,
          input.conversationId,
          input.from,
          input.fromKind,
          input.text,
          JSON.stringify(input.files),
          input.createdAt
        );
      const seq = Number(result.lastInsertRowid);
      const addReceipt = this.db.query("INSERT INTO receipts (seq, recipient, delivered_at) VALUES (?1, ?2, NULL)");
      for (const recipient of input.recipients) addReceipt.run(seq, recipient);
      this.db
        .query("UPDATE conversations SET last_message_at = MAX(last_message_at, ?2) WHERE id = ?1")
        .run(input.conversationId, input.createdAt);
      return {
        seq,
        id,
        conversationId: input.conversationId,
        from: input.from,
        fromKind: input.fromKind,
        text: input.text,
        files: input.files,
        createdAt: input.createdAt,
        receipts: input.recipients.map((to) => ({ to, deliveredAt: null, seenAt: null })),
      };
    })();
  }

  /** Attaches each row's receipts (one query for the batch). */
  private withReceipts(rows: MessageRow[]): Message[] {
    if (rows.length === 0) return [];
    const bySeq = new Map<number, Receipt[]>();
    const receiptRows = this.db
      .query<ReceiptRow, [string]>(
        `SELECT seq, recipient, delivered_at, seen_at FROM receipts
         WHERE seq IN (SELECT value FROM json_each(?1)) ORDER BY recipient`
      )
      .all(JSON.stringify(rows.map((r) => r.seq)));
    for (const r of receiptRows) {
      let list = bySeq.get(r.seq);
      if (!list) bySeq.set(r.seq, (list = []));
      list.push({ to: r.recipient, deliveredAt: r.delivered_at, seenAt: r.seen_at });
    }
    return rows.map((row) => toMessage(row, bySeq.get(row.seq) ?? []));
  }

  getMessage(seq: number): Message | null {
    const row = this.db.query<MessageRow, [number]>("SELECT * FROM messages WHERE seq = ?1").get(seq);
    return row ? (this.withReceipts([row])[0] ?? null) : null;
  }

  /**
   * Marks `recipient`'s receipt for `seq` delivered (`ack`) or seen (`seen`, which also implies delivered).
   * Returns the receipt when it changed, else null (unknown receipt or already in that state).
   */
  markReceipt(recipient: string, seq: number, state: "ack" | "seen", now = Date.now()): Receipt | null {
    const sql =
      state === "ack"
        ? "UPDATE receipts SET delivered_at = ?3 WHERE seq = ?1 AND recipient = ?2 AND delivered_at IS NULL"
        : `UPDATE receipts SET seen_at = ?3, delivered_at = COALESCE(delivered_at, ?3)
           WHERE seq = ?1 AND recipient = ?2 AND seen_at IS NULL`;
    if (this.db.query(sql).run(seq, recipient, now).changes === 0) return null;
    const row = this.db
      .query<ReceiptRow, [number, string]>("SELECT * FROM receipts WHERE seq = ?1 AND recipient = ?2")
      .get(seq, recipient);
    return row ? { to: row.recipient, deliveredAt: row.delivered_at, seenAt: row.seen_at } : null;
  }

  /** Ascending; the newest `limit` messages with `seq < beforeSeq` (or overall). */
  listMessages(conversationId: string, beforeSeq: number | null, limit: number): Message[] {
    const rows = this.db
      .query<MessageRow, [string, number, number]>(
        `SELECT * FROM messages WHERE conversation_id = ?1 AND seq < ?2
         ORDER BY seq DESC LIMIT ?3`
      )
      .all(conversationId, beforeSeq ?? Number.MAX_SAFE_INTEGER, limit);
    return this.withReceipts(rows.reverse());
  }

  /**
   * Messages for `agentId` not written by it, ascending, newest `limit`: those with an undelivered receipt for it,
   * plus (for messages written before receipts existed) those after `afterSeq` in `all` or in groups whose
   * `addressed` contains it — agents become members only through `addressed`.
   */
  backlogFor(agentId: string, afterSeq: number, limit: number): Message[] {
    const rows = this.db
      .query<MessageRow, [number, string, string, number]>(
        `SELECT * FROM messages
         WHERE from_id != ?2 AND (
           seq IN (SELECT seq FROM receipts WHERE recipient = ?2 AND delivered_at IS NULL)
           OR (seq > ?1
             AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.seq = messages.seq)
             AND (conversation_id = ?3 OR conversation_id IN (
               SELECT conversation_id FROM conversation_members WHERE participant_id = ?2))))
         ORDER BY seq DESC LIMIT ?4`
      )
      .all(afterSeq, agentId, ALL_CONVERSATION_ID, limit);
    return this.withReceipts(rows.reverse());
  }

  insertFile(file: FileRef, uploadedBy: string, now = Date.now()): void {
    this.db
      .query(
        `INSERT INTO files (id, name, size, mime_type, sha256, uploaded_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
      )
      .run(file.id, file.name, file.size, file.mimeType, file.sha256, uploadedBy, now);
  }

  getFile(id: string): FileRef | null {
    const row = this.db
      .query<FileRow, [string]>("SELECT id, name, size, mime_type, sha256 FROM files WHERE id = ?1")
      .get(id);
    return row
      ? { id: row.id, name: row.name, size: row.size, mimeType: row.mime_type, sha256: row.sha256 }
      : null;
  }
}
