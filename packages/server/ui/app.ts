import {
  ALL_CONVERSATION_ID,
  formatAddress,
  formatBytes,
  isJsonObject,
  type Conversation,
  type FileRef,
  type Message,
  type MessagesResponse,
  type Participant,
  type PostMessageRequest,
  type PostMessageResponse,
  type Quote,
  type ReceiptFrame,
  type StateResponse,
  type ViewerServerFrame,
  type ViewerClientFrame,
  type ActivityEvent,
} from "@agent-bus/protocol";
import { renderMarkdown } from "./markdown";

const PROFILE_KEY = "agent-bus.profile";
/** Per-profile read markers: conversation id → createdAt of the newest message read; "*" = first visit. */
const READ_KEY_PREFIX = "agent-bus.read.";
const UNREAD_ONLY_KEY = "agent-bus.unreadOnly";
const PAGE_SIZE = 100;
const MAX_MENTIONS = 8;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15000;

/** What the main pane shows: an existing conversation, or a not-yet-created group addressed to `to` (ids besides me). */
type View = { kind: "conversation"; id: string } | { kind: "draft"; to: string[] };

interface MessageCache {
  messages: Message[];
  /** More messages exist before the first loaded one. */
  hasEarlier: boolean;
}

interface MentionCandidate {
  id: string;
  label: string;
  hint: string;
}

// ---- DOM ----

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const dom = {
  linkStatus: el<HTMLSpanElement>("link-status"),
  profileSelect: el<HTMLSelectElement>("profile-select"),
  newGroupBtn: el<HTMLButtonElement>("new-group-btn"),
  unreadBtn: el<HTMLButtonElement>("unread-btn"),
  conversationList: el<HTMLUListElement>("conversation-list"),
  agentList: el<HTMLUListElement>("agent-list"),
  agentCount: el<HTMLSpanElement>("agent-count"),
  main: el<HTMLElement>("main"),
  convTitle: el<HTMLHeadingElement>("conv-title"),
  convSubtitle: el<HTMLDivElement>("conv-subtitle"),
  messageScroll: el<HTMLDivElement>("message-scroll"),
  loadEarlier: el<HTMLDivElement>("load-earlier"),
  loadEarlierBtn: el<HTMLButtonElement>("load-earlier-btn"),
  messageList: el<HTMLOListElement>("message-list"),
  messageEmpty: el<HTMLDivElement>("message-empty"),
  composer: el<HTMLFormElement>("composer"),
  composerError: el<HTMLDivElement>("composer-error"),
  stagedFiles: el<HTMLUListElement>("staged-files"),
  attachBtn: el<HTMLButtonElement>("attach-btn"),
  backBtn: el<HTMLButtonElement>("back-btn"),
  backBadge: el<HTMLSpanElement>("back-badge"),
  detailsBtn: el<HTMLButtonElement>("details-btn"),
  fileInput: el<HTMLInputElement>("file-input"),
  mentionMenu: el<HTMLUListElement>("mention-menu"),
  input: el<HTMLTextAreaElement>("composer-input"),
  composerGrip: el<HTMLDivElement>("composer-grip"),
  sendBtn: el<HTMLButtonElement>("send-btn"),
  dropOverlay: el<HTMLDivElement>("drop-overlay"),
  profileDialog: el<HTMLDialogElement>("profile-dialog"),
  profileChoices: el<HTMLDivElement>("profile-choices"),
  groupDialog: el<HTMLDialogElement>("group-dialog"),
  groupForm: el<HTMLFormElement>("group-form"),
  groupChoices: el<HTMLUListElement>("group-choices"),
  groupError: el<HTMLDivElement>("group-error"),
  groupCancel: el<HTMLButtonElement>("group-cancel"),
  notifyBtn: el<HTMLButtonElement>("notify-btn"),
  authLink: el<HTMLAnchorElement>("auth-link"),
  convFilter: el<HTMLDivElement>("conv-filter"),
  lightbox: el<HTMLDialogElement>("lightbox"),
  lightboxImg: el<HTMLImageElement>("lightbox-img"),
  lightboxName: el<HTMLSpanElement>("lightbox-name"),
  lightboxDownload: el<HTMLAnchorElement>("lightbox-download"),
  lightboxHint: el<HTMLSpanElement>("lightbox-hint"),
  app: el<HTMLDivElement>("app"),
  docPanel: el<HTMLElement>("doc-panel"),
  docTitle: el<HTMLSpanElement>("doc-title"),
  docDownload: el<HTMLAnchorElement>("doc-download"),
  docClose: el<HTMLButtonElement>("doc-close"),
  docBody: el<HTMLDivElement>("doc-body"),
  agentPanel: el<HTMLDivElement>("agent-panel"),
  agentInfo: el<HTMLDivElement>("agent-info"),
  agentOutput: el<HTMLDivElement>("agent-output"),
  agentOutputNote: el<HTMLSpanElement>("agent-output-note"),
  agentOutputToggle: el<HTMLButtonElement>("agent-output-toggle"),
  replyBar: el<HTMLDivElement>("reply-bar"),
  replyBarText: el<HTMLSpanElement>("reply-bar-text"),
  replyCancel: el<HTMLButtonElement>("reply-cancel"),
};

// ---- State ----

const state = {
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
  readAt: {} as Record<string, number>,
  view: { kind: "conversation", id: ALL_CONVERSATION_ID } as View,
  staged: [] as File[],
  /** Message the next send replies to (quotes), in the open conversation. */
  replyTo: undefined as Message | undefined,
  sending: false,
  mention: { open: false, start: 0, items: [] as MentionCandidate[], index: 0 },
};

// ---- HTTP ----

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    const error = isJsonObject(body) && typeof body.error === "string" ? body.error : `${res.status} ${res.statusText}`;
    throw new Error(error);
  }
  return body as T;
}

// ---- Helpers ----

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sortedUnique(ids: readonly string[]): string[] {
  return Array.from(new Set(ids)).sort();
}

function agents(): Participant[] {
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
function findGroup(ids: readonly string[]): Conversation | undefined {
  const wanted = threadKey(ids);
  for (const conv of state.conversations.values()) {
    if (conv.kind === "group" && threadKey(conv.members) === wanted) return conv;
  }
  return undefined;
}

function sortedConversations(): Conversation[] {
  const all = state.conversations.get(ALL_CONVERSATION_ID);
  const groups = Array.from(state.conversations.values())
    .filter((c) => c.kind === "group")
    .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  return all ? [all, ...groups] : groups;
}

/** Agent filter: `@all` always passes, a group when every filtered agent is a member. Unread filter: unread or open. */
function passesFilter(conv: Conversation): boolean {
  if (state.unreadOnly && (state.unread.get(conv.id) ?? 0) === 0 && !isCurrent(conv.id)) return false;
  if (conv.kind === "all" || state.filter.size === 0) return true;
  return [...state.filter].every((id) => conv.members.includes(id));
}

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

/** Names as the website shows them: plain ids, no "@" (that is only for addressing in message text). */
function nameList(ids: readonly string[]): string {
  return ids.join(", ");
}

/** "all", or a group's members: everyone but me (all of them if I am not a member). */
function conversationTitle(conv: Conversation): string {
  if (conv.kind === "all") return "all";
  const ids = conv.members.length > 0 ? conv.members : conv.addressed;
  const others = ids.filter((id) => id !== state.me);
  return nameList(others.length > 0 ? others : ids);
}

function shortPath(path: string): string {
  return path.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, "~");
}

/** Second sidebar line for an agent: path when it joined by folder, else harness; host when it disambiguates. */
function agentDetail(agent: Participant, showHost: boolean): string {
  const parts: string[] = [];
  if (agent.path) parts.push(shortPath(agent.path));
  else if (agent.harness) parts.push(agent.harness);
  if (agent.host && (showHost || !agent.path)) parts.push(agent.host);
  return parts.join(" · ");
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const fullFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (dayKey(ts) === dayKey(Date.now())) return timeFormat.format(ts);
  return dayFormat.format(ts);
}

/** "40 s", "14 min", "2 h 5 min". */
function elapsed(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

/** Third sidebar line, only while the agent reports it is busy: "busy 14 min". Details are on its page. */
function renderAgentStatus(agent: Participant): HTMLSpanElement | null {
  const status = agent.status;
  if (!agent.online || status?.state !== "busy") return null;
  return h("span", "agent-status agent-busy", `busy ${elapsed(status.since)}`);
}

/** Status panel at the top of an agent's own page (its one-to-one conversation or draft). */
function renderAgentPanel(): void {
  const agentId = currentDirectAgent();
  const agent = agentId ? state.participants.find((p) => p.id === agentId && p.kind === "agent") : undefined;
  if (!agent) {
    dom.agentPanel.hidden = true;
    syncWatch();
    return;
  }
  const rows: Array<[string, string | HTMLElement]> = [];
  const status = agent.online ? agent.status : undefined;
  if (!agent.online) {
    rows.push(["State", `offline · last seen ${relativeTime(agent.lastSeenAt)}`]);
  } else if (!status) {
    rows.push(["State", "online · no status reported (session started before status reporting; restart it to see more)"]);
  } else {
    rows.push(["State", h("span", `agent-state agent-${status.state}-text`, `${status.state} for ${elapsed(status.since)}`)]);
    if (status.state === "busy" && status.tool) {
      rows.push(["Running", `${status.tool}${status.toolSince ? ` for ${elapsed(status.toolSince)}` : ""}`]);
    }
    if (status.state === "busy" && status.activity) rows.push(["Doing", status.activity]);
  }
  if (agent.online && agent.waiting !== undefined) {
    rows.push([
      "Waiting",
      agent.waiting === 0
        ? "no bus messages waiting"
        : `${agent.waiting} bus message${agent.waiting === 1 ? "" : "s"} delivered, not seen by its model yet`,
    ]);
  }
  const where = [agent.path ? shortPath(agent.path) : "", agent.host ?? "", agent.harness ?? ""].filter(Boolean).join(" · ");
  if (where) rows.push(["Where", where]);
  if (agent.connections > 1) rows.push(["Sessions", `${agent.connections} connected (same folder open twice)`]);
  rows.push(["To all", agent.settings.all === "wake" ? "starts a turn" : "quiet (read at its next turn)"]);
  const list = h("dl", "agent-panel-list");
  for (const [label, value] of rows) {
    const dd = h("dd");
    dd.append(value);
    list.append(h("dt", "", label), dd);
  }
  dom.agentInfo.replaceChildren(list);
  dom.agentPanel.hidden = false;
  syncWatch();
  renderLiveOutput();
}

// ---- Live output of the agent whose page is open (streamed only while watched) ----

const LIVE_OUTPUT_KEY = "agent-bus.liveOutput";
/** If the agent sends no replay within this long, its session predates live output. */
const NO_STREAM_AFTER_MS = 3000;

const live = {
  enabled: localStorage.getItem(LIVE_OUTPUT_KEY) !== "off",
  /** Agent the server was last told this page watches. */
  sent: null as string | null,
  agentId: null as string | null,
  entries: new Map<string, ActivityEvent>(),
  replayed: false,
  silentTimer: undefined as Timer | undefined,
  silent: false,
};

/** The agent to watch now: its page is open, the tab is visible and live output is not hidden. */
function wantedWatch(): string | null {
  if (!live.enabled || document.visibilityState !== "visible" || dom.agentPanel.hidden) return null;
  const agentId = currentDirectAgent();
  const agent = agentId ? state.participants.find((p) => p.id === agentId) : undefined;
  return agent?.online ? agent.id : null;
}

/** Tells the server which agent this page watches when that changes (and after reconnects, `force`). */
function syncWatch(force = false): void {
  const wanted = wantedWatch();
  if (wanted !== live.agentId) {
    live.agentId = wanted;
    live.entries.clear();
    live.replayed = false;
    live.silent = false;
    clearTimeout(live.silentTimer);
    live.silentTimer = undefined;
  }
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (!force && wanted === live.sent) return;
  live.sent = wanted;
  const frame: ViewerClientFrame = { type: "watch", agentId: wanted };
  socket.send(JSON.stringify(frame));
  if (wanted !== null && !live.replayed) {
    clearTimeout(live.silentTimer);
    live.silentTimer = setTimeout(() => {
      if (live.agentId === wanted && !live.replayed) {
        live.silent = true;
        renderLiveOutput();
      }
    }, NO_STREAM_AFTER_MS);
  }
}

function applyActivity(frame: Extract<ViewerServerFrame, { type: "activity" }>): void {
  if (frame.agentId !== live.agentId) return;
  if (frame.replay) {
    live.entries.clear();
    live.replayed = true;
    live.silent = false;
  }
  for (const event of frame.events) live.entries.set(event.id, event);
  renderLiveOutput();
}

function renderActivityEntry(event: ActivityEvent): HTMLElement {
  if (event.kind === "user") {
    const text = event.text.length > 1200 ? `${event.text.slice(0, 1199)}…` : event.text;
    return h("div", "act act-user", text);
  }
  if (event.kind === "assistant") {
    const wrap = h("div", `act act-assistant${event.done ? "" : " act-streaming"}`);
    if (event.thinking) {
      const thought = h("div", "act-thinking msg-text");
      thought.append(...renderMarkdown(event.thinking, mentionNodes));
      wrap.append(thought);
    }
    if (event.text) {
      const text = h("div", "msg-text");
      text.append(...renderMarkdown(event.text, mentionNodes));
      wrap.append(text);
    }
    return wrap;
  }
  const el = h("div", `act act-tool act-${event.state}`);
  const head = h("div", "act-tool-head");
  head.append(h("span", "act-tool-name", event.name));
  if (event.intent) head.append(h("span", "act-tool-intent", event.intent));
  head.append(h("span", "act-tool-state", event.state === "running" ? "running…" : event.state === "error" ? "error" : "done"));
  el.append(head);
  if (event.input) el.append(h("pre", "act-tool-input", event.input));
  if (event.output) el.append(h("pre", "act-tool-output", event.output));
  return el;
}

function renderLiveOutput(): void {
  dom.agentOutputToggle.textContent = live.enabled ? "Hide" : "Show";
  dom.agentOutput.hidden = !live.enabled;
  if (!live.enabled) {
    dom.agentOutputNote.textContent = "hidden";
    return;
  }
  if (live.agentId === null) {
    dom.agentOutputNote.textContent = "";
    dom.agentOutput.replaceChildren(h("div", "act-note", "Shown while the agent is online."));
    return;
  }
  if (!live.replayed) {
    dom.agentOutputNote.textContent = "";
    dom.agentOutput.replaceChildren(
      h(
        "div",
        "act-note",
        live.silent
          ? "This agent's session does not stream its output yet; it needs an omp restart."
          : "Connecting…"
      )
    );
    return;
  }
  dom.agentOutputNote.textContent = "live";
  const box = dom.agentOutput;
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const entries = [...live.entries.values()];
  box.replaceChildren(
    ...(entries.length > 0 ? entries.map(renderActivityEntry) : [h("div", "act-note", "Nothing yet in this session.")])
  );
  if (stick) box.scrollTop = box.scrollHeight;
}

dom.agentOutputToggle.addEventListener("click", () => {
  live.enabled = !live.enabled;
  localStorage.setItem(LIVE_OUTPUT_KEY, live.enabled ? "on" : "off");
  syncWatch();
  renderLiveOutput();
});
document.addEventListener("visibilitychange", () => syncWatch());

// ---- Profile ----

function setMe(id: string): void {
  state.me = id;
  localStorage.setItem(PROFILE_KEY, id);
  dom.profileSelect.value = id;
  loadReadMarkers();
  renderAll();
  loadDraft();
  void refreshUnread();
}

// ---- Unread, attention and notifications ----

function loadReadMarkers(): void {
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
function viewingNow(conversationId: string): boolean {
  return isCurrent(conversationId) && document.visibilityState === "visible";
}

function markRead(conversationId: string): void {
  state.unread.delete(conversationId);
  state.attention.delete(conversationId);
  state.urgent.delete(conversationId);
  const conv = state.conversations.get(conversationId);
  if (!conv || !state.me || (state.readAt[conversationId] ?? 0) >= conv.lastMessageAt) return;
  state.readAt[conversationId] = conv.lastMessageAt;
  saveReadMarkers();
}

/** `text` mentions me as `@me` or inside `@{…}`. */
function mentionsMe(text: string): boolean {
  for (const match of text.matchAll(MENTION_RE)) {
    const ids = (match[2] ?? "")
      .replace(/^@\{?|\}$/g, "")
      .split(",")
      .map((s) => s.trim().replace(/^@/, "").toLowerCase());
    if (ids.includes(state.me)) return true;
  }
  return false;
}

/** Messages that get the red dot and a notification: they mention me, or I am a member of their conversation. */
function isForMe(message: Message, conv: Conversation): boolean {
  if (!state.me || message.from === state.me) return false;
  return mentionsMe(message.text) || (conv.kind === "group" && conv.members.includes(state.me));
}

/** Messages that get two red dots: they mention me, or their conversation has exactly two members, me included. */
function isUrgent(message: Message, conv: Conversation): boolean {
  if (!state.me || message.from === state.me) return false;
  return mentionsMe(message.text) || (conv.kind === "group" && conv.members.length === 2 && conv.members.includes(state.me));
}

/**
 * Recomputes unread counts from the read markers (on boot, reconnect and profile switch). Conversations
 * without a marker count from the first visit; on the very first visit everything existing is read.
 */
async function refreshUnread(): Promise<void> {
  if (!state.me) return;
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

type NotifyState = "unsupported" | "insecure" | NotificationPermission;

function notifyState(): NotifyState {
  if (!("Notification" in window)) return "unsupported";
  if (!window.isSecureContext) return "insecure";
  return Notification.permission;
}

function renderNotifyButton(): void {
  const s = notifyState();
  const btn = dom.notifyBtn;
  btn.hidden = s === "granted" || s === "unsupported";
  if (s === "default") {
    btn.textContent = "🔔 Enable notifications";
    btn.title = "Get a browser notification for messages that mention you or are in your conversations";
  } else if (s === "denied") {
    btn.textContent = "🔕 Notifications blocked";
    btn.title = "Allow notifications for this site in the browser's site settings (icon left of the address bar), then reload.";
  } else if (s === "insecure") {
    btn.textContent = "🔕 Notifications unavailable";
    btn.title =
      "Browsers allow notifications only on https:// or localhost pages. In Chrome: open " +
      "chrome://flags/#unsafely-treat-insecure-origin-as-secure, add " +
      `${location.origin}, set it to Enabled and relaunch.`;
  }
}

dom.notifyBtn.addEventListener("click", () => {
  if (notifyState() === "default") void Notification.requestPermission().then(renderNotifyButton);
  else alert(dom.notifyBtn.title);
});

function notify(message: Message, conv: Conversation): void {
  if (notifyState() !== "granted" || (isCurrent(conv.id) && document.hasFocus())) return;
  const files = message.files.length > 0 ? ` [${message.files.map((f) => f.name).join(", ")}]` : "";
  const n = new Notification(`${message.from} · ${conversationTitle(conv)}`, {
    body: `${message.text.slice(0, 300)}${files}`,
    tag: `agent-bus-${message.seq}`,
  });
  n.addEventListener("click", () => {
    window.focus();
    navigate({ kind: "conversation", id: conv.id });
    n.close();
  });
}

let titleBase = "Agent Bus";

/** Tab icon: the header's ⇄ mark; a red dot while messages for me are unread. */
function faviconHref(attention: boolean): string {
  const dot = attention ? '<circle cx="26" cy="6" r="6" fill="#e5484d" stroke="#fff" stroke-width="2"/>' : "";
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
    '<rect x="1" y="1" width="30" height="30" rx="7" fill="#3563e9"/>' +
    '<path d="M8 12h14l-4-4M24 20H10l4 4" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>' +
    dot +
    "</svg>";
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

let faviconState: boolean | undefined;

function applyTitle(): void {
  let n = 0;
  for (const count of state.attention.values()) n += count;
  let urgent = 0;
  for (const count of state.urgent.values()) urgent += count;
  document.title = n > 0 ? `${urgent > 0 ? "●●" : "●"} (${n}) ${titleBase}` : titleBase;
  if (faviconState !== n > 0) {
    faviconState = n > 0;
    el<HTMLLinkElement>("favicon").href = faviconHref(faviconState);
  }
}

function renderProfileSelect(): void {
  dom.profileSelect.replaceChildren(
    ...state.humans.map((id) => {
      const option = h("option", undefined, id);
      option.value = id;
      return option;
    })
  );
  dom.profileSelect.value = state.me;
}

function askProfile(): void {
  dom.profileChoices.replaceChildren(
    ...state.humans.map((id) => {
      const button = h("button", "btn btn-primary profile-choice", id);
      button.type = "button";
      button.addEventListener("click", () => {
        dom.profileDialog.close();
        setMe(id);
        if (!PHONE.matches) dom.input.focus();
      });
      return button;
    })
  );
  if (!dom.profileDialog.open) dom.profileDialog.showModal();
}

dom.profileDialog.addEventListener("cancel", (event) => event.preventDefault());
dom.profileSelect.addEventListener("change", () => setMe(dom.profileSelect.value));

// ---- Routing (#/c/<id>, #/to/<a,b>) ----

function viewHash(view: View): string {
  return view.kind === "conversation" ? `#/c/${encodeURIComponent(view.id)}` : `#/to/${view.to.join(",")}`;
}

function parseHash(): View {
  const hash = location.hash;
  const conv = /^#\/c\/(.+)$/.exec(hash);
  if (conv?.[1]) return { kind: "conversation", id: decodeURIComponent(conv[1]) };
  const draft = /^#\/to\/(.+)$/.exec(hash);
  if (draft?.[1]) {
    const to = sortedUnique(decodeURIComponent(draft[1]).split(",").map((s) => s.trim()).filter(Boolean));
    if (to.length > 0) return { kind: "draft", to };
  }
  return { kind: "conversation", id: ALL_CONVERSATION_ID };
}

function navigate(view: View): void {
  const hash = viewHash(view);
  if (location.hash === hash) applyView(view);
  else location.hash = hash;
}

/** Drafts whose group already exists open the conversation instead. */
function resolveView(view: View): View {
  if (view.kind !== "draft") return view;
  const existing = findGroup([state.me, ...view.to]);
  return existing ? { kind: "conversation", id: existing.id } : view;
}

function applyView(view: View): void {
  const resolved = resolveView(view);
  if (resolved !== view) {
    history.replaceState(null, "", viewHash(resolved));
  }
  const changed = viewHash(resolved) !== viewHash(state.view);
  state.view = resolved;
  if (resolved.kind === "conversation") {
    markRead(resolved.id);
    if (!state.caches.has(resolved.id)) void loadMessages(resolved.id);
  }
  if (changed) {
    hideError();
    closeMention();
    setReplyTo(undefined);
    setDetails(false);
  }
  setPhoneList(false);
  renderAll();
  if (changed) {
    loadDraft();
    scrollToBottom();
  }
}

window.addEventListener("hashchange", () => applyView(parseHash()));

// ---- Loading ----

async function loadState(): Promise<void> {
  const res = await api<StateResponse>("/api/state");
  state.humans = res.humans;
  state.participants = res.participants;
  state.conversations = new Map(res.conversations.map((c) => [c.id, c]));
}

async function loadMessages(conversationId: string): Promise<void> {
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

async function loadEarlier(): Promise<void> {
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

function mergeMessages(a: readonly Message[], b: readonly Message[]): Message[] {
  const bySeq = new Map<number, Message>();
  for (const m of a) bySeq.set(m.seq, m);
  for (const m of b) bySeq.set(m.seq, m);
  return Array.from(bySeq.values()).sort((x, y) => x.seq - y.seq);
}

function isCurrent(conversationId: string): boolean {
  return state.view.kind === "conversation" && state.view.id === conversationId;
}

/** Records a message (from the viewer socket or a POST response). */
function receive(message: Message, conversation: Conversation): void {
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

// ---- Viewer socket ----

let socket: WebSocket | null = null;
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer: Timer | null = null;
let everConnected = false;

function setLinkStatus(stateName: "connecting" | "live" | "offline", text: string): void {
  dom.linkStatus.dataset.state = stateName;
  dom.linkStatus.textContent = text;
}

function connectViewer(): void {
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/viewer`;
  const ws = new WebSocket(url);
  socket = ws;
  setLinkStatus("connecting", everConnected ? "reconnecting…" : "connecting…");

  ws.addEventListener("open", () => {
    reconnectDelay = RECONNECT_MIN_MS;
    setLinkStatus("live", "live");
    if (everConnected) void resync();
    everConnected = true;
    syncWatch(true);
  });
  ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let frame: unknown;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!isJsonObject(frame)) return;
    handleFrame(frame as ViewerServerFrame);
  });
  ws.addEventListener("close", () => {
    if (socket !== ws) return;
    socket = null;
    setLinkStatus("offline", `offline — retrying in ${Math.round(reconnectDelay / 1000)}s`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectViewer();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  });
}

function handleFrame(frame: ViewerServerFrame): void {
  switch (frame.type) {
    case "participants":
      state.participants = frame.participants;
      renderSidebar();
      if (state.mention.open) updateMention();
      break;
    case "message":
      receive(frame.message, frame.conversation);
      break;
    case "receipt":
      applyReceipt(frame);
      break;
    case "activity":
      applyActivity(frame);
      break;
  }
}

/** After a reconnect: refresh state and drop message caches (they may have gaps). */
async function resync(): Promise<void> {
  try {
    await loadState();
  } catch (err) {
    setLinkStatus("offline", `state refresh failed: ${errorText(err)}`);
    return;
  }
  state.caches.clear();
  applyView(state.view);
  await refreshUnread();
}

window.addEventListener("online", () => {
  if (socket || reconnectTimer === null) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  connectViewer();
});

// ---- Rendering ----

function renderAll(): void {
  renderProfileSelect();
  renderSidebar();
  renderHeader();
  renderMessages();
  updateComposerState();
}

function renderSidebar(): void {
  renderBackBadge();
  renderUnreadToggle();
  renderConversationList();
  renderAgentList();
  renderAgentPanel();
  renderNotifyButton();
  applyTitle();
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

/** Agent whose direct conversation (or draft) is open. */
function currentDirectAgent(): string | undefined {
  if (state.view.kind === "draft") return state.view.to.length === 1 ? state.view.to[0] : undefined;
  const conv = state.conversations.get(state.view.id);
  if (!conv || conv.kind !== "group") return undefined;
  const agentIds = new Set(agents().map((a) => a.id));
  const convAgents = conv.members.filter((id) => agentIds.has(id));
  return convAgents.length === 1 ? convAgents[0] : undefined;
}

function renderAgentList(): void {
  const list = agents();
  const hosts = new Set(list.map((a) => a.host ?? ""));
  const showHost = hosts.size > 1;
  const active = currentDirectAgent();
  const online = list.filter((a) => a.online).length;
  dom.agentCount.textContent = list.length > 0 ? `${online}/${list.length} online` : "";
  if (list.length === 0) {
    dom.agentList.replaceChildren(h("li", "side-empty", "No agents have joined yet."));
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

function renderHeader(): void {
  const view = state.view;
  if (view.kind === "draft") {
    dom.convTitle.textContent = nameList(view.to);
    dom.convSubtitle.textContent = `New conversation between you and ${nameList(view.to)} — created when you send the first message.`;
    titleBase = `${nameList(view.to)} · Agent Bus`;
    applyTitle();
    return;
  }
  const conv = state.conversations.get(view.id);
  if (!conv) {
    dom.convTitle.textContent = view.id;
    dom.convSubtitle.textContent = "Unknown conversation.";
    titleBase = "Agent Bus";
    applyTitle();
    return;
  }
  const title = conversationTitle(conv);
  dom.convTitle.textContent = title;
  titleBase = `${title} · Agent Bus`;
  applyTitle();
  if (conv.kind === "all") {
    dom.convSubtitle.textContent = "Everyone. Every agent receives what is written here.";
  } else {
    const membership = conv.members.includes(state.me)
      ? ""
      : " You are viewing; you join when you send a message.";
    dom.convSubtitle.textContent = `Members: ${nameList(conv.members)}.${membership}`;
  }
}

function showEmpty(text: string): void {
  dom.messageList.replaceChildren();
  dom.loadEarlier.hidden = true;
  dom.messageEmpty.hidden = false;
  dom.messageEmpty.textContent = text;
}

function renderMessages(): void {
  const view = state.view;
  if (view.kind === "draft") {
    showEmpty(`No messages yet. Write below to start the conversation with ${nameList(view.to)}.`);
    return;
  }
  const cache = state.caches.get(view.id);
  if (!cache) {
    showEmpty("Loading…");
    return;
  }
  if (cache.messages.length === 0) {
    showEmpty("No messages yet.");
    return;
  }
  dom.messageEmpty.hidden = true;
  dom.loadEarlier.hidden = !cache.hasEarlier;

  const nodes: HTMLElement[] = [];
  let lastDay = "";
  let previous: Message | undefined;
  for (const message of cache.messages) {
    const day = dayKey(message.createdAt);
    if (day !== lastDay) {
      nodes.push(h("li", "day-divider", dayFormat.format(message.createdAt)));
      lastDay = day;
      previous = undefined;
    }
    const continued =
      previous !== undefined && previous.from === message.from && message.createdAt - previous.createdAt < 5 * 60_000;
    nodes.push(renderMessage(message, continued));
    previous = message;
  }
  dom.messageList.replaceChildren(...nodes);
}

function renderMessage(message: Message, continued: boolean): HTMLLIElement {
  const human = message.fromKind === "human";
  const li = h("li", `msg ${human ? "msg-human" : "msg-agent"}`);
  if (message.from === state.me) li.classList.add("msg-mine");
  if (continued) li.classList.add("msg-continued");
  li.dataset.seq = String(message.seq);

  const head = h("div", "msg-head");
  const sender = h("button", "msg-sender", message.from);
  sender.type = "button";
  sender.title = human ? "Human" : "Agent — click to open a direct conversation";
  if (!human) sender.addEventListener("click", () => navigate({ kind: "draft", to: [message.from] }));
  head.append(sender, h("span", `kind-tag ${human ? "kind-human" : "kind-agent"}`, human ? "human" : "agent"));
  // Human messages written while the bus checks who humans are: signed in with a passkey, or not.
  if (message.verified === true) {
    const badge = h("span", "verified-tag", "✓");
    badge.title = "Signed in with a passkey: really them";
    head.append(badge);
  } else if (message.verified === false) {
    const badge = h("span", "unverified-tag", "not verified");
    badge.title = "Written without signing in: anyone on the LAN could have written this";
    head.append(badge);
  }
  const time = h("time", "msg-time", timeFormat.format(message.createdAt));
  time.dateTime = new Date(message.createdAt).toISOString();
  time.title = fullFormat.format(message.createdAt);
  head.append(h("span", "msg-seq", `#${message.seq}`), time);
  const replyBtn = h("button", "msg-reply-btn", "↩ Reply");
  replyBtn.type = "button";
  replyBtn.title = "Reply to this message (quotes it)";
  replyBtn.addEventListener("click", () => setReplyTo(message));
  head.append(replyBtn);
  li.append(head);

  if (message.quote) li.append(renderQuote(message.quote));
  if (message.text) li.append(renderText(message.text));
  if (message.files.length > 0) {
    const files = h("ul", "msg-files");
    for (const file of message.files) files.append(renderFile(file));
    li.append(files);
  }
  const receipts = renderReceipts(message);
  if (receipts) li.append(receipts);
  return li;
}

/**
 * "✓✓ seen by @a" / "✓ delivered to @a · not seen yet" / "○ not delivered yet to @a"; with several recipients
 * "✓✓ seen by all 3" or "✓✓ seen: @a · ✓ delivered: @b · ○ waiting: @c". Null when there are no agent recipients.
 */
function renderReceipts(message: Message): HTMLDivElement | null {
  const { receipts } = message;
  if (receipts.length === 0) return null;
  const seen = receipts.filter((r) => r.seenAt !== null);
  const delivered = receipts.filter((r) => r.seenAt === null && r.deliveredAt !== null);
  const pending = receipts.filter((r) => r.deliveredAt === null);
  const status = pending.length > 0 ? "receipts-pending" : delivered.length > 0 ? "receipts-delivered" : "receipts-seen";
  const el = h("div", `msg-receipts ${status}`);
  el.dataset.receipts = String(message.seq);
  const names = (list: typeof receipts) => list.map((r) => r.to).join(", ");
  if (receipts.length === 1) {
    const to = receipts[0]?.to ?? "";
    el.textContent = seen.length ? `✓✓ seen by ${to}` : delivered.length ? `✓ delivered to ${to} · not seen yet` : `○ not delivered yet to ${to}`;
  } else if (seen.length === receipts.length) {
    el.textContent = `✓✓ seen by all ${receipts.length}`;
  } else {
    el.textContent = [
      seen.length ? `✓✓ seen: ${names(seen)}` : "",
      delivered.length ? `✓ delivered: ${names(delivered)}` : "",
      pending.length ? `○ waiting: ${names(pending)}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
  }
  el.title = receipts
    .map((r) =>
      r.seenAt !== null
        ? `${r.to}: seen ${fullFormat.format(r.seenAt)}`
        : r.deliveredAt !== null
          ? `${r.to}: delivered ${fullFormat.format(r.deliveredAt)}, not seen yet`
          : `${r.to}: not delivered yet`
    )
    .join("\n");
  return el;
}

/** Updates the cached message and, if it is on screen, its receipt line. */
function applyReceipt(receipt: ReceiptFrame): void {
  const message = state.caches.get(receipt.conversationId)?.messages.find((m) => m.seq === receipt.seq);
  const entry = message?.receipts.find((r) => r.to === receipt.to);
  if (!message || !entry) return;
  entry.deliveredAt = receipt.deliveredAt;
  entry.seenAt = receipt.seenAt;
  const shown = dom.messageList.querySelector(`[data-receipts="${receipt.seq}"]`);
  const updated = renderReceipts(message);
  if (shown && updated) shown.replaceWith(updated);
}

/** Quote block of a reply; clicking jumps to the original when it is loaded. */
function renderQuote(quote: Quote): HTMLButtonElement {
  const el = h("button", "msg-quote");
  el.type = "button";
  el.title = `Reply to #${quote.seq} — click to show it`;
  const files = quote.files > 0 ? ` · ${quote.files} file${quote.files === 1 ? "" : "s"}` : "";
  el.append(h("span", "msg-quote-from", quote.from), h("span", "msg-quote-text", `${quote.text || "(no text)"}${files}`));
  el.addEventListener("click", () => {
    const target = shownMessage(quote.seq);
    if (target) flashMessage(target);
  });
  return el;
}

function setReplyTo(message: Message | undefined): void {
  state.replyTo = message;
  dom.replyBar.hidden = !message;
  if (message) {
    const text = message.text.replace(/\s+/g, " ").trim();
    dom.replyBarText.textContent = `Replying to ${message.from}: ${text.length > 120 ? `${text.slice(0, 119)}…` : text || "(file)"}`;
    dom.input.focus();
  }
}

dom.replyCancel.addEventListener("click", () => setReplyTo(undefined));

const MENTION_RE = /(^|[\s({,])(@(?:\{[^}\n]*\}|[a-z0-9][a-z0-9_-]*(?:@[a-z0-9][a-z0-9_-]*)?))/gi;

/** Plain text with @mentions highlighted and #n message references linked. */
function mentionNodes(text: string): Node[] {
  const out: Node[] = [];
  let last = 0;
  for (const match of text.matchAll(MENTION_RE)) {
    const lead = match[1] ?? "";
    const mention = match[2] ?? "";
    const start = (match.index ?? 0) + lead.length;
    if (start > last) out.push(...refNodes(text.slice(last, start)));
    const span = h("span", "mention", mention);
    const id = mention.slice(1).toLowerCase();
    if (id === state.me || id === "all") span.classList.add("mention-me");
    out.push(span);
    last = start + mention.length;
  }
  if (last < text.length) out.push(...refNodes(text.slice(last)));
  return out;
}

// ---- Message references (#n) ----

const REF_RE = /(^|[^\w#&])#(\d{1,7})(?!\w)/g;

function refNodes(text: string): Node[] {
  const out: Node[] = [];
  let last = 0;
  for (const match of text.matchAll(REF_RE)) {
    const start = (match.index ?? 0) + (match[1] ?? "").length;
    if (start > last) out.push(document.createTextNode(text.slice(last, start)));
    out.push(refLink(Number(match[2])));
    last = start + 1 + (match[2] ?? "").length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

/**
 * "#n" as a link: click shows message n (in its conversation); hovering highlights it when it is on screen,
 * otherwise its text shows as a tooltip.
 */
function refLink(seq: number): HTMLAnchorElement {
  const a = h("a", "msg-ref", `#${seq}`);
  a.href = "#";
  a.addEventListener("click", (event) => {
    event.preventDefault();
    void showMessage(seq);
  });
  a.addEventListener("mouseenter", () => {
    const target = shownMessage(seq);
    if (target && onScreen(target)) {
      a.removeAttribute("title");
      target.classList.add("msg-ref-target");
      return;
    }
    void refSummary(seq).then((text) => (a.title = text));
  });
  a.addEventListener("mouseleave", () => shownMessage(seq)?.classList.remove("msg-ref-target"));
  return a;
}

function shownMessage(seq: number): HTMLElement | null {
  return dom.messageList.querySelector<HTMLElement>(`[data-seq="${seq}"]`);
}

function onScreen(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  const view = dom.messageScroll.getBoundingClientRect();
  return r.bottom > view.top && r.top < view.bottom;
}

function flashMessage(el: HTMLElement): void {
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.remove("msg-flash");
  void el.offsetWidth; // restart the animation
  el.classList.add("msg-flash");
}

type MessageWithConversation = { message: Message; conversation: Conversation };
const refFetches = new Map<number, Promise<MessageWithConversation>>();

function fetchMessage(seq: number): Promise<MessageWithConversation> {
  let pending = refFetches.get(seq);
  if (!pending) {
    pending = api<MessageWithConversation>(`/api/messages/${seq}`);
    pending.catch(() => refFetches.delete(seq));
    refFetches.set(seq, pending);
  }
  return pending;
}

/** Tooltip for "#n": sender, conversation and the start of the text. */
async function refSummary(seq: number): Promise<string> {
  try {
    const { message, conversation } = await fetchMessage(seq);
    const text = message.text.replace(/\s+/g, " ").trim();
    const files = message.files.length > 0 ? ` [${message.files.map((f) => f.name).join(", ")}]` : "";
    return `#${seq} · ${message.from} in ${conversationTitle(conversation)}\n${text.length > 400 ? `${text.slice(0, 399)}…` : text}${files}`;
  } catch (err) {
    return `#${seq}: ${errorText(err)}`;
  }
}

/** Opens the conversation of message `seq` (loading earlier pages as needed), scrolls to it and flashes it. */
async function showMessage(seq: number): Promise<void> {
  const here = shownMessage(seq);
  if (here) return flashMessage(here);
  let id: string;
  try {
    id = (await fetchMessage(seq)).conversation.id;
  } catch (err) {
    showError(`Message #${seq}: ${errorText(err)}`);
    return;
  }
  if (!state.caches.has(id)) await loadMessages(id);
  if (!isCurrent(id)) {
    const view: View = { kind: "conversation", id };
    history.pushState(null, "", viewHash(view));
    applyView(view);
  }
  for (;;) {
    const cache = state.caches.get(id);
    const first = cache?.messages[0]?.seq;
    if (shownMessage(seq) || !cache?.hasEarlier || !isCurrent(id) || first === undefined || first < seq) break;
    await loadEarlier();
    if (state.caches.get(id)?.messages[0]?.seq === first) break; // the page failed to load
  }
  const target = shownMessage(seq);
  if (target) flashMessage(target);
}

/** Message text as markdown (see markdown.ts), with @mentions highlighted outside code. */
function renderText(text: string): HTMLDivElement {
  const body = h("div", "msg-text");
  body.append(...renderMarkdown(text, mentionNodes));
  return body;
}

function renderFile(file: FileRef): HTMLLIElement {
  const url = `/api/files/${encodeURIComponent(file.id)}`;
  const li = h("li", "msg-file");
  const row = h("span", "file-row");
  const link = h("a", "file-link");
  link.href = url;
  link.download = file.name;
  link.title = `${file.mimeType}\nsha256 ${file.sha256}`;
  if (isMarkdownFile(file)) {
    link.title = `Open ${file.name} on the right (Ctrl/⌘+click downloads)\nsha256 ${file.sha256}`;
    link.append(h("span", "file-icon", "📄"), h("span", "file-name", file.name));
    link.addEventListener("click", (event) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      void openDoc(file, url);
    });
  } else {
    link.append(h("span", "file-icon", "⬇"), h("span", "file-name", file.name));
  }
  row.append(link, h("span", "file-size", formatBytes(file.size)));
  if (file.mimeType.startsWith("image/")) {
    li.classList.add("msg-image");
    const preview = h("button", "image-preview");
    preview.type = "button";
    preview.title = "Click to view full size";
    const img = h("img");
    img.src = url;
    img.alt = file.name;
    img.loading = "lazy";
    // Keep the view pinned to the bottom when a preview loading late makes the list taller.
    img.addEventListener("load", () => {
      const s = dom.messageScroll;
      if (s.scrollHeight - s.scrollTop - s.clientHeight < img.offsetHeight + 80) scrollToBottom();
    });
    // Formats the browser cannot show (e.g. HEIC) stay a plain download.
    img.addEventListener("error", () => {
      preview.remove();
      li.classList.remove("msg-image");
    });
    preview.append(img);
    previewFiles.set(preview, { file, url });
    // The viewer steps through this message's images (those still previewed: unrenderable ones are gone).
    preview.addEventListener("click", () => {
      const all = [...(preview.closest(".msg")?.querySelectorAll<HTMLElement>(".image-preview") ?? [preview])];
      openLightbox(all.flatMap((p) => previewFiles.get(p) ?? []), Math.max(0, all.indexOf(preview)));
    });
    li.append(preview);
  }
  li.append(row);
  return li;
}

function isMarkdownFile(file: FileRef): boolean {
  return file.mimeType === "text/markdown" || /\.(md|markdown)$/i.test(file.name);
}

/** Larger documents are offered as a download only. */
const MAX_DOC_BYTES = 2 * 1024 * 1024;
let docRequest = 0;

/** Shows a markdown attachment rendered in the panel right of the conversation. */
async function openDoc(file: FileRef, url: string): Promise<void> {
  const request = ++docRequest;
  dom.docTitle.textContent = `${file.name} · ${formatBytes(file.size)}`;
  dom.docTitle.title = file.name;
  dom.docDownload.href = url;
  dom.docDownload.download = file.name;
  dom.docPanel.hidden = false;
  dom.app.classList.add("with-doc");
  if (file.size > MAX_DOC_BYTES) {
    dom.docBody.replaceChildren(h("p", "doc-note", `Too large to show here (${formatBytes(file.size)}); use Download.`));
    return;
  }
  dom.docBody.replaceChildren(h("p", "doc-note", "Loading…"));
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (request !== docRequest) return;
    dom.docBody.replaceChildren(...renderMarkdown(text, mentionNodes));
    dom.docBody.scrollTop = 0;
  } catch (error) {
    if (request !== docRequest) return;
    dom.docBody.replaceChildren(h("p", "doc-note", `Could not load ${file.name}: ${(error as Error).message}`));
  }
}

function closeDoc(): void {
  docRequest++;
  dom.docPanel.hidden = true;
  dom.app.classList.remove("with-doc");
  dom.docBody.replaceChildren();
}

dom.docClose.addEventListener("click", closeDoc);
// Esc closes the document unless something else (mention menu, reply bar, a dialog) used it first.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.defaultPrevented || dom.docPanel.hidden) return;
  if (document.querySelector("dialog[open]")) return;
  closeDoc();
});

/** File behind each image preview, for the viewer. */
const previewFiles = new WeakMap<HTMLElement, { file: FileRef; url: string }>();

/** The images the viewer steps through with ← and → (one message's), and the one shown. */
let lightboxImages: Array<{ file: FileRef; url: string }> = [];
let lightboxIndex = 0;

function openLightbox(images: Array<{ file: FileRef; url: string }>, index: number): void {
  lightboxImages = images;
  showLightboxImage(index);
  if (!dom.lightbox.open) dom.lightbox.showModal();
}

function showLightboxImage(index: number): void {
  const image = lightboxImages[index];
  if (!image) return;
  lightboxIndex = index;
  const { file, url } = image;
  dom.lightboxImg.src = url;
  dom.lightboxImg.alt = file.name;
  const position = lightboxImages.length > 1 ? `${index + 1} / ${lightboxImages.length} · ` : "";
  dom.lightboxName.textContent = `${position}${file.name} · ${formatBytes(file.size)}`;
  dom.lightboxDownload.href = url;
  dom.lightboxDownload.download = file.name;
  dom.lightboxHint.textContent = lightboxImages.length > 1 ? "← → for the others · click or Esc to close" : "click or Esc to close";
}

dom.lightbox.addEventListener("keydown", (event) => {
  if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
    event.preventDefault();
    showLightboxImage(lightboxIndex + (event.key === "ArrowRight" ? 1 : -1));
  }
});

// Any click closes it, except on the download link.
dom.lightbox.addEventListener("click", (event) => {
  if (event.target !== dom.lightboxDownload) dom.lightbox.close();
});
dom.lightbox.addEventListener("close", () => {
  dom.lightboxImg.removeAttribute("src");
  lightboxImages = [];
});

function nearBottom(): boolean {
  const s = dom.messageScroll;
  return s.scrollHeight - s.scrollTop - s.clientHeight < 80;
}

function scrollToBottom(): void {
  dom.messageScroll.scrollTop = dom.messageScroll.scrollHeight;
}

// ---- Composer ----

function showError(text: string): void {
  dom.composerError.textContent = text;
  dom.composerError.hidden = false;
}

function hideError(): void {
  dom.composerError.hidden = true;
  dom.composerError.textContent = "";
}

function updateComposerState(): void {
  const hasContent = dom.input.value.trim().length > 0 || state.staged.length > 0;
  dom.sendBtn.disabled = state.sending || !state.me || !hasContent;
  dom.sendBtn.textContent = state.sending ? "Sending…" : "Send";
  const view = state.view;
  const conv = view.kind === "conversation" ? state.conversations.get(view.id) : undefined;
  const target = view.kind === "draft" ? nameList(view.to) : conv ? conversationTitle(conv) : "";
  dom.input.placeholder = PHONE.matches
    ? `Message ${target}…`
    : `Message ${target}…  (Enter to send, Shift+Enter for a new line, @ to mention)`;
}

/** The phone layout of styles.css (one screen at a time: the conversation list or a conversation). */
const PHONE = window.matchMedia("(max-width: 640px)");

/** Height the user gave the message box with its grip (px); undefined = grows with its text. Kept per browser. */
const COMPOSER_HEIGHT_KEY = "agent-bus.composerHeight";
const COMPOSER_MIN = 40;
const COMPOSER_AUTO_MAX = 240;
let composerHeight: number | undefined = Number(localStorage.getItem(COMPOSER_HEIGHT_KEY)) || undefined;

/** Tallest the box may be dragged: most of the chat, leaving room to see the newest messages. */
function composerMax(): number {
  const chat = dom.composer.parentElement;
  return Math.max(COMPOSER_MIN, Math.floor((chat?.clientHeight ?? window.innerHeight) * 0.7));
}

function autosize(): void {
  if (composerHeight !== undefined) {
    dom.input.style.height = `${Math.min(composerHeight, composerMax())}px`;
    return;
  }
  dom.input.style.height = "auto";
  dom.input.style.height = `${Math.min(dom.input.scrollHeight, COMPOSER_AUTO_MAX)}px`;
}

function setComposerHeight(height: number | undefined): void {
  composerHeight = height;
  if (height === undefined) localStorage.removeItem(COMPOSER_HEIGHT_KEY);
  else localStorage.setItem(COMPOSER_HEIGHT_KEY, String(height));
  dom.composerGrip.setAttribute("aria-valuenow", String(height ?? dom.input.offsetHeight));
  autosize();
}

// Dragging the grip: read the sizes once at the start, then write only the box's height (one write per frame).
{
  const grip = dom.composerGrip;
  let drag: { startY: number; startHeight: number; max: number; stick: boolean; target: number; frame: number } | undefined;
  grip.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    try {
      grip.setPointerCapture(event.pointerId);
    } catch {
      // The pointer is already gone (released before this ran): the drag still follows moves over the grip.
    }
    grip.classList.add("dragging");
    const startHeight = dom.input.offsetHeight;
    drag = { startY: event.clientY, startHeight, max: composerMax(), stick: nearBottom(), target: startHeight, frame: 0 };
  });
  grip.addEventListener("pointermove", (event) => {
    const d = drag;
    if (!d) return;
    d.target = Math.round(Math.min(d.max, Math.max(COMPOSER_MIN, d.startHeight + d.startY - event.clientY)));
    d.frame ||= requestAnimationFrame(() => {
      d.frame = 0;
      dom.input.style.height = `${d.target}px`;
      // Writing (not reading) the scroll position keeps the newest message in view while the box grows.
      if (d.stick) dom.messageScroll.scrollTop = 1e9;
    });
  });
  const end = (): void => {
    const d = drag;
    if (!d) return;
    drag = undefined;
    cancelAnimationFrame(d.frame);
    grip.classList.remove("dragging");
    if (d.target !== d.startHeight) setComposerHeight(d.target);
    if (d.stick) scrollToBottom();
  };
  grip.addEventListener("pointerup", end);
  grip.addEventListener("pointercancel", end);
  grip.addEventListener("dblclick", () => setComposerHeight(undefined));
  grip.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const step = event.key === "ArrowUp" ? 24 : -24;
    setComposerHeight(Math.min(composerMax(), Math.max(COMPOSER_MIN, dom.input.offsetHeight + step)));
  });
  grip.setAttribute("aria-valuemin", String(COMPOSER_MIN));
}

/** Object URLs of the staged image previews currently shown; revoked on every re-render. */
let stagedPreviewUrls: string[] = [];

function renderStaged(): void {
  for (const url of stagedPreviewUrls) URL.revokeObjectURL(url);
  stagedPreviewUrls = [];
  dom.stagedFiles.hidden = state.staged.length === 0;
  dom.stagedFiles.replaceChildren(
    ...state.staged.map((file, index) => {
      const li = h("li", "staged-file");
      if (file.type.startsWith("image/")) {
        const url = URL.createObjectURL(file);
        stagedPreviewUrls.push(url);
        const img = h("img", "staged-preview");
        img.src = url;
        img.alt = file.name;
        li.append(img);
      }
      li.append(h("span", "file-name", file.name), h("span", "file-size", formatBytes(file.size)));
      const remove = h("button", "staged-remove", "×");
      remove.type = "button";
      remove.title = "Remove";
      remove.disabled = state.sending;
      remove.addEventListener("click", () => {
        state.staged.splice(index, 1);
        renderStaged();
        updateComposerState();
      });
      li.append(remove);
      return li;
    })
  );
}

function stageFiles(files: Iterable<File>): void {
  for (const file of files) state.staged.push(file);
  renderStaged();
  updateComposerState();
  dom.input.focus();
}

/** Browsers name every pasted image "image.png"; give each a distinct, dated name instead. */
function pastedName(file: File, index: number): File {
  if (file.name && file.name !== "image.png" && file.name !== "image.jpeg") return file;
  const ext = file.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  return new File([file], `pasted-${stamp}${index > 0 ? `-${index + 1}` : ""}.${ext}`, { type: file.type });
}

// Ctrl/⌘+V of an image (a screenshot) or of copied files attaches them; text pastes as usual.
dom.input.addEventListener("paste", (event) => {
  const files = Array.from(event.clipboardData?.files ?? []);
  if (files.length === 0) return;
  event.preventDefault();
  stageFiles(files.map(pastedName));
});

async function uploadFile(file: File): Promise<FileRef> {
  const params = new URLSearchParams({ from: state.me, name: file.name });
  const res = await api<{ file: FileRef }>(`/api/files?${params}`, {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  return res.file;
}

async function send(): Promise<void> {
  if (state.sending || !state.me) return;
  const text = dom.input.value;
  if (!text.trim() && state.staged.length === 0) return;
  const view = state.view;
  state.sending = true;
  hideError();
  updateComposerState();
  renderStaged();
  try {
    const fileIds: string[] = [];
    for (const file of state.staged) {
      try {
        fileIds.push((await uploadFile(file)).id);
      } catch (err) {
        throw new Error(`Upload of ${file.name} failed: ${errorText(err)}`);
      }
    }
    const request: PostMessageRequest = { from: state.me, text };
    if (fileIds.length > 0) request.fileIds = fileIds;
    if (state.replyTo && view.kind === "conversation" && state.replyTo.conversationId === view.id) {
      request.replyToSeq = state.replyTo.seq;
    } else if (view.kind === "draft") request.to = formatAddress(view.to);
    else if (view.id === ALL_CONVERSATION_ID) request.to = "@all";
    else request.conversationId = view.id;

    const res = await api<PostMessageResponse>("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    dom.input.value = "";
    saveDraft(view, "");
    state.staged = [];
    setReplyTo(undefined);
    autosize();
    // Groups not loaded yet (e.g. a draft that just became a group) get their history fetched.
    if (!state.caches.has(res.conversation.id)) void loadMessages(res.conversation.id);
    receive(res.message, res.conversation);
    if (view.kind === "draft") navigate({ kind: "conversation", id: res.conversation.id });
  } catch (err) {
    showError(errorText(err));
  } finally {
    state.sending = false;
    renderStaged();
    updateComposerState();
    dom.input.focus();
  }
}

dom.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  void send();
});

// ---- Phones: one screen at a time (the conversation list, or one conversation), sized above the keyboard ----

// The iOS keyboard covers the page instead of shrinking it: pin the page to the visible area above it
// (CSS vars --vvh and --vvt), so the message box sits on the keyboard and the newest messages right above.
const viewport = window.visualViewport;
function fitViewport(): void {
  if (!viewport || !PHONE.matches) return;
  const stick = nearBottom();
  const root = document.documentElement.style;
  root.setProperty("--vvh", `${Math.round(viewport.height)}px`);
  root.setProperty("--vvt", `${Math.round(viewport.offsetTop)}px`);
  if (stick) scrollToBottom();
}
viewport?.addEventListener("resize", fitViewport);
viewport?.addEventListener("scroll", fitViewport);

/** Phones: show the conversation list (← in the conversation bar) instead of the open conversation. */
function setPhoneList(on: boolean): void {
  dom.app.classList.toggle("phone-list", on);
}
dom.backBtn.addEventListener("click", () => {
  dom.input.blur();
  setPhoneList(true);
});

/** Phones: members, subtitle and the agent panel stay folded behind ⓘ so the messages get the screen. */
function setDetails(on: boolean): void {
  dom.main.classList.toggle("show-details", on);
  dom.detailsBtn.setAttribute("aria-pressed", String(on));
}
dom.detailsBtn.addEventListener("click", () => setDetails(!dom.main.classList.contains("show-details")));

/** Unread messages in the other conversations, on the ← button. */
function renderBackBadge(): void {
  let n = 0;
  let forMe = false;
  for (const [id, count] of state.unread) {
    if (isCurrent(id)) continue;
    n += count;
    if ((state.attention.get(id) ?? 0) > 0) forMe = true;
  }
  dom.backBadge.hidden = n === 0;
  dom.backBadge.textContent = n > 99 ? "99+" : String(n);
  dom.backBadge.classList.toggle("badge-for-me", forMe);
}

// ---- Drafts: unsent text is kept per conversation and profile, across navigation and reloads ----

const DRAFT_KEY_PREFIX = "agent-bus.draft.";

function draftKey(view: View): string {
  return `${DRAFT_KEY_PREFIX}${state.me}.${viewHash(view)}`;
}

function saveDraft(view: View, text: string): void {
  if (!state.me) return;
  if (text.trim()) localStorage.setItem(draftKey(view), text);
  else localStorage.removeItem(draftKey(view));
}

function loadDraft(): void {
  dom.input.value = state.me ? (localStorage.getItem(draftKey(state.view)) ?? "") : "";
  autosize();
  updateComposerState();
}

// Tapping Send keeps the input focused: the keyboard stays up and nothing moves before the tap lands.
dom.sendBtn.addEventListener("pointerdown", (event) => {
  if (PHONE.matches && document.activeElement === dom.input) event.preventDefault();
});

dom.input.addEventListener("keydown", (event) => {
  if (state.mention.open && handleMentionKey(event)) return;
  if (event.key === "Escape" && state.replyTo) {
    event.preventDefault();
    setReplyTo(undefined);
    return;
  }
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void send();
  }
});

dom.input.addEventListener("input", () => {
  autosize();
  updateComposerState();
  updateMention();
  saveDraft(state.view, dom.input.value);
});
dom.input.addEventListener("click", () => updateMention());
dom.input.addEventListener("blur", () => closeMention());

dom.attachBtn.addEventListener("click", () => dom.fileInput.click());
dom.fileInput.addEventListener("change", () => {
  if (dom.fileInput.files) stageFiles(Array.from(dom.fileInput.files));
  dom.fileInput.value = "";
});

// Drag and drop anywhere on the page.
let dragDepth = 0;

function hasFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes("Files") ?? false;
}

document.addEventListener("dragenter", (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth++;
  dom.dropOverlay.hidden = false;
});
document.addEventListener("dragover", (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
});
document.addEventListener("dragleave", (event) => {
  if (!hasFiles(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dom.dropOverlay.hidden = true;
});
document.addEventListener("drop", (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  dom.dropOverlay.hidden = true;
  if (event.dataTransfer) stageFiles(Array.from(event.dataTransfer.files));
});

// ---- @ autocomplete ----

/** Online agents, other agents, humans (not me), then `all`. */
function mentionCandidates(): MentionCandidate[] {
  const out: MentionCandidate[] = agents().map((a) => ({
    id: a.id,
    label: `@${a.id}`,
    hint: [a.online ? "online" : "offline", a.path ? shortPath(a.path) : a.harness ?? ""].filter(Boolean).join(" · "),
  }));
  for (const id of state.humans) {
    if (id !== state.me) out.push({ id, label: `@${id}`, hint: "human" });
  }
  out.push({ id: "all", label: "@all", hint: "everyone" });
  return out;
}

function updateMention(): void {
  const caret = dom.input.selectionStart;
  if (caret === null || caret !== dom.input.selectionEnd) {
    closeMention();
    return;
  }
  const before = dom.input.value.slice(0, caret);
  const match = /(^|[\s({,])@([a-z0-9_-]*(?:@[a-z0-9_-]*)?)$/i.exec(before);
  if (!match) {
    closeMention();
    return;
  }
  const prefix = (match[2] ?? "").toLowerCase();
  const items = mentionCandidates()
    .filter((c) => c.id.startsWith(prefix))
    .slice(0, MAX_MENTIONS);
  if (items.length === 0) {
    closeMention();
    return;
  }
  const start = caret - prefix.length - 1;
  const previousId = state.mention.open ? state.mention.items[state.mention.index]?.id : undefined;
  const keep = previousId ? items.findIndex((c) => c.id === previousId) : -1;
  state.mention = { open: true, start, items, index: keep >= 0 ? keep : 0 };
  renderMention();
}

function renderMention(): void {
  const { items, index } = state.mention;
  dom.mentionMenu.hidden = false;
  dom.mentionMenu.replaceChildren(
    ...items.map((item, i) => {
      const li = h("li", i === index ? "mention-item selected" : "mention-item");
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(i === index));
      li.append(h("span", "mention-label", item.label), h("span", "mention-hint", item.hint));
      // mousedown keeps focus in the textarea (no blur → close).
      li.addEventListener("mousedown", (event) => {
        event.preventDefault();
        insertMention(item);
      });
      return li;
    })
  );
}

function closeMention(): void {
  if (!state.mention.open) return;
  state.mention = { open: false, start: 0, items: [], index: 0 };
  dom.mentionMenu.hidden = true;
  dom.mentionMenu.replaceChildren();
}

function insertMention(item: MentionCandidate): void {
  const caret = dom.input.selectionStart ?? dom.input.value.length;
  const value = dom.input.value;
  const insert = `@${item.id} `;
  dom.input.value = value.slice(0, state.mention.start) + insert + value.slice(caret);
  const pos = state.mention.start + insert.length;
  dom.input.setSelectionRange(pos, pos);
  closeMention();
  autosize();
  saveDraft(state.view, dom.input.value);
  updateComposerState();
  dom.input.focus();
}

/** Returns true when the key was consumed by the menu. */
function handleMentionKey(event: KeyboardEvent): boolean {
  const { items, index } = state.mention;
  switch (event.key) {
    case "ArrowDown":
      state.mention.index = (index + 1) % items.length;
      break;
    case "ArrowUp":
      state.mention.index = (index - 1 + items.length) % items.length;
      break;
    case "Enter":
    case "Tab": {
      if (event.shiftKey || event.isComposing) return false;
      const item = items[index];
      if (!item) return false;
      event.preventDefault();
      insertMention(item);
      return true;
    }
    case "Escape":
      event.preventDefault();
      closeMention();
      return true;
    default:
      return false;
  }
  event.preventDefault();
  renderMention();
  return true;
}

// ---- New group ----

function openGroupDialog(): void {
  if (!state.me) return;
  dom.groupError.hidden = true;
  const choices: { id: string; detail: string; dot: string }[] = [
    ...agents().map((a) => ({ id: a.id, detail: agentDetail(a, true), dot: a.online ? "dot-on" : "dot-off" })),
    ...state.humans.filter((id) => id !== state.me).map((id) => ({ id, detail: "human", dot: "dot-human" })),
  ];
  if (choices.length === 0) {
    dom.groupChoices.replaceChildren(h("li", "side-empty", "Nobody else is on the bus yet."));
  } else {
    dom.groupChoices.replaceChildren(
      ...choices.map((choice) => {
        const li = h("li");
        const label = h("label", "group-choice");
        const box = h("input");
        box.type = "checkbox";
        box.value = choice.id;
        const text = h("span", "side-item-text");
        text.append(h("span", "side-item-title", choice.id), h("span", "side-item-detail", choice.detail));
        label.append(box, h("span", `dot ${choice.dot}`), text);
        li.append(label);
        return li;
      })
    );
  }
  dom.groupDialog.showModal();
}

dom.newGroupBtn.addEventListener("click", openGroupDialog);
dom.groupCancel.addEventListener("click", () => dom.groupDialog.close());
dom.groupForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const picked = Array.from(dom.groupChoices.querySelectorAll<HTMLInputElement>("input[type=checkbox]:checked")).map(
    (box) => box.value
  );
  if (picked.length === 0) {
    dom.groupError.textContent = "Pick at least one participant.";
    dom.groupError.hidden = false;
    return;
  }
  dom.groupDialog.close();
  navigate({ kind: "draft", to: sortedUnique(picked) });
  dom.input.focus();
});

// ---- Boot ----

/** Authentication state for the topbar link; the signed-in human, if any. */
async function loadAuth(): Promise<string | undefined> {
  try {
    const auth = await api<{ mode: string; me: string | null }>("/api/auth/state");
    if (auth.mode === "off") return undefined;
    dom.authLink.hidden = false;
    dom.authLink.textContent = auth.me ? `✓ ${auth.me}` : auth.mode === "required" ? "Sign in to write" : "Sign in";
    dom.authLink.title = auth.me ? "Signed in with a passkey (manage passkeys, sign out)" : "Sign in with a passkey so your messages count as verified";
    return auth.me ?? undefined;
  } catch {
    return undefined;
  }
}

async function boot(): Promise<void> {
  try {
    await loadState();
  } catch (err) {
    setLinkStatus("offline", "server unreachable");
    showEmpty(`Could not reach the bus: ${errorText(err)}. Reload to retry.`);
    return;
  }
  const saved = localStorage.getItem(PROFILE_KEY);
  state.me = saved && state.humans.includes(saved) ? saved : "";
  // With passkeys on, a signed-in browser is that human (the server refuses any other `from`).
  const signedIn = await loadAuth();
  if (signedIn && state.humans.includes(signedIn)) {
    state.me = signedIn;
    localStorage.setItem(PROFILE_KEY, signedIn);
    dom.profileSelect.disabled = true;
    dom.profileSelect.title = `Signed in as ${signedIn} with a passkey`;
  }
  if (state.me) loadReadMarkers();
  connectViewer();
  // Phones opened without a conversation in the address start on the conversation list.
  const startOnList = location.hash === "";
  applyView(parseHash());
  if (startOnList) setPhoneList(true);
  loadDraft();
  if (!state.me) askProfile();
  else {
    // On phones the keyboard should open only when the box is tapped.
    if (!PHONE.matches) dom.input.focus();
    void refreshUnread();
  }
}

void boot();
// Keeps "n min ago" labels in the sidebar current.
setInterval(renderSidebar, 60_000);
