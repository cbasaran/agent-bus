import { Database } from "bun:sqlite";
import {
  ALL_CONVERSATION_ID,
  baseAgentId,
  canonicalAddress,
  DEFAULT_AGENT_SETTINGS,
  isJsonObject,
  qualifiedAgentId,
  QUOTE_TEXT_CHARS,
  type AgentIdentity,
  type AgentSettings,
  type Conversation,
  type FileRef,
  type Message,
  type ParticipantKind,
  type Quote,
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
  /** The message this one replies to (same conversation). */
  replyToSeq?: number;
  /** Human messages while authentication is on: written from a signed-in session (true) or not (false). */
  verified?: boolean;
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
  reply_to_seq: number | null;
  verified: number | null;
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

-- Ids of group conversations merged into another (old links keep working).
CREATE TABLE IF NOT EXISTS conversation_aliases (
  old_id TEXT PRIMARY KEY,
  new_id TEXT NOT NULL
);

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

function toMessage(row: MessageRow, receipts: Receipt[], quote: Quote | undefined): Message {
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
    ...(quote ? { quote } : {}),
    ...(row.verified === null || row.verified === undefined ? {} : { verified: row.verified === 1 }),
  };
}

/** `"g_" + sha256(thread key ids joined by ",").hex.slice(0, 12)`, the id of a newly created group. */
export function groupConversationId(keyIds: readonly string[]): string {
  const hex = new Bun.CryptoHasher("sha256").update(keyIds.join(",")).digest("hex");
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
    // Databases created before reply quotes lack the column.
    const messageColumns = this.db.query<{ name: string }, []>("PRAGMA table_info(messages)").all();
    if (!messageColumns.some((c) => c.name === "reply_to_seq")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN reply_to_seq INTEGER");
    }
    // Databases created before human authentication lack the column (null: written while it was off).
    if (!messageColumns.some((c) => c.name === "verified")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN verified INTEGER");
    }
    // Databases created before one-thread-per-agent-set lack the column (filled in by mergeThreads).
    const conversationColumns = this.db.query<{ name: string }, []>("PRAGMA table_info(conversations)").all();
    if (!conversationColumns.some((c) => c.name === "thread_key")) {
      this.db.exec("ALTER TABLE conversations ADD COLUMN thread_key TEXT");
    }
    // Databases created before agent tokens lack the column (null: the agent id is not bound to a token yet).
    const participantColumns = this.db.query<{ name: string }, []>("PRAGMA table_info(participants)").all();
    if (!participantColumns.some((c) => c.name === "token_hash")) {
      this.db.exec("ALTER TABLE participants ADD COLUMN token_hash TEXT");
    }
    this.seed(humans, now);
    this.mergeThreads();
  }

  /**
   * Thread key of an address set (writer included): its agent ids, sorted; the human ids when it has no agent.
   * Humans join and leave the picture by writing, so they never decide which thread a message lands in.
   */
  threadKey(ids: readonly string[]): string {
    const sorted = Array.from(new Set(ids)).sort();
    const agents = this.db
      .query<{ id: string }, [string]>(
        "SELECT id FROM participants WHERE kind = 'agent' AND id IN (SELECT value FROM json_each(?1)) ORDER BY id"
      )
      .all(JSON.stringify(sorted))
      .map((r) => r.id);
    return (agents.length > 0 ? agents : sorted).join(",");
  }

  /**
   * Gives every group its thread key and merges groups that share one into the one with the most messages:
   * messages move, members are united, and the merged ids become aliases. Idempotent; runs at startup.
   */
  private mergeThreads(): void {
    this.db.transaction(() => {
      const groups = this.db
        .query<{ id: string; n: number; last: number }, []>(
          `SELECT c.id, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS n, c.last_message_at AS last
           FROM conversations c WHERE c.kind = 'group' ORDER BY n DESC, last DESC, c.id`
        )
        .all();
      const survivors = new Map<string, string>();
      for (const group of groups) {
        const key = this.threadKey(this.membersOf(group.id));
        const survivor = survivors.get(key);
        if (survivor === undefined) {
          survivors.set(key, group.id);
          this.db.query("UPDATE conversations SET thread_key = ?2 WHERE id = ?1").run(group.id, key);
          continue;
        }
        this.mergeConversation(group.id, survivor);
      }
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS conversations_thread_key ON conversations(thread_key) WHERE kind = 'group'"
      );
    })();
  }

  private mergeConversation(from: string, into: string): void {
    const rows = this.db
      .query<ConversationRow, [string, string]>("SELECT * FROM conversations WHERE id IN (?1, ?2)")
      .all(from, into);
    const source = rows.find((r) => r.id === from);
    const target = rows.find((r) => r.id === into);
    if (!source || !target) return;
    const addressed = Array.from(
      new Set([...parseStringArray(target.addressed_json), ...parseStringArray(source.addressed_json)])
    ).sort();
    this.db.query("UPDATE messages SET conversation_id = ?2 WHERE conversation_id = ?1").run(from, into);
    this.db
      .query(
        `INSERT OR IGNORE INTO conversation_members (conversation_id, participant_id)
         SELECT ?2, participant_id FROM conversation_members WHERE conversation_id = ?1`
      )
      .run(from, into);
    this.db.query("DELETE FROM conversation_members WHERE conversation_id = ?1").run(from);
    this.db
      .query(
        `UPDATE conversations SET addressed_json = ?2, created_at = MIN(created_at, ?3),
           last_message_at = MAX(last_message_at, ?4) WHERE id = ?1`
      )
      .run(into, JSON.stringify(addressed), source.created_at, source.last_message_at);
    this.db.query("DELETE FROM conversations WHERE id = ?1").run(from);
    this.db.query("UPDATE conversation_aliases SET new_id = ?2 WHERE new_id = ?1").run(from, into);
    this.db.query("INSERT OR REPLACE INTO conversation_aliases (old_id, new_id) VALUES (?1, ?2)").run(from, into);
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

  /** Messages `agentId`'s harness accepted since `since` that its model has not seen yet. */
  waitingCount(agentId: string, since: number): number {
    const row = this.db
      .query<{ n: number }, [string, number]>(
        "SELECT COUNT(*) AS n FROM receipts WHERE recipient = ?1 AND delivered_at >= ?2 AND seen_at IS NULL"
      )
      .get(agentId, since);
    return row?.n ?? 0;
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

  /** Creates the built-in agent `id` (no folder, no connection; it writes the server's notices) if missing. */
  ensureBuiltInAgent(id: string, harness: string, now = Date.now()): ParticipantRecord {
    this.db
      .query(
        `INSERT OR IGNORE INTO participants (id, kind, harness, settings_json, created_at, last_seen_at)
         VALUES (?1, 'agent', ?2, ?3, ?4, ?4)`
      )
      .run(id, harness, JSON.stringify(DEFAULT_AGENT_SETTINGS), now);
    return this.getParticipant(id) as ParticipantRecord;
  }

  /** SHA-256 (hex) of the token agent `id` is bound to, or null when it is not bound yet. */
  agentTokenHash(id: string): string | null {
    return this.db.query<{ token_hash: string | null }, [string]>("SELECT token_hash FROM participants WHERE id = ?1").get(id)?.token_hash ?? null;
  }

  /** Binds agent `id` to a token (hash), or unbinds it (null): the next join with any token claims it again. */
  setAgentTokenHash(id: string, tokenHash: string | null): boolean {
    return this.db.query("UPDATE participants SET token_hash = ?2 WHERE id = ?1 AND kind = 'agent'").run(id, tokenHash).changes > 0;
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
   * Agents last seen before `before` (offline since then): their participant row (settings, status) and the receipts
   * addressed to them are deleted. Messages they wrote and their conversations stay, so history reads the same; if
   * the folder joins again it gets an id by the usual rule (the same one when the name is still free).
   */
  forgetAgentsSeenBefore(before: number, keep: ReadonlySet<string>): string[] {
    return this.db.transaction((): string[] => {
      const ids = this.db
        .query<{ id: string }, [number]>("SELECT id FROM participants WHERE kind = 'agent' AND last_seen_at < ?1")
        .all(before)
        .map((r) => r.id)
        .filter((id) => !keep.has(id));
      for (const id of ids) {
        this.db.query("DELETE FROM receipts WHERE recipient = ?1").run(id);
        this.db.query("DELETE FROM participants WHERE id = ?1").run(id);
      }
      return ids;
    })();
  }

  /**
   * Finds or creates the agent for `identity`. A new agent takes its folder name (or name) if free, else
   * `base@<first differing part of its canonical address>` (see `qualifiedAgentId`), else a numeric suffix.
   * Ids held by humans or listed in `reservedIds` count as taken.
   */
  joinAgent(
    identity: AgentIdentity,
    harness: string | null,
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

      const id = this.pickId(identity, reservedIds);
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

  private pickId(identity: AgentIdentity, reservedIds: ReadonlySet<string>): string {
    const taken = (id: string): boolean =>
      id === ALL_CONVERSATION_ID ||
      reservedIds.has(id) ||
      this.db.query<{ id: string }, [string]>("SELECT id FROM participants WHERE id = ?1").get(id) !== null;
    const base = baseAgentId(identity) || "agent";
    if (!taken(base)) return base;
    const holder = this.db
      .query<ParticipantRow, [string]>("SELECT * FROM participants WHERE id = ?1 AND kind = 'agent'")
      .get(base);
    const holderIdentity: AgentIdentity | undefined =
      holder?.host == null
        ? undefined
        : holder.path !== null
          ? { host: holder.host, path: holder.path }
          : { host: holder.host, name: holder.name ?? "" };
    const qualified = qualifiedAgentId(
      base,
      canonicalAddress(identity),
      holderIdentity && canonicalAddress(holderIdentity)
    );
    if (qualified && !taken(qualified)) return qualified;
    const stem = qualified ?? base;
    for (let n = 2; ; n++) {
      const suffix = `-${n}`;
      const id = `${stem.slice(0, MAX_ID_LENGTH - suffix.length)}${suffix}`;
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

  /** The conversation `id`, or the one it was merged into. */
  getConversation(id: string): Conversation | null {
    const alias = this.db
      .query<{ new_id: string }, [string]>("SELECT new_id FROM conversation_aliases WHERE old_id = ?1")
      .get(id);
    const row = this.db
      .query<ConversationRow, [string]>("SELECT * FROM conversations WHERE id = ?1")
      .get(alias?.new_id ?? id);
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
   * The group for an address set (`ids` sorted, unique, writer included): one thread per thread key (its agents,
   * see `threadKey`), created if needed. Humans in `ids` become members, so a human an agent writes to is in it.
   */
  getOrCreateGroup(ids: readonly string[], now = Date.now()): Conversation {
    const key = this.threadKey(ids);
    return this.db.transaction((): Conversation => {
      const addMember = this.db.query(
        "INSERT OR IGNORE INTO conversation_members (conversation_id, participant_id) VALUES (?1, ?2)"
      );
      const existing = this.db
        .query<{ id: string }, [string]>("SELECT id FROM conversations WHERE kind = 'group' AND thread_key = ?1")
        .get(key);
      let id = existing?.id;
      if (id === undefined) {
        const base = groupConversationId(key.split(","));
        id = base;
        const taken = this.db.query<{ id: string }, [string]>(
          "SELECT id FROM conversations WHERE id = ?1 UNION SELECT old_id FROM conversation_aliases WHERE old_id = ?1"
        );
        for (let n = 2; taken.get(id); n++) id = `${base}-${n}`;
        this.db
          .query(
            `INSERT INTO conversations (id, kind, addressed_json, created_at, last_message_at, thread_key)
             VALUES (?1, 'group', ?2, ?3, ?3, ?4)`
          )
          .run(id, JSON.stringify(ids), now, key);
      }
      for (const member of ids) addMember.run(id, member);
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
          `INSERT INTO messages (id, conversation_id, from_id, from_kind, text, files_json, created_at, reply_to_seq, verified)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
        )
        .run(
          id,
          input.conversationId,
          input.from,
          input.fromKind,
          input.text,
          JSON.stringify(input.files),
          input.createdAt,
          input.replyToSeq ?? null,
          input.verified === undefined ? null : input.verified ? 1 : 0
        );
      const seq = Number(result.lastInsertRowid);
      const addReceipt = this.db.query("INSERT INTO receipts (seq, recipient, delivered_at) VALUES (?1, ?2, NULL)");
      for (const recipient of input.recipients) addReceipt.run(seq, recipient);
      this.db
        .query("UPDATE conversations SET last_message_at = MAX(last_message_at, ?2) WHERE id = ?1")
        .run(input.conversationId, input.createdAt);
      const quote = input.replyToSeq === undefined ? undefined : this.quotesFor([input.replyToSeq]).get(input.replyToSeq);
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
        ...(quote ? { quote } : {}),
        ...(input.verified === undefined ? {} : { verified: input.verified }),
      };
    })();
  }

  /** Quotes for the given message seqs (one query). */
  private quotesFor(seqs: number[]): Map<number, Quote> {
    const quotes = new Map<number, Quote>();
    if (seqs.length === 0) return quotes;
    const rows = this.db
      .query<{ seq: number; from_id: string; text: string; files_json: string }, [string]>(
        "SELECT seq, from_id, text, files_json FROM messages WHERE seq IN (SELECT value FROM json_each(?1))"
      )
      .all(JSON.stringify(seqs));
    for (const r of rows) {
      const text = r.text.length > QUOTE_TEXT_CHARS ? `${r.text.slice(0, QUOTE_TEXT_CHARS - 1)}…` : r.text;
      quotes.set(r.seq, { seq: r.seq, from: r.from_id, text, files: parseFiles(r.files_json).length });
    }
    return quotes;
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
    const quotes = this.quotesFor(
      Array.from(new Set(rows.map((r) => r.reply_to_seq).filter((s): s is number => s !== null)))
    );
    return rows.map((row) =>
      toMessage(row, bySeq.get(row.seq) ?? [], row.reply_to_seq === null ? undefined : quotes.get(row.reply_to_seq))
    );
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

  /** Ascending; the newest `limit` messages sent to `agentId` (it has a receipt for them) with `seq > sinceSeq`. */
  inboxFor(agentId: string, sinceSeq: number, limit: number): Message[] {
    const rows = this.db
      .query<MessageRow, [string, number, number]>(
        `SELECT m.* FROM messages m JOIN receipts r ON r.seq = m.seq AND r.recipient = ?1
         WHERE m.seq > ?2 ORDER BY m.seq DESC LIMIT ?3`
      )
      .all(agentId, sinceSeq, limit);
    return this.withReceipts(rows.reverse());
  }

  /**
   * Ascending; the newest `limit` messages whose text contains `query` (case-insensitive; empty matches all),
   * optionally only from `sender`, and only in `conversationIds` unless that is null (everything).
   */
  searchMessages(query: string, sender: string | null, conversationIds: readonly string[] | null, limit: number): Message[] {
    const pattern = `%${query.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = this.db
      .query<MessageRow, [string, string | null, string | null, number]>(
        `SELECT * FROM messages
         WHERE lower(text) LIKE ?1 ESCAPE '\\'
           AND (?2 IS NULL OR from_id = ?2)
           AND (?3 IS NULL OR conversation_id IN (SELECT value FROM json_each(?3)))
         ORDER BY seq DESC LIMIT ?4`
      )
      .all(pattern, sender, conversationIds === null ? null : JSON.stringify(conversationIds), limit);
    return this.withReceipts(rows.reverse());
  }

  /** Ids of `@all` and of every group `participantId` is a member of. */
  conversationIdsOf(participantId: string): string[] {
    const ids = this.db
      .query<{ conversation_id: string }, [string]>("SELECT conversation_id FROM conversation_members WHERE participant_id = ?1")
      .all(participantId)
      .map((r) => r.conversation_id);
    return [ALL_CONVERSATION_ID, ...ids];
  }

  /** The existing group for an address set (writer included), without creating one. */
  findGroup(ids: readonly string[]): Conversation | null {
    const row = this.db
      .query<{ id: string }, [string]>("SELECT id FROM conversations WHERE kind = 'group' AND thread_key = ?1")
      .get(this.threadKey(ids));
    return row ? this.getConversation(row.id) : null;
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
