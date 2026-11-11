// The status panel and live output of the agent whose page is open (output streamed only while watched).
import type { ActivityEvent, ViewerServerFrame } from "@agent-bus/protocol";
import { dom } from "./dom";
import { elapsed, relativeTime, shortPath } from "./format";
import { h } from "./html";
import { renderMarkdown } from "./markdown";
import { sendViewer } from "./socket";
import { currentDirectAgent, state } from "./state";
import { mentionNodes } from "./text";

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

/** Status panel at the top of an agent's own page (its one-to-one conversation or draft). */
export function renderAgentPanel(): void {
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

/** The agent to watch now: its page is open, the tab is visible and live output is not hidden. */
function wantedWatch(): string | null {
  if (!live.enabled || document.visibilityState !== "visible" || dom.agentPanel.hidden) return null;
  const agentId = currentDirectAgent();
  const agent = agentId ? state.participants.find((p) => p.id === agentId) : undefined;
  return agent?.online ? agent.id : null;
}

/** Tells the server which agent this page watches when that changes (and after reconnects, `force`). */
export function syncWatch(force = false): void {
  const wanted = wantedWatch();
  if (wanted !== live.agentId) {
    live.agentId = wanted;
    live.entries.clear();
    live.replayed = false;
    live.silent = false;
    clearTimeout(live.silentTimer);
    live.silentTimer = undefined;
  }
  if (!force && wanted === live.sent) return;
  if (!sendViewer({ type: "watch", agentId: wanted })) return;
  live.sent = wanted;
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

export function applyActivity(frame: Extract<ViewerServerFrame, { type: "activity" }>): void {
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
