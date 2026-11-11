// The page's shared mutable state (one object, read and written by every module) and the queries over it.
import { ALL_CONVERSATION_ID, type Conversation, type Message, type Participant } from "@agent-bus/protocol";
import { nameList, sortedUnique } from "./format";

export const UNREAD_ONLY_KEY = "agent-bus.unreadOnly";
/** Show offline agents and the conversations with them (off by default: you cannot write to them anyway). */
export const INCLUDE_OFFLINE_KEY = "agent-bus.includeOffline";

/** Messages per page fetched from a conversation. */
export const PAGE_SIZE = 100;

/** What the main pane shows: an existing conversation, or a not-yet-created group addressed to `to` (ids besides me). */
export type View = { kind: "conversation"; id: string } | { kind: "draft"; to: string[] };

interface MessageCache {
  messages: Message[];
  /** More messages exist before the first loaded one. */
  hasEarlier: boolean;
}

export interface MentionCandidate {
  id: string;
  label: string;
  hint: string;
}

export const state = {
  me: "",
  humans: [] as string[],
  participants: [] as Participant[],
  conversations: new Map<string, Conversation>(),
  caches: new Map<string, MessageCache>(),
  /** Conversations whose first page is being fetched → live messages received meanwhile. */
  loading: new Map<string, Message[]>(),
  unread: new Map<string, number>(),
  /** Unread messages for me: mentioning me, or in a one-to-one/group conversation I am a member of. */
  attention: new Map<string, number>(),
  /** The most important of those: they mention me, or their conversation is just me and one other. */
  urgent: new Map<string, number>(),
  /** Agents whose conversations the sidebar is limited to (all of them must be members). */
  filter: new Set<string>(),
  /** Show only conversations with unread messages (the open one stays). Remembered in this browser. */
  unreadOnly: localStorage.getItem(UNREAD_ONLY_KEY) === "1",
  includeOffline: localStorage.getItem(INCLUDE_OFFLINE_KEY) === "1",
  readAt: {} as Record<string, number>,
  view: { kind: "conversation", id: ALL_CONVERSATION_ID } as View,
  staged: [] as File[],
  /** Message the next send replies to (quotes), in the open conversation. */
  replyTo: undefined as Message | undefined,
  sending: false,
  mention: { open: false, start: 0, items: [] as MentionCandidate[], index: 0 },
};

export function agents(): Participant[] {
  return state.participants
    .filter((p) => p.kind === "agent")
    .sort((a, b) => Number(b.online) - Number(a.online) || a.id.localeCompare(b.id));
}

/** Thread key of a set of ids, as the server computes it: its agents, else (no agent) its humans. */
function threadKey(ids: readonly string[]): string {
  const agentIds = new Set(agents().map((a) => a.id));
  const sorted = sortedUnique(ids);
  const agentsOnly = sorted.filter((id) => agentIds.has(id));
  return (agentsOnly.length > 0 ? agentsOnly : sorted).join(",");
}

/** Existing thread for `ids` (one per set of agents; humans never split a thread). */
export function findGroup(ids: readonly string[]): Conversation | undefined {
  const wanted = threadKey(ids);
  for (const conv of state.conversations.values()) {
    if (conv.kind === "group" && threadKey(conv.members) === wanted) return conv;
  }
  return undefined;
}

export function sortedConversations(): Conversation[] {
  const all = state.conversations.get(ALL_CONVERSATION_ID);
  const groups = Array.from(state.conversations.values())
    .filter((c) => c.kind === "group")
    .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  return all ? [all, ...groups] : groups;
}

/** An agent of this conversation is offline (or no longer on the bus). */
function hasOfflineAgent(conv: Conversation): boolean {
  if (conv.kind === "all") return false;
  return conv.members.some((id) => {
    if (state.humans.includes(id)) return false;
    return !state.participants.find((p) => p.id === id)?.online;
  });
}

/**
 * Agent filter: `@all` always passes, a group when every filtered agent is a member. Unread filter: unread or open.
 * Without "Include offline", conversations with an offline agent are hidden (the open one stays).
 */
export function passesFilter(conv: Conversation): boolean {
  if (state.unreadOnly && (state.unread.get(conv.id) ?? 0) === 0 && !isCurrent(conv.id)) return false;
  if (!state.includeOffline && !isCurrent(conv.id) && hasOfflineAgent(conv)) return false;
  if (conv.kind === "all" || state.filter.size === 0) return true;
  return [...state.filter].every((id) => conv.members.includes(id));
}

export function isCurrent(conversationId: string): boolean {
  return state.view.kind === "conversation" && state.view.id === conversationId;
}

/** Agent whose direct conversation (or draft) is open. */
export function currentDirectAgent(): string | undefined {
  if (state.view.kind === "draft") return state.view.to.length === 1 ? state.view.to[0] : undefined;
  const conv = state.conversations.get(state.view.id);
  if (!conv || conv.kind !== "group") return undefined;
  const agentIds = new Set(agents().map((a) => a.id));
  const convAgents = conv.members.filter((id) => agentIds.has(id));
  return convAgents.length === 1 ? convAgents[0] : undefined;
}

/** "all", or a group's members: everyone but me (all of them if I am not a member). */
export function conversationTitle(conv: Conversation): string {
  if (conv.kind === "all") return "all";
  const ids = conv.members.length > 0 ? conv.members : conv.addressed;
  const others = ids.filter((id) => id !== state.me);
  return nameList(others.length > 0 ? others : ids);
}

export function mergeMessages(a: readonly Message[], b: readonly Message[]): Message[] {
  const bySeq = new Map<number, Message>();
  for (const m of a) bySeq.set(m.seq, m);
  for (const m of b) bySeq.set(m.seq, m);
  return Array.from(bySeq.values()).sort((x, y) => x.seq - y.seq);
}
