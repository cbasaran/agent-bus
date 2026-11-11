// Loading state and messages from the server, and recording each new message (socket or POST response).
import type { Conversation, Message, MessagesResponse, StateResponse } from "@agent-bus/protocol";
import { api } from "./api";
import { showError } from "./composer";
import { dom, nearBottom, scrollToBottom } from "./dom";
import { errorText } from "./format";
import { notify } from "./notify";
import { renderHeader, renderMessages, showEmpty } from "./render";
import { navigate } from "./routing";
import { renderSidebar } from "./sidebar";
import { findGroup, isCurrent, mergeMessages, PAGE_SIZE, state } from "./state";
import { isForMe, isUrgent, markRead, viewingNow } from "./unread";

export async function loadState(): Promise<void> {
  const res = await api<StateResponse>("/api/state");
  state.humans = res.humans;
  state.participants = res.participants;
  state.conversations = new Map(res.conversations.map((c) => [c.id, c]));
}

export async function loadMessages(conversationId: string): Promise<void> {
  if (state.loading.has(conversationId)) return;
  state.loading.set(conversationId, []);
  try {
    const res = await api<MessagesResponse>(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages?limit=${PAGE_SIZE}`
    );
    // Live frames that arrived while loading are kept alongside the page.
    const live = [...(state.loading.get(conversationId) ?? []), ...(state.caches.get(conversationId)?.messages ?? [])];
    state.caches.set(conversationId, {
      messages: mergeMessages(res.messages, live),
      hasEarlier: res.messages.length >= PAGE_SIZE,
    });
    if (isCurrent(conversationId)) {
      renderMessages();
      scrollToBottom();
    }
  } catch (err) {
    if (isCurrent(conversationId)) {
      showEmpty(`Could not load messages: ${errorText(err)}`);
    }
  } finally {
    state.loading.delete(conversationId);
  }
}

export async function loadEarlier(): Promise<void> {
  if (state.view.kind !== "conversation") return;
  const id = state.view.id;
  const cache = state.caches.get(id);
  const first = cache?.messages[0];
  if (!cache || !first) return;
  dom.loadEarlierBtn.disabled = true;
  try {
    const res = await api<MessagesResponse>(
      `/api/conversations/${encodeURIComponent(id)}/messages?beforeSeq=${first.seq}&limit=${PAGE_SIZE}`
    );
    const previousHeight = dom.messageScroll.scrollHeight;
    cache.messages = mergeMessages(res.messages, cache.messages);
    cache.hasEarlier = res.messages.length >= PAGE_SIZE;
    if (isCurrent(id)) {
      renderMessages();
      dom.messageScroll.scrollTop += dom.messageScroll.scrollHeight - previousHeight;
    }
  } catch (err) {
    showError(`Could not load earlier messages: ${errorText(err)}`);
  } finally {
    dom.loadEarlierBtn.disabled = false;
  }
}

dom.loadEarlierBtn.addEventListener("click", () => void loadEarlier());

/** Records a message (from the viewer socket or a POST response). */
export function receive(message: Message, conversation: Conversation): void {
  state.conversations.set(conversation.id, conversation);
  const cache = state.caches.get(conversation.id);
  const pending = state.loading.get(conversation.id);
  const known = (cache?.messages ?? pending ?? []).some((m) => m.seq === message.seq);
  if (!known) {
    if (cache) cache.messages = mergeMessages(cache.messages, [message]);
    else pending?.push(message);
  }

  if (!known && message.from !== state.me) {
    if (viewingNow(conversation.id)) {
      markRead(conversation.id);
    } else {
      state.unread.set(conversation.id, (state.unread.get(conversation.id) ?? 0) + 1);
      if (isForMe(message, conversation)) {
        state.attention.set(conversation.id, (state.attention.get(conversation.id) ?? 0) + 1);
      }
      if (isUrgent(message, conversation)) {
        state.urgent.set(conversation.id, (state.urgent.get(conversation.id) ?? 0) + 1);
      }
    }
    if (isForMe(message, conversation)) notify(message, conversation);
  } else if (message.from === state.me && isCurrent(conversation.id)) {
    markRead(conversation.id);
  }
  const current = isCurrent(conversation.id);
  // A draft for this group just came into existence (someone else wrote first, or we did).
  if (state.view.kind === "draft" && findGroup([state.me, ...state.view.to])?.id === conversation.id) {
    navigate({ kind: "conversation", id: conversation.id });
    return;
  }
  renderSidebar();
  if (current) {
    const stick = nearBottom() || message.from === state.me;
    renderHeader();
    renderMessages();
    if (stick) scrollToBottom();
  }
}
