/// <reference types="chrome" />

import { parseFencedBusActions } from "@agent-bus/protocol";
import {
  detectAdapterIdForUrl,
  resolveAdapter,
  type AssistantTurnSnapshot,
  type WebChatAdapter,
} from "./adapters";
import {
  decodeBase64ToBytes,
  encodeBytesToBase64,
  isRuntimeMessage,
  toOwnedArrayBuffer,
  type AdapterId,
  type CustomSelectorConfig,
  type ExtensionResponse,
  type RelayMode,
  type SerializedFilePayload,
  type TabBusSessionState,
} from "./types";

declare global {
  interface Window {
    __AGENT_BUS_CONTENT_LOADED__?: boolean;
  }
}

const STABILITY_DEBOUNCE_MS = 900;
const POST_INJECT_TTFT_HOLD_MS = 3500;
const RECENT_BLOCK_DEDUP_WINDOW_MS = 6000;
const MAX_BLOB_EGRESS_BYTES = 25 * 1024 * 1024;

const RELAY_MODE_LABELS: Record<RelayMode, string> = {
  "smart-auto": "Smart Auto",
  "manual-pause": "Paused",
  "all-auto": "All Auto",
};

const NEXT_RELAY_MODE: Record<RelayMode, RelayMode> = {
  "smart-auto": "all-auto",
  "all-auto": "manual-pause",
  "manual-pause": "smart-auto",
};

function quickHash(input: string): string {
  let h1 = 0xdeadbeef ^ input.length;
  let h2 = 0x41c6ce57 ^ input.length;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

interface PillDomRefs {
  host: HTMLDivElement;
  container: HTMLDivElement;
  dot: HTMLSpanElement;
  agentLabel: HTMLSpanElement;
  adapterBadge: HTMLSpanElement;
  modeBadge: HTMLButtonElement;
  queueBadge: HTMLSpanElement;
  body: HTMLDivElement;
  statusLine: HTMLDivElement;
  pauseResumeBtn: HTMLButtonElement;
  flushBtn: HTMLButtonElement;
  bootstrapBtn: HTMLButtonElement;
  collapseBtn: HTMLButtonElement;
}

function initAgentBusContentBridge(): void {
  let adapterId: AdapterId = "auto";
  let customSelectors: CustomSelectorConfig = {};
  let adapter: WebChatAdapter = resolveAdapter("auto", window.location.href);
  let sessionState: TabBusSessionState | null = null;
  let wasAttached = false;

  let baselineTurnCount = 0;
  const baselineTurnHashes = new Map<number, string>();
  const emittedTurnBlocks = new Set<string>();
  const recentBlockEmittedAt = new Map<string, number>();

  let lastObservedSignature = "";
  let lastReportedGenerating: boolean | null = null;
  let pendingInjectedTurnUntil = 0;
  let turnCountAtLastInject = 0;
  let stabilityTimer: Timer | number | undefined;
  let observerThrottleTimer: Timer | number | undefined;

  let pillRefs: PillDomRefs | null = null;
  let pillCollapsed = false;

  function sendToBackground(message: unknown): void {
    try {
      chrome.runtime.sendMessage(message, () => {
        // Swallow runtime.lastError when SW is waking or no listener responded
        void chrome.runtime.lastError;
      });
    } catch {
      // Ignore extension context invalidation on extension reload
    }
  }

  function captureTurnBaseline(): void {
    const turns = adapter.getAssistantTurns();
    baselineTurnCount = turns.length;
    baselineTurnHashes.clear();
    for (let i = 0; i < turns.length; i += 1) {
      const turn = turns[i];
      if (turn) {
        baselineTurnHashes.set(i, quickHash(turn.text));
      }
    }
    lastObservedSignature = computeTurnsSignature(turns);
  }

  function computeTurnsSignature(turns: AssistantTurnSnapshot[]): string {
    if (turns.length === 0) return "0";
    return turns.map((t, idx) => `${idx}:${t.text.length}:${quickHash(t.text)}`).join("|");
  }

  function reportGenerationState(generating: boolean): void {
    if (lastReportedGenerating === generating) return;
    lastReportedGenerating = generating;
    sendToBackground({
      type: "TAB_GENERATION_STATE",
      isGenerating: generating,
    });
    renderPill();
  }

  async function collectReferencedBlobDownloads(
    turn: AssistantTurnSnapshot,
    referencedText: string
  ): Promise<SerializedFilePayload[]> {
    if (turn.downloadLinks.length === 0) return [];
    const results: SerializedFilePayload[] = [];
    const lowerText = referencedText.toLowerCase();

    for (const link of turn.downloadLinks) {
      if (!link.href.startsWith("blob:")) continue;
      if (!lowerText.includes(link.filename.toLowerCase())) continue;

      try {
        const resp = await fetch(link.href);
        if (!resp.ok) continue;
        const buf = await resp.arrayBuffer();
        if (buf.byteLength === 0 || buf.byteLength > MAX_BLOB_EGRESS_BYTES) continue;
        const bytes = new Uint8Array(buf);
        const mimeType = resp.headers.get("content-type") || "application/octet-stream";
        results.push({
          id: `blob-${quickHash(link.href)}`,
          filename: link.filename,
          mimeType,
          base64: encodeBytesToBase64(bytes),
          sizeBytes: bytes.byteLength,
        });
      } catch {
        // Ignore inaccessible blob URLs
      }
    }

    return results;
  }

  async function inspectCompletedTurns(turns: AssistantTurnSnapshot[]): Promise<void> {
    if (!sessionState?.attached) return;

    const now = Date.now();
    for (const [hash, ts] of recentBlockEmittedAt) {
      if (now - ts > RECENT_BLOCK_DEDUP_WINDOW_MS) {
        recentBlockEmittedAt.delete(hash);
      }
    }

    for (let idx = 0; idx < turns.length; idx += 1) {
      const turn = turns[idx];
      if (!turn || !turn.text.trim()) continue;

      const textHash = quickHash(turn.text);
      if (idx < baselineTurnCount && baselineTurnHashes.get(idx) === textHash) {
        continue;
      }

      const parsed = parseFencedBusActions(turn.text);
      if (parsed.actions.length === 0 || parsed.rawBlocks.length === 0) {
        continue;
      }

      const blocksSignature = quickHash(parsed.rawBlocks.join("\n---\n"));
      const turnBlockKey = `turn:${idx}:${blocksSignature}`;
      if (emittedTurnBlocks.has(turnBlockKey)) {
        continue;
      }

      const recentTs = recentBlockEmittedAt.get(blocksSignature);
      if (recentTs !== undefined && now - recentTs < RECENT_BLOCK_DEDUP_WINDOW_MS) {
        emittedTurnBlocks.add(turnBlockKey);
        continue;
      }

      emittedTurnBlocks.add(turnBlockKey);
      recentBlockEmittedAt.set(blocksSignature, now);

      const actionContents = parsed.actions
        .map((a) => ("content" in a && typeof a.content === "string" ? a.content : ""))
        .join("\n");
      const downloadedFiles = await collectReferencedBlobDownloads(turn, actionContents);

      sendToBackground({
        type: "OUTBOUND_BUS_ACTIONS",
        actions: parsed.actions,
        rawBlocks: parsed.rawBlocks,
        downloadedFiles: downloadedFiles.length > 0 ? downloadedFiles : undefined,
      });
    }
  }

  function scheduleStabilityCheck(): void {
    clearTimeout(stabilityTimer);
    const snapshotAtSchedule = lastObservedSignature;
    stabilityTimer = setTimeout(() => {
      stabilityTimer = undefined;
      if (!sessionState?.attached) return;

      const domGenerating = adapter.isGenerating();
      const turns = adapter.getAssistantTurns();
      const holdingForTtft =
        Date.now() < pendingInjectedTurnUntil && turns.length <= turnCountAtLastInject;

      if (domGenerating || holdingForTtft) {
        reportGenerationState(true);
        scheduleStabilityCheck();
        return;
      }

      const currentSig = computeTurnsSignature(turns);
      if (currentSig !== snapshotAtSchedule) {
        lastObservedSignature = currentSig;
        scheduleStabilityCheck();
        return;
      }

      void inspectCompletedTurns(turns).finally(() => {
        if (!adapter.isGenerating()) {
          reportGenerationState(false);
        }
      });
    }, STABILITY_DEBOUNCE_MS);
  }

  function evaluateStreamActivity(): void {
    if (!sessionState?.attached) return;

    const domGenerating = adapter.isGenerating();
    const turns = adapter.getAssistantTurns();

    if (domGenerating || turns.length > turnCountAtLastInject) {
      pendingInjectedTurnUntil = 0;
    }

    const holdingForTtft =
      Date.now() < pendingInjectedTurnUntil && turns.length <= turnCountAtLastInject;
    const effectiveGenerating = domGenerating || holdingForTtft;
    const currentSignature = computeTurnsSignature(turns);

    if (effectiveGenerating) {
      clearTimeout(stabilityTimer);
      stabilityTimer = undefined;
      lastObservedSignature = currentSignature;
      reportGenerationState(true);
      return;
    }

    if (currentSignature !== lastObservedSignature || lastReportedGenerating === true) {
      lastObservedSignature = currentSignature;
      if (stabilityTimer === undefined) {
        scheduleStabilityCheck();
      }
    }
  }

  async function handleInjectTurnBatch(
    promptText: string,
    serializedFiles: SerializedFilePayload[]
  ): Promise<ExtensionResponse> {
    const fileObjects: File[] = serializedFiles.map((item) => {
      const bytes = decodeBase64ToBytes(item.base64);
      return new File([toOwnedArrayBuffer(bytes)], item.filename, {
        type: item.mimeType || "application/octet-stream",
      });
    });

    turnCountAtLastInject = adapter.getAssistantTurns().length;
    pendingInjectedTurnUntil = Date.now() + POST_INJECT_TTFT_HOLD_MS;
    reportGenerationState(true);

    const submitResult = await adapter.submitTurn(promptText, fileObjects);
    if (!submitResult.ok) {
      pendingInjectedTurnUntil = 0;
      reportGenerationState(false);
      return {
        ok: false,
        error: submitResult.error ?? "Failed to inject turn into Web Chat UI",
      };
    }

    scheduleStabilityCheck();
    return { ok: true, dispatched: true };
  }

  function ensureStatusPillMounted(): PillDomRefs | null {
    if (pillRefs && pillRefs.host.isConnected) {
      return pillRefs;
    }
    const mountParent = document.body ?? document.documentElement;
    if (!mountParent) return null;

    const existing = document.getElementById("agent-bus-shadow-host");
    if (existing) {
      existing.remove();
    }

    const host = document.createElement("div");
    host.id = "agent-bus-shadow-host";
    host.style.cssText =
      "position:fixed;right:16px;bottom:16px;z-index:2147483646;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;";

    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      .pill-card {
        background: rgba(15, 23, 42, 0.95);
        color: #f8fafc;
        border: 1px solid rgba(148, 163, 184, 0.28);
        border-radius: 12px;
        box-shadow: 0 10px 28px rgba(2, 6, 23, 0.55);
        backdrop-filter: blur(10px);
        min-width: 248px;
        max-width: 330px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 12px;
        line-height: 1.35;
        user-select: none;
        overflow: hidden;
      }
      .pill-card.collapsed {
        min-width: auto;
        border-radius: 999px;
      }
      .pill-header {
        display: flex;
        align-items: center;
        gap: 7px;
        padding: 7px 10px;
        cursor: grab;
        background: rgba(30, 41, 59, 0.72);
      }
      .pill-header:active { cursor: grabbing; }
      .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
        background: #64748b;
      }
      .dot.connected { background: #22c55e; box-shadow: 0 0 8px rgba(34, 197, 94, 0.7); }
      .dot.busy { background: #f59e0b; box-shadow: 0 0 8px rgba(245, 158, 11, 0.7); }
      .dot.error { background: #ef4444; }
      .agent-id {
        font-weight: 600;
        color: #e2e8f0;
        max-width: 120px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .badge {
        font-size: 10px;
        padding: 2px 6px;
        border-radius: 999px;
        background: rgba(51, 65, 85, 0.9);
        color: #cbd5e1;
        border: 1px solid rgba(148, 163, 184, 0.22);
        white-space: nowrap;
      }
      .mode-btn {
        font-size: 10px;
        padding: 2px 7px;
        border-radius: 999px;
        border: 1px solid rgba(99, 102, 241, 0.45);
        background: rgba(79, 70, 229, 0.25);
        color: #c7d2fe;
        cursor: pointer;
        white-space: nowrap;
      }
      .mode-btn.paused {
        border-color: rgba(245, 158, 11, 0.5);
        background: rgba(245, 158, 11, 0.18);
        color: #fde68a;
      }
      .queue-chip {
        margin-left: auto;
        font-size: 10px;
        font-weight: 600;
        padding: 2px 6px;
        border-radius: 999px;
        background: rgba(15, 118, 110, 0.35);
        color: #5eead4;
      }
      .collapse-btn {
        background: transparent;
        border: none;
        color: #94a3b8;
        cursor: pointer;
        padding: 0 2px;
        font-size: 12px;
        line-height: 1;
      }
      .collapse-btn:hover { color: #f8fafc; }
      .pill-body {
        padding: 8px 10px 9px;
        display: flex;
        flex-direction: column;
        gap: 7px;
      }
      .pill-card.collapsed .pill-body {
        display: none;
      }
      .status-line {
        display: flex;
        justify-content: space-between;
        color: #94a3b8;
        font-size: 11px;
      }
      .btn-row {
        display: flex;
        gap: 6px;
      }
      .action-btn {
        flex: 1;
        padding: 5px 7px;
        border-radius: 6px;
        border: 1px solid rgba(148, 163, 184, 0.25);
        background: rgba(30, 41, 59, 0.9);
        color: #e2e8f0;
        font-size: 11px;
        font-weight: 500;
        cursor: pointer;
        transition: background 0.12s ease;
      }
      .action-btn:hover:not(:disabled) {
        background: rgba(51, 65, 85, 0.95);
      }
      .action-btn:disabled {
        opacity: 0.45;
        cursor: default;
      }
      .action-btn.primary {
        border-color: rgba(56, 189, 248, 0.45);
        background: rgba(14, 116, 144, 0.35);
        color: #bae6fd;
      }
    `;

    const container = document.createElement("div");
    container.className = "pill-card";

    const header = document.createElement("div");
    header.className = "pill-header";

    const dot = document.createElement("span");
    dot.className = "dot";

    const agentLabel = document.createElement("span");
    agentLabel.className = "agent-id";
    agentLabel.textContent = "@agent";

    const adapterBadge = document.createElement("span");
    adapterBadge.className = "badge";
    adapterBadge.textContent = adapter.name;

    const modeBadge = document.createElement("button");
    modeBadge.type = "button";
    modeBadge.className = "mode-btn";
    modeBadge.title = "Click to cycle Relay Mode";

    const queueBadge = document.createElement("span");
    queueBadge.className = "queue-chip";
    queueBadge.textContent = "Q:0";

    const collapseBtn = document.createElement("button");
    collapseBtn.type = "button";
    collapseBtn.className = "collapse-btn";
    collapseBtn.textContent = "▾";
    collapseBtn.title = "Collapse / Expand";

    header.append(dot, agentLabel, adapterBadge, modeBadge, queueBadge, collapseBtn);

    const body = document.createElement("div");
    body.className = "pill-body";

    const statusLine = document.createElement("div");
    statusLine.className = "status-line";

    const btnRow = document.createElement("div");
    btnRow.className = "btn-row";

    const pauseResumeBtn = document.createElement("button");
    pauseResumeBtn.type = "button";
    pauseResumeBtn.className = "action-btn";
    pauseResumeBtn.textContent = "Pause";

    const flushBtn = document.createElement("button");
    flushBtn.type = "button";
    flushBtn.className = "action-btn primary";
    flushBtn.textContent = "Flush Now";

    const bootstrapBtn = document.createElement("button");
    bootstrapBtn.type = "button";
    bootstrapBtn.className = "action-btn";
    bootstrapBtn.textContent = "Bootstrap";

    btnRow.append(pauseResumeBtn, flushBtn, bootstrapBtn);
    body.append(statusLine, btnRow);
    container.append(header, body);
    shadow.append(style, container);
    mountParent.appendChild(host);

    // Drag handling on header
    let dragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let initialRight = 16;
    let initialBottom = 16;

    header.addEventListener("pointerdown", (ev: PointerEvent) => {
      const target = ev.target as HTMLElement | null;
      if (target && target.tagName.toUpperCase() === "BUTTON") return;
      dragging = true;
      dragStartX = ev.clientX;
      dragStartY = ev.clientY;
      const rect = host.getBoundingClientRect();
      initialRight = Math.max(8, window.innerWidth - rect.right);
      initialBottom = Math.max(8, window.innerHeight - rect.bottom);
      header.setPointerCapture(ev.pointerId);
    });

    header.addEventListener("pointermove", (ev: PointerEvent) => {
      if (!dragging) return;
      const dx = ev.clientX - dragStartX;
      const dy = ev.clientY - dragStartY;
      const nextRight = Math.min(
        Math.max(8, initialRight - dx),
        Math.max(8, window.innerWidth - 120)
      );
      const nextBottom = Math.min(
        Math.max(8, initialBottom - dy),
        Math.max(8, window.innerHeight - 48)
      );
      host.style.right = `${nextRight}px`;
      host.style.bottom = `${nextBottom}px`;
    });

    header.addEventListener("pointerup", (ev: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      try {
        header.releasePointerCapture(ev.pointerId);
      } catch {
        // Ignore
      }
    });

    collapseBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      pillCollapsed = !pillCollapsed;
      renderPill();
    });

    modeBadge.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (!sessionState) return;
      const next = NEXT_RELAY_MODE[sessionState.relayMode];
      sendToBackground({ type: "PILL_SET_RELAY_MODE", relayMode: next });
    });

    pauseResumeBtn.addEventListener("click", () => {
      if (!sessionState) return;
      const next: RelayMode =
        sessionState.relayMode === "manual-pause" ? "smart-auto" : "manual-pause";
      sendToBackground({ type: "PILL_SET_RELAY_MODE", relayMode: next });
    });

    flushBtn.addEventListener("click", () => {
      sendToBackground({ type: "PILL_FLUSH_NOW" });
    });

    bootstrapBtn.addEventListener("click", () => {
      sendToBackground({ type: "PILL_SEND_BOOTSTRAP" });
    });

    pillRefs = {
      host,
      container,
      dot,
      agentLabel,
      adapterBadge,
      modeBadge,
      queueBadge,
      body,
      statusLine,
      pauseResumeBtn,
      flushBtn,
      bootstrapBtn,
      collapseBtn,
    };

    return pillRefs;
  }

  function renderPill(): void {
    if (!sessionState || !sessionState.attached) {
      if (pillRefs) {
        pillRefs.host.style.display = "none";
      }
      return;
    }

    const refs = ensureStatusPillMounted();
    if (!refs) return;

    refs.host.style.display = "block";
    refs.container.classList.toggle("collapsed", pillCollapsed);
    refs.collapseBtn.textContent = pillCollapsed ? "▴" : "▾";

    const isBusy = sessionState.isGenerating || lastReportedGenerating === true;
    refs.dot.className = "dot";
    if (sessionState.connectionState === "error" || sessionState.connectionState === "disconnected") {
      refs.dot.classList.add("error");
    } else if (isBusy || sessionState.connectionState !== "connected") {
      refs.dot.classList.add("busy");
    } else {
      refs.dot.classList.add("connected");
    }

    refs.agentLabel.textContent = `@${sessionState.agentId}`;
    refs.adapterBadge.textContent = adapter.name;
    refs.adapterBadge.style.display = pillCollapsed ? "none" : "inline-block";

    const modeText = RELAY_MODE_LABELS[sessionState.relayMode];
    refs.modeBadge.textContent = modeText;
    refs.modeBadge.classList.toggle("paused", sessionState.relayMode === "manual-pause");
    refs.modeBadge.style.display = pillCollapsed ? "none" : "inline-block";

    const queuedTotal = sessionState.totalQueuedCount;
    const passiveCount = sessionState.passiveContextCount;
    refs.queueBadge.textContent =
      passiveCount > 0 ? `Q:${queuedTotal} (+${passiveCount})` : `Q:${queuedTotal}`;

    const connLabel =
      sessionState.connectionState === "connected"
        ? isBusy
          ? "LLM Streaming..."
          : "Bus Connected"
        : sessionState.connectionState;
    refs.statusLine.textContent = `${connLabel} •Queued: ${queuedTotal} (ctx: ${passiveCount})`;

    refs.pauseResumeBtn.textContent =
      sessionState.relayMode === "manual-pause" ? "Resume" : "Pause";
    refs.flushBtn.textContent = queuedTotal > 0 ? `Flush Now (${queuedTotal})` : "Flush Now";
    refs.flushBtn.disabled = queuedTotal === 0 && passiveCount === 0;
  }

  function updateAdapter(nextId: AdapterId, nextCustom?: CustomSelectorConfig, resetBaseline = false): void {
    adapterId = nextId;
    if (nextCustom !== undefined) {
      customSelectors = nextCustom;
    }
    adapter = resolveAdapter(adapterId, window.location.href, customSelectors);
    if (resetBaseline) {
      captureTurnBaseline();
    }
    renderPill();
  }

  chrome.runtime.onMessage.addListener((rawMessage: unknown, _sender, sendResponse) => {
    if (!isRuntimeMessage(rawMessage)) {
      return false;
    }

    switch (rawMessage.type) {
      case "PING_CONTENT": {
        sendResponse({
          ok: true,
          detectedAdapter: detectAdapterIdForUrl(window.location.href),
        });
        return false;
      }

      case "CONFIGURE_ADAPTER": {
        updateAdapter(
          rawMessage.adapterId,
          rawMessage.customSelectors,
          rawMessage.resetBaseline ?? false
        );
        sendResponse({ ok: true });
        return false;
      }

      case "SESSION_STATE_UPDATE": {
        const nextState = rawMessage.state;
        const becomingAttached = Boolean(nextState?.attached) && !wasAttached;
        sessionState = nextState;

        if (nextState) {
          adapterId = nextState.adapterId;
          if (nextState.customSelectors) {
            customSelectors = nextState.customSelectors;
          }
          adapter = resolveAdapter(adapterId, window.location.href, customSelectors);
        }

        if (becomingAttached) {
          wasAttached = true;
          lastReportedGenerating = null;
          captureTurnBaseline();
          evaluateStreamActivity();
        } else if (!nextState?.attached) {
          wasAttached = false;
          lastReportedGenerating = null;
          pendingInjectedTurnUntil = 0;
          clearTimeout(stabilityTimer);
          stabilityTimer = undefined;
        }

        renderPill();
        sendResponse({ ok: true });
        return false;
      }

      case "INJECT_TURN_BATCH": {
        void handleInjectTurnBatch(rawMessage.promptText, rawMessage.files)
          .then((res) => sendResponse(res))
          .catch((err: unknown) =>
            sendResponse({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            })
          );
        return true;
      }

      default:
        return false;
    }
  });

  // Initial baseline snapshot before attaching
  captureTurnBaseline();

  // Observe DOM mutations (throttled) + periodic poll for Shadow-DOM web components (e.g. Gemini)
  const observer = new MutationObserver(() => {
    if (!sessionState?.attached) return;
    if (observerThrottleTimer !== undefined) return;
    observerThrottleTimer = setTimeout(() => {
      observerThrottleTimer = undefined;
      evaluateStreamActivity();
    }, 180);
  });

  if (document.documentElement) {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["disabled", "aria-disabled", "aria-busy", "data-is-streaming", "class"],
    });
  }

  setInterval(() => {
    if (sessionState?.attached) {
      evaluateStreamActivity();
    }
  }, 550);

  // Announce readiness to background service worker
  sendToBackground({
    type: "CONTENT_READY",
    url: window.location.href,
    title: document.title || window.location.hostname,
    detectedAdapter: detectAdapterIdForUrl(window.location.href),
    isGenerating: adapter.isGenerating(),
  });
}

if (!window.__AGENT_BUS_CONTENT_LOADED__) {
  window.__AGENT_BUS_CONTENT_LOADED__ = true;
  initAgentBusContentBridge();
}
