// The sidebar: conversations, agents, their filters and the Unread / Include offline toggles.
import type { Conversation, Participant } from "@agent-bus/protocol";
import { dom } from "./dom";
import { agentDetail, elapsed, nameList, relativeTime } from "./format";
import { h } from "./html";
import { renderAgentPanel } from "./live";
import { applyTitle, renderNotifyButton } from "./notify";
import { renderBackBadge } from "./phones";
import { navigate } from "./routing";
import {
  agents,
  conversationTitle,
  currentDirectAgent,
  INCLUDE_OFFLINE_KEY,
  isCurrent,
  passesFilter,
  sortedConversations,
  state,
  UNREAD_ONLY_KEY,
} from "./state";

export function renderSidebar(): void {
  renderBackBadge();
  renderUnreadToggle();
  renderOfflineToggle();
  renderConversationList();
  renderAgentList();
  renderAgentPanel();
  renderNotifyButton();
  applyTitle();
}

function renderOfflineToggle(): void {
  dom.offlineBtn.classList.toggle("on", state.includeOffline);
  dom.offlineBtn.setAttribute("aria-pressed", String(state.includeOffline));
  dom.offlineBtn.title = state.includeOffline
    ? "Showing offline agents and their conversations — click to hide them"
    : "Also show offline agents and the conversations with them (you cannot write to them)";
}

dom.offlineBtn.addEventListener("click", () => {
  state.includeOffline = !state.includeOffline;
  localStorage.setItem(INCLUDE_OFFLINE_KEY, state.includeOffline ? "1" : "0");
  renderSidebar();
});

function renderUnreadToggle(): void {
  dom.unreadBtn.classList.toggle("on", state.unreadOnly);
  dom.unreadBtn.setAttribute("aria-pressed", String(state.unreadOnly));
  dom.unreadBtn.title = state.unreadOnly
    ? "Showing only conversations with unread messages — click to show all"
    : "Show only conversations with unread messages";
}

dom.unreadBtn.addEventListener("click", () => {
  state.unreadOnly = !state.unreadOnly;
  localStorage.setItem(UNREAD_ONLY_KEY, state.unreadOnly ? "1" : "0");
  renderSidebar();
});

function toggleFilter(agentId: string): void {
  if (!state.filter.delete(agentId)) state.filter.add(agentId);
  renderSidebar();
}

/** Small funnel icon for the agent filter toggle. */
function funnelIcon(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M2 3h12l-4.5 5.5V13l-3 1.5V8.5z");
  svg.append(path);
  return svg;
}

/** Third sidebar line, only while the agent reports it is busy: "busy 14 min". Details are on its page. */
function renderAgentStatus(agent: Participant): HTMLSpanElement | null {
  const status = agent.status;
  if (!agent.online || status?.state !== "busy") return null;
  return h("span", "agent-status agent-busy", `busy ${elapsed(status.since)}`);
}

function renderConversationList(): void {
  const conversations = sortedConversations();
  const shown = conversations.filter(passesFilter);
  renderFilterNote(conversations.filter((c) => !passesFilter(c)));
  const items = shown.map((conv) => {
    const li = h("li");
    const button = h("button", "side-item conv-item");
    button.type = "button";
    if (isCurrent(conv.id)) button.classList.add("active");
    const title = h("span", "side-item-title", conversationTitle(conv));
    const meta = h(
      "span",
      "side-item-detail",
      conv.kind === "all"
        ? "everyone"
        : `${conv.members.length} members${conv.members.includes(state.me) ? "" : " · you're not in it"}`
    );
    const text = h("span", "side-item-text");
    text.append(title, meta);
    button.append(text);
    const unread = state.unread.get(conv.id) ?? 0;
    if (unread > 0) {
      button.append(h("span", "badge", unread > 99 ? "99+" : String(unread)));
      if ((state.urgent.get(conv.id) ?? 0) > 0) {
        const dots = h("span", "attention-dots");
        dots.append(h("span", "attention-dot"), h("span", "attention-dot"));
        dots.title = "For you directly: mentions you, or a conversation of just you and one other";
        button.append(dots);
      } else if ((state.attention.get(conv.id) ?? 0) > 0) {
        const dot = h("span", "attention-dot");
        dot.title = "In a conversation you are in";
        button.append(dot);
      }
    }
    else if (conv.lastMessageAt > 0) button.append(h("span", "side-item-time", relativeTime(conv.lastMessageAt)));
    button.title = conv.kind === "all" ? "Delivered to every agent" : `Members: ${nameList(conv.members)}`;
    button.addEventListener("click", () => navigate({ kind: "conversation", id: conv.id }));
    li.append(button);
    return li;
  });
  if (state.view.kind === "draft") {
    const li = h("li");
    const button = h("button", "side-item conv-item active");
    button.type = "button";
    const text = h("span", "side-item-text");
    text.append(h("span", "side-item-title", nameList(state.view.to)), h("span", "side-item-detail", "new — not sent yet"));
    button.append(text);
    li.append(button);
    items.splice(1, 0, li);
  }
  if (state.unreadOnly && shown.every((c) => isCurrent(c.id))) {
    items.push(h("li", "side-empty", "No unread conversations."));
  } else if (!state.unreadOnly && state.filter.size > 0 && shown.every((c) => c.kind === "all")) {
    items.push(h("li", "side-empty", `No conversations with ${nameList([...state.filter])} yet.`));
  }
  dom.conversationList.replaceChildren(...items);
}

/** "with @a, @b · clear", plus how many unread messages the filter hides. */
function renderFilterNote(hidden: Conversation[]): void {
  if (state.filter.size === 0) {
    dom.convFilter.hidden = true;
    return;
  }
  const hiddenUnread = hidden.reduce((n, c) => n + (state.unread.get(c.id) ?? 0), 0);
  const hiddenForMe = hidden.some((c) => (state.attention.get(c.id) ?? 0) > 0);
  const clear = h("button", "link-btn", "clear");
  clear.type = "button";
  clear.addEventListener("click", () => {
    state.filter.clear();
    renderSidebar();
  });
  const parts: Array<string | HTMLElement> = [`with ${nameList([...state.filter])} · `, clear];
  if (hiddenUnread > 0) {
    const note = h("span", hiddenForMe ? "filter-hidden filter-hidden-me" : "filter-hidden", ` · ${hiddenUnread} unread hidden`);
    parts.push(note);
  }
  dom.convFilter.replaceChildren(...parts);
  dom.convFilter.hidden = false;
}

function renderAgentList(): void {
  const all = agents();
  const list = state.includeOffline ? all : all.filter((a) => a.online || a.id === currentDirectAgent());
  const hosts = new Set(list.map((a) => a.host ?? ""));
  const showHost = hosts.size > 1;
  const active = currentDirectAgent();
  const online = all.filter((a) => a.online).length;
  dom.agentCount.textContent = all.length > 0 ? `${online}/${all.length} online` : "";
  if (list.length === 0) {
    dom.agentList.replaceChildren(h("li", "side-empty", all.length === 0 ? "No agents have joined yet." : "No agents online."));
    return;
  }
  dom.agentList.replaceChildren(
    ...list.map((agent) => {
      const li = h("li", "agent-row");
      const button = h("button", "side-item agent-item");
      button.type = "button";
      if (agent.id === active) button.classList.add("active");
      if (!agent.online) button.classList.add("offline");
      const dot = h("span", `dot ${agent.online ? "dot-on" : "dot-off"}`);
      const text = h("span", "side-item-text");
      const name = h("span", "side-item-title", agent.id);
      if (agent.connections > 1) name.append(h("span", "conn-count", ` ×${agent.connections}`));
      text.append(name);
      const detail = agentDetail(agent, showHost);
      if (detail) text.append(h("span", "side-item-detail", detail));
      const statusLine = renderAgentStatus(agent);
      if (statusLine) text.append(statusLine);
      button.append(dot, text);
      const tip = [
        agent.id,
        agent.harness ? `harness: ${agent.harness}` : "",
        agent.path ? `path: ${agent.path}` : "",
        agent.host ? `host: ${agent.host}` : "",
        agent.online
          ? `online (${agent.connections} connection${agent.connections === 1 ? "" : "s"})`
          : `last seen ${relativeTime(agent.lastSeenAt)}`,
        "Open its page for what it is doing now.",
      ];
      button.title = tip.filter(Boolean).join("\n");
      button.addEventListener("click", () => navigate({ kind: "draft", to: [agent.id] }));
      const filtering = state.filter.has(agent.id);
      const filter = h("button", `agent-filter${filtering ? " on" : ""}`);
      filter.type = "button";
      filter.title = filtering
        ? `Showing only conversations with ${agent.id} — click to remove`
        : `Show only conversations with ${agent.id}`;
      filter.setAttribute("aria-pressed", String(filtering));
      filter.append(funnelIcon());
      filter.addEventListener("click", () => toggleFilter(agent.id));
      li.append(button, filter);
      return li;
    })
  );
}
