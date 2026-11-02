/// <reference types="chrome" />

import {
  ANNOUNCEMENTS_CHANNEL_ID,
  isJsonObject,
  slugifyId,
  type AgentInfo,
  type ChannelInfo,
} from "@agent-bus/protocol";
import { detectAdapterIdForUrl } from "./adapters";
import {
  DEFAULT_EXTENSION_SETTINGS,
  encodeBytesToBase64,
  isRuntimeMessage,
  type AdapterId,
  type CustomSelectorConfig,
  type ExtensionResponse,
  type ExtensionSavedSettings,
  type PanelToBackgroundMessage,
  type RelayMode,
  type ResolvedAdapterId,
  type TabBusSessionState,
} from "./types";

const MODE_DESCRIPTIONS: Record<RelayMode, string> = {
  "smart-auto":
    "Auto-relays @mentions, private channels, joined topics & invites. Buffers unmentioned #announcements as passive context.",
  "manual-pause":
    "Queues all inbound messages and invites without triggering LLM turns until you click Flush Queue or resume.",
  "all-auto":
    "Auto-relays every accessible bus message (including all #announcements) and channel invite immediately.",
};

const SUGGESTED_IDENTITIES: Record<
  ResolvedAdapterId,
  { idPrefix: string; displayName: string }
> = {
  chatgpt: { idPrefix: "chatgpt-web", displayName: "ChatGPT Web" },
  claude: { idPrefix: "claude-web", displayName: "Claude Web" },
  gemini: { idPrefix: "gemini-web", displayName: "Gemini Web" },
  generic: { idPrefix: "web-chat", displayName: "Custom Web Chat" },
};

function requireEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing panel element #${id}`);
  }
  return el as T;
}

function sendPanelMessage(message: PanelToBackgroundMessage): Promise<ExtensionResponse> {
  const { promise, resolve } = Promise.withResolvers<ExtensionResponse>();
  try {
    chrome.runtime.sendMessage(message, (resp: unknown) => {
      if (chrome.runtime.lastError) {
        resolve({
          ok: false,
          error: chrome.runtime.lastError.message ?? "Background worker unavailable",
        });
        return;
      }
      if (isJsonObject(resp) && typeof resp.ok === "boolean") {
        resolve(resp as unknown as ExtensionResponse);
        return;
      }
      resolve({ ok: false, error: "Invalid response from background worker" });
    });
  } catch (err) {
    resolve({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return promise;
}

function initPanel(): void {
  const isSidePanelView = new URLSearchParams(window.location.search).get("view") === "sidepanel";
  if (isSidePanelView || window.innerHeight > 640) {
    document.body.classList.add("is-sidepanel");
  }

  const connDot = requireEl<HTMLSpanElement>("conn-dot");
  const connLabel = requireEl<HTMLParagraphElement>("conn-label");
  const openSidePanelBtn = requireEl<HTMLButtonElement>("open-sidepanel-btn");
  const tabHostLabel = requireEl<HTMLSpanElement>("tab-host-label");
  const detectedAdapterChip = requireEl<HTMLSpanElement>("detected-adapter-chip");
  const feedbackBanner = requireEl<HTMLDivElement>("feedback-banner");

  const busUrlInput = requireEl<HTMLInputElement>("bus-url-input");
  const networkKeyInput = requireEl<HTMLInputElement>("network-key-input");
  const agentIdInput = requireEl<HTMLInputElement>("agent-id-input");
  const displayNameInput = requireEl<HTMLInputElement>("display-name-input");
  const adapterSelect = requireEl<HTMLSelectElement>("adapter-select");
  const customSelectorsDetails = requireEl<HTMLDetailsElement>("custom-selectors-details");

  const selComposer = requireEl<HTMLInputElement>("sel-composer");
  const selSend = requireEl<HTMLInputElement>("sel-send");
  const selStop = requireEl<HTMLInputElement>("sel-stop");
  const selAssistant = requireEl<HTMLInputElement>("sel-assistant");
  const selFile = requireEl<HTMLInputElement>("sel-file");
  const selDrop = requireEl<HTMLInputElement>("sel-drop");
  const applySelectorsBtn = requireEl<HTMLButtonElement>("apply-selectors-btn");

  const attachBtn = requireEl<HTMLButtonElement>("attach-btn");
  const detachBtn = requireEl<HTMLButtonElement>("detach-btn");

  const modeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".seg-btn"));
  const modeHint = requireEl<HTMLParagraphElement>("mode-hint");
  const streamStateChip = requireEl<HTMLSpanElement>("stream-state-chip");

  const statTriggering = requireEl<HTMLSpanElement>("stat-triggering");
  const statInvites = requireEl<HTMLSpanElement>("stat-invites");
  const statPassive = requireEl<HTMLSpanElement>("stat-passive");
  const bootstrapBtn = requireEl<HTMLButtonElement>("bootstrap-btn");
  const flushBtn = requireEl<HTMLButtonElement>("flush-btn");

  const uploadChannelSelect = requireEl<HTMLSelectElement>("upload-channel-select");
  const uploadFileInput = requireEl<HTMLInputElement>("upload-file-input");
  const uploadMessageInput = requireEl<HTMLInputElement>("upload-message-input");
  const uploadSubmitBtn = requireEl<HTMLButtonElement>("upload-submit-btn");

  const agentsCountBadge = requireEl<HTMLSpanElement>("agents-count-badge");
  const refreshAgentsBtn = requireEl<HTMLButtonElement>("refresh-agents-btn");
  const onlineAgentsList = requireEl<HTMLUListElement>("online-agents-list");

  if (isSidePanelView) {
    openSidePanelBtn.classList.add("hidden");
  }

  let activeTabId: number | null = null;
  let activeWindowId: number | null = null;
  let activeTabUrl = "";
  let currentSettings: ExtensionSavedSettings = { ...DEFAULT_EXTENSION_SETTINGS };
  let currentState: TabBusSessionState | null = null;
  let selectedRelayMode: RelayMode = "smart-auto";
  let identityEditedByUser = false;
  let bannerTimer: Timer | number | undefined;

  function showBanner(text: string, variant: "error" | "success"): void {
    clearTimeout(bannerTimer);
    feedbackBanner.textContent = text;
    feedbackBanner.className = `banner ${variant}`;
    bannerTimer = setTimeout(() => {
      feedbackBanner.classList.add("hidden");
    }, 4500);
  }

  function readCustomSelectorsFromInputs(): CustomSelectorConfig {
    return {
      composerSelector: selComposer.value.trim() || undefined,
      sendButtonSelector: selSend.value.trim() || undefined,
      stopButtonSelector: selStop.value.trim() || undefined,
      assistantMessageSelector: selAssistant.value.trim() || undefined,
      fileInputSelector: selFile.value.trim() || undefined,
      dropZoneSelector: selDrop.value.trim() || undefined,
    };
  }

  function populateSelectorInputs(selectors: CustomSelectorConfig | undefined): void {
    selComposer.value = selectors?.composerSelector ?? "";
    selSend.value = selectors?.sendButtonSelector ?? "";
    selStop.value = selectors?.stopButtonSelector ?? "";
    selAssistant.value = selectors?.assistantMessageSelector ?? "";
    selFile.value = selectors?.fileInputSelector ?? "";
    selDrop.value = selectors?.dropZoneSelector ?? "";
  }

  function suggestIdentityFromTab(urlStr: string): void {
    if (identityEditedByUser || currentState?.attached) return;
    const detected = detectAdapterIdForUrl(urlStr);
    const suggestion = SUGGESTED_IDENTITIES[detected];
    if (detected === "generic") {
      try {
        const host = new URL(urlStr).hostname.replace(/^www\./, "");
        const slugHost = slugifyId(host.split(".")[0] || "web", "web");
        agentIdInput.value = `${slugHost}-web`;
        displayNameInput.value = host ? `Web (${host})` : suggestion.displayName;
        return;
      } catch {
        // Fallback below
      }
    }
    agentIdInput.value = suggestion.idPrefix;
    displayNameInput.value = suggestion.displayName;
  }

  function renderRelayModeControls(mode: RelayMode): void {
    selectedRelayMode = mode;
    for (const btn of modeButtons) {
      btn.classList.toggle("active", btn.dataset.mode === mode);
    }
    modeHint.textContent = MODE_DESCRIPTIONS[mode];
  }

  function renderChannelsDropdown(channels: ChannelInfo[]): void {
    const previousValue = uploadChannelSelect.value || ANNOUNCEMENTS_CHANNEL_ID;
    uploadChannelSelect.replaceChildren();

    const list =
      channels.length > 0
        ? channels
        : [
            {
              id: ANNOUNCEMENTS_CHANNEL_ID,
              name: "announcements",
              type: "public" as const,
              createdBy: "system",
              createdAt: 0,
              updatedAt: 0,
              members: [],
            },
          ];

    for (const ch of list) {
      const opt = document.createElement("option");
      opt.value = ch.id;
      const prefix = ch.type === "private" ? "🔒 " : "#";
      opt.textContent = `${prefix}${ch.name} (${ch.id})`;
      uploadChannelSelect.appendChild(opt);
    }

    if (list.some((c) => c.id === previousValue)) {
      uploadChannelSelect.value = previousValue;
    } else {
      uploadChannelSelect.value = ANNOUNCEMENTS_CHANNEL_ID;
    }
  }

  function renderOnlineAgents(agents: AgentInfo[], selfId?: string): void {
    agentsCountBadge.textContent = String(agents.length);
    onlineAgentsList.replaceChildren();

    if (agents.length === 0) {
      const empty = document.createElement("li");
      empty.className = "empty-item";
      empty.textContent = "No online agents discovered yet.";
      onlineAgentsList.appendChild(empty);
      return;
    }

    for (const agent of agents) {
      const item = document.createElement("li");
      item.className = "agent-item";

      const main = document.createElement("div");
      main.className = "agent-main";

      const dot = document.createElement("span");
      dot.className = `agent-dot ${agent.status}`;

      const names = document.createElement("div");
      names.className = "agent-names";

      const handle = document.createElement("span");
      handle.className = "agent-handle";
      handle.textContent =
        selfId && agent.id === selfId ? `@${agent.id} (this tab)` : `@${agent.id}`;

      const display = document.createElement("span");
      display.className = "agent-display";
      display.textContent = `${agent.displayName} • ${agent.status}`;

      names.append(handle, display);
      main.append(dot, names);

      const kindBadge = document.createElement("span");
      kindBadge.className = "agent-kind";
      kindBadge.textContent = agent.platform ? `${agent.kind}/${agent.platform}` : agent.kind;

      item.append(main, kindBadge);
      onlineAgentsList.appendChild(item);
    }
  }

  function renderState(state: TabBusSessionState | null, settings?: ExtensionSavedSettings): void {
    if (settings) {
      currentSettings = settings;
    }
    currentState = state;

    const attached = Boolean(state?.attached);

    if (!attached) {
      connDot.className = "status-dot disconnected";
      connLabel.textContent = "Detached";

      busUrlInput.disabled = false;
      networkKeyInput.disabled = false;
      agentIdInput.disabled = false;
      displayNameInput.disabled = false;

      if (!busUrlInput.value) {
        busUrlInput.value = currentSettings.busUrl;
      }
      if (!networkKeyInput.value && currentSettings.networkKey) {
        networkKeyInput.value = currentSettings.networkKey;
      }

      attachBtn.classList.remove("hidden");
      detachBtn.classList.add("hidden");

      streamStateChip.textContent = "Detached";
      streamStateChip.className = "chip subtle";

      statTriggering.textContent = "0";
      statInvites.textContent = "0";
      statPassive.textContent = "0";

      bootstrapBtn.disabled = true;
      flushBtn.disabled = true;
      flushBtn.textContent = "Flush Queue (0)";
      uploadSubmitBtn.disabled = true;

      renderRelayModeControls(currentSettings.defaultRelayMode);
      renderChannelsDropdown([]);
      renderOnlineAgents(state?.onlineAgents ?? []);
      return;
    }

    if (!state) return;

    connDot.className = `status-dot ${state.connectionState}`;
    connLabel.textContent =
      state.connectionState === "connected"
        ? `Connected as @${state.agentId}`
        : `${state.connectionState} (@${state.agentId})`;

    busUrlInput.value = state.busUrl;
    agentIdInput.value = state.agentId;
    displayNameInput.value = state.displayName;
    adapterSelect.value = state.adapterId;

    busUrlInput.disabled = true;
    networkKeyInput.disabled = true;
    agentIdInput.disabled = true;
    displayNameInput.disabled = true;

    attachBtn.classList.add("hidden");
    detachBtn.classList.remove("hidden");

    detectedAdapterChip.textContent = state.resolvedAdapterName;

    if (state.isGenerating) {
      streamStateChip.textContent = "Streaming...";
      streamStateChip.className = "chip streaming";
    } else {
      streamStateChip.textContent = "Idle";
      streamStateChip.className = "chip subtle";
    }

    renderRelayModeControls(state.relayMode);

    statTriggering.textContent = String(state.queuedTriggerCount);
    statInvites.textContent = String(state.queuedInviteCount);
    statPassive.textContent = String(state.passiveContextCount);

    bootstrapBtn.disabled = false;
    const flushableCount = state.totalQueuedCount + state.passiveContextCount;
    flushBtn.disabled = flushableCount === 0;
    flushBtn.textContent = `Flush Queue (${state.totalQueuedCount})`;

    uploadSubmitBtn.disabled = !(uploadFileInput.files && uploadFileInput.files.length > 0);

    renderChannelsDropdown(state.channels);
    renderOnlineAgents(state.onlineAgents, state.agentId);

    if (state.lastError) {
      showBanner(state.lastError, "error");
    }
  }

  async function syncActiveTabContext(): Promise<void> {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab || tab.id === undefined) {
      tabHostLabel.textContent = "No active browser tab";
      attachBtn.disabled = true;
      return;
    }

    activeTabId = tab.id;
    activeWindowId = tab.windowId;
    activeTabUrl = tab.url ?? "";

    try {
      const parsed = new URL(activeTabUrl);
      tabHostLabel.textContent = `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`;
    } catch {
      tabHostLabel.textContent = tab.title || "Current Tab";
    }

    const detected = detectAdapterIdForUrl(activeTabUrl);
    detectedAdapterChip.textContent = detected.toUpperCase();

    const snapshot = await sendPanelMessage({
      type: "PANEL_GET_STATE",
      tabId: activeTabId,
    });

    if (snapshot.settings) {
      currentSettings = snapshot.settings;
      busUrlInput.value = snapshot.settings.busUrl;
      networkKeyInput.value = snapshot.settings.networkKey;
      adapterSelect.value = snapshot.settings.defaultAdapterId;
      populateSelectorInputs(snapshot.settings.customSelectors);
      if (snapshot.settings.defaultAdapterId === "generic") {
        customSelectorsDetails.open = true;
      }
    }

    identityEditedByUser = false;
    suggestIdentityFromTab(activeTabUrl);
    renderState(snapshot.state ?? null, snapshot.settings);

    if (!snapshot.state?.attached) {
      const netSnap = await sendPanelMessage({
        type: "PANEL_REFRESH_NETWORK",
        tabId: activeTabId,
      });
      if (netSnap.ok && netSnap.state) {
        renderOnlineAgents(netSnap.state.onlineAgents);
      }
    }
  }

  // Must invoke chrome.sidePanel.open synchronously inside user click gesture
  openSidePanelBtn.addEventListener("click", () => {
    if (!chrome.sidePanel?.open) {
      showBanner("Side Panel API not supported in this Chromium build", "error");
      return;
    }
    const openPromise =
      activeWindowId !== null
        ? chrome.sidePanel.open({ windowId: activeWindowId })
        : activeTabId !== null
          ? chrome.sidePanel.open({ tabId: activeTabId })
          : null;

    if (openPromise) {
      void openPromise
        .then(() => {
          window.close();
        })
        .catch((err: unknown) => {
          showBanner(err instanceof Error ? err.message : String(err), "error");
        });
    }
  });

  agentIdInput.addEventListener("input", () => {
    identityEditedByUser = true;
  });

  displayNameInput.addEventListener("input", () => {
    identityEditedByUser = true;
  });

  adapterSelect.addEventListener("change", () => {
    const chosen = adapterSelect.value as AdapterId;
    if (chosen === "generic") {
      customSelectorsDetails.open = true;
    }
    if (activeTabId !== null && currentState?.attached) {
      void sendPanelMessage({
        type: "PANEL_UPDATE_SELECTORS",
        tabId: activeTabId,
        adapterId: chosen,
        customSelectors: readCustomSelectorsFromInputs(),
      }).then((res) => {
        if (res.ok) {
          renderState(res.state ?? currentState, res.settings);
        }
      });
    }
  });

  applySelectorsBtn.addEventListener("click", () => {
    if (activeTabId === null) return;
    const chosen = adapterSelect.value as AdapterId;
    void sendPanelMessage({
      type: "PANEL_UPDATE_SELECTORS",
      tabId: activeTabId,
      adapterId: chosen,
      customSelectors: readCustomSelectorsFromInputs(),
    }).then((res) => {
      if (res.ok) {
        showBanner("Saved custom CSS selectors", "success");
        renderState(res.state ?? currentState, res.settings);
      } else if (res.error) {
        showBanner(res.error, "error");
      }
    });
  });

  attachBtn.addEventListener("click", () => {
    if (activeTabId === null) return;
    attachBtn.disabled = true;
    attachBtn.textContent = "Attaching...";

    void sendPanelMessage({
      type: "PANEL_ATTACH_TAB",
      tabId: activeTabId,
      busUrl: busUrlInput.value.trim() || DEFAULT_EXTENSION_SETTINGS.busUrl,
      networkKey: networkKeyInput.value,
      agentId: agentIdInput.value.trim() || undefined,
      displayName: displayNameInput.value.trim() || "Web Agent",
      adapterId: adapterSelect.value as AdapterId,
      relayMode: selectedRelayMode,
      customSelectors: readCustomSelectorsFromInputs(),
    })
      .then((res) => {
        if (!res.ok) {
          showBanner(res.error ?? "Failed to attach tab", "error");
          return;
        }
        showBanner(`Attached tab as @${res.state?.agentId ?? "agent"}`, "success");
        renderState(res.state ?? null, res.settings);
      })
      .finally(() => {
        attachBtn.disabled = false;
        attachBtn.textContent = "Attach Tab";
      });
  });

  detachBtn.addEventListener("click", () => {
    if (activeTabId === null) return;
    detachBtn.disabled = true;
    void sendPanelMessage({
      type: "PANEL_DETACH_TAB",
      tabId: activeTabId,
    })
      .then((res) => {
        renderState(null, res.settings);
        showBanner("Detached tab from bus", "success");
      })
      .finally(() => {
        detachBtn.disabled = false;
      });
  });

  for (const btn of modeButtons) {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.mode as RelayMode | undefined;
      if (!mode) return;
      renderRelayModeControls(mode);
      if (activeTabId === null) return;

      void sendPanelMessage({
        type: "PANEL_SET_RELAY_MODE",
        tabId: activeTabId,
        relayMode: mode,
      }).then((res) => {
        if (res.ok && res.state !== undefined) {
          renderState(res.state, res.settings);
        }
      });
    });
  }

  bootstrapBtn.addEventListener("click", () => {
    if (activeTabId === null) return;
    bootstrapBtn.disabled = true;
    void sendPanelMessage({
      type: "PANEL_SEND_BOOTSTRAP",
      tabId: activeTabId,
    })
      .then((res) => {
        if (!res.ok) {
          showBanner(res.error ?? "Failed to send bootstrap prompt", "error");
          return;
        }
        showBanner("Injected bootstrap prompt into chat", "success");
        if (res.state) renderState(res.state, res.settings);
      })
      .finally(() => {
        bootstrapBtn.disabled = !currentState?.attached;
      });
  });

  flushBtn.addEventListener("click", () => {
    if (activeTabId === null) return;
    flushBtn.disabled = true;
    void sendPanelMessage({
      type: "PANEL_FLUSH_QUEUE",
      tabId: activeTabId,
    }).then((res) => {
      if (!res.ok) {
        showBanner(res.error ?? "Queue flush failed", "error");
      } else if (res.dispatched) {
        showBanner("Flushed queued messages into chat", "success");
      }
      if (res.state !== undefined) {
        renderState(res.state, res.settings);
      }
    });
  });

  uploadFileInput.addEventListener("change", () => {
    uploadSubmitBtn.disabled =
      !currentState?.attached || !(uploadFileInput.files && uploadFileInput.files.length > 0);
  });

  uploadSubmitBtn.addEventListener("click", () => {
    if (activeTabId === null || !currentState?.attached) return;
    const selectedFile = uploadFileInput.files?.[0];
    if (!selectedFile) return;

    uploadSubmitBtn.disabled = true;
    uploadSubmitBtn.textContent = "Uploading...";

    void (async () => {
      const arrayBuf = await selectedFile.arrayBuffer();
      const base64 = encodeBytesToBase64(new Uint8Array(arrayBuf));
      const res = await sendPanelMessage({
        type: "PANEL_UPLOAD_FILE",
        tabId: activeTabId,
        channelId: uploadChannelSelect.value || ANNOUNCEMENTS_CHANNEL_ID,
        file: {
          filename: selectedFile.name,
          mimeType: selectedFile.type || "application/octet-stream",
          base64,
          sizeBytes: selectedFile.size,
        },
        message: uploadMessageInput.value.trim() || undefined,
      });

      if (!res.ok) {
        showBanner(res.error ?? "File upload failed", "error");
        return;
      }

      uploadFileInput.value = "";
      uploadMessageInput.value = "";
      showBanner(`Shared ${selectedFile.name} to #${uploadChannelSelect.value}`, "success");
      if (res.state) renderState(res.state, res.settings);
    })()
      .catch((err: unknown) => {
        showBanner(err instanceof Error ? err.message : String(err), "error");
      })
      .finally(() => {
        uploadSubmitBtn.textContent = "Upload & Share File";
        uploadSubmitBtn.disabled =
          !currentState?.attached || !(uploadFileInput.files && uploadFileInput.files.length > 0);
      });
  });

  refreshAgentsBtn.addEventListener("click", () => {
    if (activeTabId === null) return;
    void sendPanelMessage({
      type: "PANEL_REFRESH_NETWORK",
      tabId: activeTabId,
    }).then((res) => {
      if (!res.ok) {
        showBanner(res.error ?? "Could not reach bus server", "error");
        return;
      }
      if (res.state) {
        if (currentState?.attached) {
          renderState(res.state, res.settings);
        } else {
          renderOnlineAgents(res.state.onlineAgents);
        }
      }
    });
  });

  chrome.runtime.onMessage.addListener((raw: unknown) => {
    if (!isRuntimeMessage(raw)) return;
    if (raw.type === "PANEL_STATE_BROADCAST" && raw.tabId === activeTabId) {
      renderState(raw.state, raw.settings);
    }
  });

  chrome.tabs.onActivated.addListener(() => {
    void syncActiveTabContext();
  });

  void syncActiveTabContext();
}

document.addEventListener("DOMContentLoaded", initPanel);
