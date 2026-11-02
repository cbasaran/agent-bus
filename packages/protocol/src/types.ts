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
}

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
  | { type: "error"; error: string };

/** `ack`: the harness accepted delivery `seq` into the session. `seen`: it was handed to the model. */
export type AgentClientFrame = { type: "ack"; seq: number } | { type: "seen"; seq: number };

// ---- Website: WS /ws/viewer ----

export type ViewerServerFrame =
  | { type: "message"; message: Message; conversation: Conversation }
  | { type: "participants"; participants: Participant[] }
  | ReceiptFrame;

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
