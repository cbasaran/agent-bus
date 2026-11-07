export const PROTOCOL_VERSION = "2.0.0";
export const DEFAULT_BUS_PORT = 7800;
/** The single conversation every agent receives. */
export const ALL_CONVERSATION_ID = "all";

export type ParticipantKind = "agent" | "human";

/** Per-agent settings, changed by the agent with `set(key, value)`. */
export interface AgentSettings {
  /**
   * How `@all` messages written by other agents reach this agent:
   * "quiet" (default) = added to the conversation at its next turn without starting one;
   * "wake" = like any other message. `@all` from humans always behaves like a composer message.
   */
  all: "wake" | "quiet";
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = { all: "quiet" };

export interface Participant {
  /** Stable id: omp agents derive it from their project folder, harnesses without one (Hermes) join by name; tied to host+path or host+name, not to the session. Humans are configured ("can", "umit"). */
  id: string;
  kind: ParticipantKind;
  /** Agents: harness that joined ("omp", "hermes", …), for display. */
  harness?: string;
  /** Agents that joined by project folder: absolute project path. */
  path?: string;
  /** Agents: hostname of the machine the agent runs on. */
  host?: string;
  /** Agents: at least one live connection. Humans: always false. */
  online: boolean;
  /** Live agent connections; the same folder open in two omp sessions counts 2. */
  connections: number;
  lastSeenAt: number;
  settings: AgentSettings;
  /** Agents: what the harness reports about itself, while connected (omp only today). */
  status?: AgentStatus;
  /** Agents: messages delivered to its session but not yet seen by its model. */
  waiting?: number;
}

/** An agent's own report of what it is doing; sent by the harness, never costs a model turn. */
export interface AgentStatus {
  state: "idle" | "busy";
  /** When it entered `state`. */
  since: number;
  /** Tool running right now (the oldest when several run), and since when. */
  tool?: string;
  toolSince?: number;
  /** The agent's one-line intent for its latest tool call (omp shows it as "⎋ …"). */
  activity?: string;
}

export interface Conversation {
  /** "all" or "g_<12 hex>". */
  id: string;
  kind: "all" | "group";
  /** Groups: the sorted ids the conversation was addressed to (writer included). Identity of the group; "all": []. */
  addressed: string[];
  /** Groups: `addressed` plus humans who have written in it. "all": []. */
  members: string[];
  createdAt: number;
  lastMessageAt: number;
}

export interface FileRef {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  sha256: string;
}

export interface Message {
  /** Global, monotonic. */
  seq: number;
  id: string;
  conversationId: string;
  from: string;
  fromKind: ParticipantKind;
  text: string;
  files: FileRef[];
  createdAt: number;
  /**
   * One entry per agent the message was sent to (fixed when it is written; never the writer, never humans).
   * Empty for messages written before receipts existed.
   */
  receipts: Receipt[];
  /** Set when the message was written as a reply to message `quote.seq` (same conversation). */
  quote?: Quote;
}

/** The message a reply answers: who wrote it and the start of its text (QUOTE_TEXT_CHARS). */
export interface Quote {
  seq: number;
  from: string;
  text: string;
  /** Number of files the quoted message carried. */
  files: number;
}

export const QUOTE_TEXT_CHARS = 280;

export interface Receipt {
  to: string;
  /** The recipient's harness accepted the message into its session (queued, or started a turn). */
  deliveredAt: number | null;
  /** The message was in a request to the recipient's model, i.e. the agent has it in front of it. Implies delivered. */
  seenAt: number | null;
}

/** Sent to viewers, and to the writer's own agent connections, whenever a receipt changes. */
export interface ReceiptFrame {
  type: "receipt";
  seq: number;
  conversationId: string;
  to: string;
  deliveredAt: number;
  seenAt: number | null;
}

// ---- Agent connection: WS /ws/agent?host=<hostname>&harness=<omp|hermes|…>&path=<abs project path>  (or &name=<id> instead of path) ----

export type AgentServerFrame =
  | { type: "joined"; id: string; participants: Participant[] }
  | {
      type: "deliver";
      message: Message;
      conversation: Conversation;
      /** Address the recipient writes to for replying into the same conversation ("@all", "@id", "@{a,b}"). */
      replyTo: string;
      /** false = deliver quietly (no new turn); see AgentSettings.all. */
      wake: boolean;
    }
  | { type: "participants"; participants: Participant[] }
  | ReceiptFrame
  /** Someone is (on) or is no longer (off) watching this agent's live output; stream `activity` only while on. */
  | { type: "watch"; on: boolean }
  | { type: "error"; error: string };

/**
 * One entry of an agent's live output, as its harness reports it. Entries are upserts: a later event with the
 * same `id` replaces the earlier one (streaming text grows, a tool goes from running to done).
 */
export type ActivityEvent =
  /** A prompt reaching the model: typed by the operator, or a bus delivery. */
  | { id: string; at: number; kind: "user"; text: string }
  /** `thinking`: the model's (summarized) thoughts in that message, when the provider returns them. */
  | { id: string; at: number; kind: "assistant"; text: string; thinking?: string; done: boolean }
  | {
      id: string;
      at: number;
      kind: "tool";
      name: string;
      intent?: string;
      /** The command or arguments, shortened. */
      input: string;
      /** The output so far (its tail when long). */
      output: string;
      state: "running" | "done" | "error";
    };

/**
 * `ack`: the harness accepted delivery `seq` into the session. `seen`: it was handed to the model. `status`: what the
 * agent is doing. `activity`: live output while watched (`replay`: the recent entries sent when watching starts).
 */
export type AgentClientFrame =
  | { type: "ack"; seq: number }
  | { type: "seen"; seq: number }
  | { type: "status"; status: AgentStatus }
  | { type: "activity"; events: ActivityEvent[]; replay?: boolean };

// ---- Website: WS /ws/viewer ----

export type ViewerServerFrame =
  | { type: "message"; message: Message; conversation: Conversation }
  | { type: "participants"; participants: Participant[] }
  | ReceiptFrame
  /** Live output of the agent this viewer watches. */
  | { type: "activity"; agentId: string; events: ActivityEvent[]; replay?: boolean };

/** The viewer watches one agent's live output at a time (`agentId: null` stops). */
export type ViewerClientFrame = { type: "watch"; agentId: string | null };

// ---- HTTP ----

export interface StateResponse {
  participants: Participant[];
  conversations: Conversation[];
  /** Configured human ids, for the website's profile picker. */
  humans: string[];
}

export interface MessagesResponse {
  /** Ascending by seq. */
  messages: Message[];
}

/**
 * GET /api/inbox, /api/history, /api/search: messages (ascending by seq) with the conversations they are in.
 * `scope=mine` (default) limits to `@all` and conversations the reader is a member of; `scope=all` reads everything.
 */
export interface ReadResponse {
  messages: Message[];
  conversations: Conversation[];
}

/** POST /api/messages. Exactly one of `to` / `conversationId` / `replyToSeq`. */
export interface PostMessageRequest {
  from: string;
  to?: string;
  conversationId?: string;
  /** Reply into the conversation of message `replyToSeq` (the `#n` in a delivery header). */
  replyToSeq?: number;
  text: string;
  fileIds?: string[];
}

export interface PostMessageResponse {
  message: Message;
  conversation: Conversation;
}

/** POST /api/settings */
export interface SetSettingRequest {
  from: string;
  key: string;
  value: unknown;
}

export interface HealthResponse {
  ok: true;
  version: string;
  uptimeMs: number;
  lanUrls: string[];
}

export interface ErrorResponse {
  error: string;
}
