// Unread counts per conversation (from per-profile read markers), and which unread messages are for me.
import { isJsonObject, type Conversation, type Message, type MessagesResponse } from "@agent-bus/protocol";
import { api } from "./api";
import { renderSidebar } from "./sidebar";
import { isCurrent, PAGE_SIZE, state } from "./state";
import { mentionsMe } from "./text";

/** Per-profile read markers: conversation id → createdAt of the newest message read; "*" = first visit. */
const READ_KEY_PREFIX = "agent-bus.read.";

export function loadReadMarkers(): void {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(READ_KEY_PREFIX + state.me) ?? "{}");
    state.readAt = isJsonObject(raw) ? (raw as Record<string, number>) : {};
  } catch {
    state.readAt = {};
  }
}

function saveReadMarkers(): void {
  localStorage.setItem(READ_KEY_PREFIX + state.me, JSON.stringify(state.readAt));
}

/** The conversation is open and the tab is visible. */
export function viewingNow(conversationId: string): boolean {
  return isCurrent(conversationId) && document.visibilityState === "visible";
}

export function markRead(conversationId: string): void {
  state.unread.delete(conversationId);
  state.attention.delete(conversationId);
  state.urgent.delete(conversationId);
  const conv = state.conversations.get(conversationId);
  if (!conv || !state.me || (state.readAt[conversationId] ?? 0) >= conv.lastMessageAt) return;
  state.readAt[conversationId] = conv.lastMessageAt;
  saveReadMarkers();
}

/** Messages that get the red dot and a notification: they mention me, or I am a member of their conversation. */
export function isForMe(message: Message, conv: Conversation): boolean {
  if (!state.me || message.from === state.me) return false;
  return mentionsMe(message.text) || (conv.kind === "group" && conv.members.includes(state.me));
}

/** Messages that get two red dots: they mention me, or their conversation has exactly two members, me included. */
export function isUrgent(message: Message, conv: Conversation): boolean {
  if (!state.me || message.from === state.me) return false;
  return mentionsMe(message.text) || (conv.kind === "group" && conv.members.length === 2 && conv.members.includes(state.me));
}

/** Bumped by every refresh; a refresh whose fetches finish after a newer one started drops its results. */
let refreshGeneration = 0;

/**
 * Recomputes unread counts from the read markers (on boot, reconnect and profile switch). Conversations
 * without a marker count from the first visit; on the very first visit everything existing is read.
 */
export async function refreshUnread(): Promise<void> {
  if (!state.me) return;
  const generation = ++refreshGeneration;
  const firstVisit = state.readAt["*"];
  if (firstVisit === undefined) {
    state.readAt["*"] = Date.now();
    for (const conv of state.conversations.values()) state.readAt[conv.id] = conv.lastMessageAt;
    saveReadMarkers();
  }
  const since = (conv: Conversation): number => state.readAt[conv.id] ?? state.readAt["*"] ?? 0;
  const stale = [...state.conversations.values()].filter((c) => c.lastMessageAt > since(c) && !viewingNow(c.id));
  const counts = await Promise.all(
    stale.map(async (conv) => {
      const res = await api<MessagesResponse>(
        `/api/conversations/${encodeURIComponent(conv.id)}/messages?limit=${PAGE_SIZE}`
      );
      const fresh = res.messages.filter((m) => m.createdAt > since(conv) && m.from !== state.me);
      return {
        conv,
        unread: fresh.length,
        attention: fresh.filter((m) => isForMe(m, conv)).length,
        urgent: fresh.filter((m) => isUrgent(m, conv)).length,
      };
    })
  );
  if (generation !== refreshGeneration) return;
  state.unread.clear();
  state.attention.clear();
  state.urgent.clear();
  for (const { conv, unread, attention, urgent } of counts) {
    if (unread > 0) state.unread.set(conv.id, unread);
    if (attention > 0) state.attention.set(conv.id, attention);
    if (urgent > 0) state.urgent.set(conv.id, urgent);
  }
  if (state.view.kind === "conversation" && viewingNow(state.view.id)) markRead(state.view.id);
  renderSidebar();
}

document.addEventListener("visibilitychange", () => {
  if (state.view.kind !== "conversation" || !viewingNow(state.view.id)) return;
  markRead(state.view.id);
  renderSidebar();
});
