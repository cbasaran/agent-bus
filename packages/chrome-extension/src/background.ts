/// <reference types="chrome" />

import {
  ANNOUNCEMENTS_CHANNEL_ID,
  buildWebAgentBootstrapPrompt,
  isJsonObject,
  normalizeBusHttpUrl,
  slugifyId,
  toBusWsUrl,
  type AgentInfo,
  type AgentStatus,
  type BusMessage,
  type ChannelInfo,
  type ChannelInvite,
  type ClientWsFrame,
  type FileAttachment,
  type InlineBusFileSpec,
  type RegisterAgentRequest,
  type RegisterAgentResponse,
  type RequestPrivateChannelRequest,
  type RequestPrivateChannelResponse,
  type RespondChannelInviteRequest,
  type SendMessageRequest,
  type ServerWsFrame,
  type UpdateAgentRequest,
  type WebAgentBusAction,
} from "@agent-bus/protocol";
import { detectAdapterIdForUrl } from "./adapters";
import { SmartRelayQueue } from "./queue";
import {
  decodeBase64ToBytes,
  DEFAULT_EXTENSION_SETTINGS,
  encodeBytesToBase64,
  guessMimeTypeFromFilename,
  isRuntimeMessage,
  isTextLikeFile,
  toOwnedArrayBuffer,
  type AdapterId,
  type BackgroundToContentMessage,
  type BusConnectionState,
  type CustomSelectorConfig,
  type ExtensionResponse,
  type ExtensionSavedSettings,
  type RelayMode,
  type ResolvedAdapterId,
  type SerializedFilePayload,
  type TabBusSessionState,
} from "./types";

const KEEPALIVE_ALARM_NAME = "agent-bus-keepalive";
const WS_PING_INTERVAL_MS = 20_000;
const POST_DISPATCH_COOLDOWN_MS = 2_000;
const POST_TURN_COOLDOWN_MS = 1_200;
const MAX_AUTO_ATTACH_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_PREVIEW_BYTES = 16 * 1024;

const STORAGE_SETTINGS_KEY = "agentBusSavedSettings";
const STORAGE_SESSIONS_KEY = "agentBusActiveSessions";

const ADAPTER_DISPLAY_NAMES: Record<ResolvedAdapterId, string> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  gemini: "Gemini",
  generic: "Generic CSS",
};

interface PersistedTabRecord {
  tabId: number;
  busUrl: string;
  networkKey: string;
  agentId: string;
  displayName: string;
  sessionToken: string;
  adapterId: AdapterId;
  resolvedAdapterId: ResolvedAdapterId;
  relayMode: RelayMode;
  customSelectors?: CustomSelectorConfig;
  latestSeq: number;
  connectedAt?: number;
}

interface ActiveTabRuntimeSession {
  tabId: number;
  attached: boolean;
  busUrl: string;
  networkKey: string;
  agentId: string;
  displayName: string;
  sessionToken: string;
  adapterId: AdapterId;
  resolvedAdapterId: ResolvedAdapterId;
  relayMode: RelayMode;
  customSelectors: CustomSelectorConfig;
  connectionState: BusConnectionState;
  lastError?: string;
  isGenerating: boolean;
  latestSeq: number;
  connectedAt?: number;
  lastDispatchedAt?: number;

  queue: SmartRelayQueue;
  channelsMap: Map<string, ChannelInfo>;
  pendingInvitesMap: Map<string, ChannelInvite>;
  onlineAgentsMap: Map<string, AgentInfo>;

  ws: WebSocket | null;
  pingTimer: Timer | number | undefined;
  reconnectTimer: Timer | number | undefined;
  cooldownTimer: Timer | number | undefined;
  reconnectAttempt: number;
  dispatchInFlight: boolean;
}

const sessionsByTab = new Map<number, ActiveTabRuntimeSession>();
let savedSettings: ExtensionSavedSettings = { ...DEFAULT_EXTENSION_SETTINGS };
let hydrationPromise: Promise<void> | null = null;

function getSessionStorageArea(): chrome.storage.StorageArea {
  return chrome.storage.session ?? chrome.storage.local;
}

async function loadSavedSettings(): Promise<ExtensionSavedSettings> {
  try {
    const raw = await chrome.storage.local.get(STORAGE_SETTINGS_KEY);
    const stored = raw[STORAGE_SETTINGS_KEY];
    if (isJsonObject(stored)) {
      const customRaw = isJsonObject(stored.customSelectors) ? stored.customSelectors : {};
      savedSettings = {
        busUrl:
          typeof stored.busUrl === "string" && stored.busUrl.trim()
            ? stored.busUrl.trim()
            : DEFAULT_EXTENSION_SETTINGS.busUrl,
        networkKey: typeof stored.networkKey === "string" ? stored.networkKey : "",
        defaultRelayMode:
          stored.defaultRelayMode === "smart-auto" ||
          stored.defaultRelayMode === "manual-pause" ||
          stored.defaultRelayMode === "all-auto"
            ? stored.defaultRelayMode
            : DEFAULT_EXTENSION_SETTINGS.defaultRelayMode,
        defaultAdapterId:
          stored.defaultAdapterId === "auto" ||
          stored.defaultAdapterId === "chatgpt" ||
          stored.defaultAdapterId === "claude" ||
          stored.defaultAdapterId === "gemini" ||
          stored.defaultAdapterId === "generic"
            ? stored.defaultAdapterId
            : DEFAULT_EXTENSION_SETTINGS.defaultAdapterId,
        customSelectors: {
          composerSelector:
            typeof customRaw.composerSelector === "string" ? customRaw.composerSelector : undefined,
          sendButtonSelector:
            typeof customRaw.sendButtonSelector === "string"
              ? customRaw.sendButtonSelector
              : undefined,
          stopButtonSelector:
            typeof customRaw.stopButtonSelector === "string"
              ? customRaw.stopButtonSelector
              : undefined,
          assistantMessageSelector:
            typeof customRaw.assistantMessageSelector === "string"
              ? customRaw.assistantMessageSelector
              : undefined,
          fileInputSelector:
            typeof customRaw.fileInputSelector === "string"
              ? customRaw.fileInputSelector
              : undefined,
          dropZoneSelector:
            typeof customRaw.dropZoneSelector === "string" ? customRaw.dropZoneSelector : undefined,
        },
      };
    }
  } catch {
    // Keep defaults if storage unavailable
  }
  return savedSettings;
}

async function persistSavedSettings(patch: Partial<ExtensionSavedSettings>): Promise<void> {
  savedSettings = {
    ...savedSettings,
    ...patch,
    customSelectors: patch.customSelectors
      ? { ...savedSettings.customSelectors, ...patch.customSelectors }
      : savedSettings.customSelectors,
  };
  await chrome.storage.local.set({ [STORAGE_SETTINGS_KEY]: savedSettings });
}

async function persistActiveSessions(): Promise<void> {
  const records: Record<string, PersistedTabRecord> = {};
  for (const [tabId, session] of sessionsByTab) {
    if (!session.attached) continue;
    records[String(tabId)] = {
      tabId: session.tabId,
      busUrl: session.busUrl,
      networkKey: session.networkKey,
      agentId: session.agentId,
      displayName: session.displayName,
      sessionToken: session.sessionToken,
      adapterId: session.adapterId,
      resolvedAdapterId: session.resolvedAdapterId,
      relayMode: session.relayMode,
      customSelectors: session.customSelectors,
      latestSeq: session.latestSeq,
      connectedAt: session.connectedAt,
    };
  }
  try {
    await getSessionStorageArea().set({ [STORAGE_SESSIONS_KEY]: records });
  } catch {
    // Ignore storage write error
  }
}

function buildPublicSessionState(session: ActiveTabRuntimeSession): TabBusSessionState {
  return {
    tabId: session.tabId,
    attached: session.attached,
    busUrl: session.busUrl,
    agentId: session.agentId,
    displayName: session.displayName,
    adapterId: session.adapterId,
    resolvedAdapterName: ADAPTER_DISPLAY_NAMES[session.resolvedAdapterId],
    relayMode: session.relayMode,
    connectionState: session.connectionState,
    lastError: session.lastError,
    isGenerating: session.isGenerating,
    queuedTriggerCount: session.queue.triggeringCount,
    queuedInviteCount: session.queue.inviteCount,
    passiveContextCount: session.queue.passiveCount,
    totalQueuedCount: session.queue.totalQueuedCount,
    latestSeq: session.latestSeq,
    channels: Array.from(session.channelsMap.values()),
    pendingInvites: Array.from(session.pendingInvitesMap.values()),
    onlineAgents: Array.from(session.onlineAgentsMap.values()),
    customSelectors: session.customSelectors,
    connectedAt: session.connectedAt,
    lastDispatchedAt: session.lastDispatchedAt,
  };
}

function computeDesiredAgentStatus(session: ActiveTabRuntimeSession): AgentStatus {
  if (!session.attached) return "offline";
  if (session.relayMode === "manual-pause") return "paused";
  if (session.isGenerating) return "busy";
  return "online";
}

function sendMessageToTab(
  tabId: number,
  message: BackgroundToContentMessage
): Promise<ExtensionResponse | null> {
  const { promise, resolve } = Promise.withResolvers<ExtensionResponse | null>();
  try {
    chrome.tabs.sendMessage(tabId, message, (resp: unknown) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      if (isJsonObject(resp) && typeof resp.ok === "boolean") {
        resolve(resp as unknown as ExtensionResponse);
        return;
      }
      resolve({ ok: true });
    });
  } catch {
    resolve(null);
  }
  return promise;
}

async function ensureContentScriptReady(tabId: number): Promise<boolean> {
  const ping = await sendMessageToTab(tabId, { type: "PING_CONTENT" });
  if (ping?.ok) {
    return true;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  } catch {
    return false;
  }

  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 60);
  await promise;

  const secondPing = await sendMessageToTab(tabId, { type: "PING_CONTENT" });
  return Boolean(secondPing?.ok);
}

function broadcastTabState(tabId: number): void {
  const session = sessionsByTab.get(tabId);
  const state = session && session.attached ? buildPublicSessionState(session) : null;

  void sendMessageToTab(tabId, {
    type: "SESSION_STATE_UPDATE",
    state,
  });

  try {
    chrome.runtime.sendMessage(
      {
        type: "PANEL_STATE_BROADCAST",
        tabId,
        state,
        settings: savedSettings,
      },
      () => {
        void chrome.runtime.lastError;
      }
    );
  } catch {
    // Ignore when no panel views are open
  }
}

async function busJsonFetch<T>(
  busUrl: string,
  path: string,
  init: RequestInit = {},
  sessionToken?: string
): Promise<T> {
  const base = normalizeBusHttpUrl(busUrl);
  const headers = new Headers(init.headers);
  if (sessionToken) {
    headers.set("Authorization", `Bearer ${sessionToken}`);
  }
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const resp = await fetch(`${base}${path}`, {
    ...init,
    headers,
  });

  if (!resp.ok) {
    let detail = `${resp.status} ${resp.statusText}`;
    try {
      const errBody: unknown = await resp.json();
      if (isJsonObject(errBody) && typeof errBody.error === "string") {
        detail = errBody.error;
      } else if (isJsonObject(errBody) && typeof errBody.message === "string") {
        detail = errBody.message;
      }
    } catch {
      // Keep status text
    }
    throw new Error(detail);
  }

  return (await resp.json()) as T;
}

function sendWsFrame(session: ActiveTabRuntimeSession, frame: ClientWsFrame): boolean {
  if (!session.ws || session.ws.readyState !== WebSocket.OPEN) {
    return false;
  }
  try {
    session.ws.send(JSON.stringify(frame));
    return true;
  } catch {
    return false;
  }
}

async function syncAgentStatusToBus(session: ActiveTabRuntimeSession): Promise<void> {
  const status = computeDesiredAgentStatus(session);
  const sentViaWs = sendWsFrame(session, {
    type: "status.update",
    status,
    metadata: {
      tabId: session.tabId,
      adapterId: session.adapterId,
      relayMode: session.relayMode,
    },
  });

  if (!sentViaWs && session.sessionToken) {
    const body: UpdateAgentRequest = { status };
    try {
      await busJsonFetch<{ agent: AgentInfo }>(
        session.busUrl,
        "/api/agents/me",
        {
          method: "PATCH",
          body: JSON.stringify(body),
        },
        session.sessionToken
      );
    } catch {
      // Ignore transient network errors during status update
    }
  }
}

function scheduleCooldownCheck(session: ActiveTabRuntimeSession): void {
  clearTimeout(session.cooldownTimer);
  session.cooldownTimer = undefined;
  const now = Date.now();
  if (
    !session.attached ||
    session.relayMode === "manual-pause" ||
    session.isGenerating ||
    !session.queue.hasTriggeringItems()
  ) {
    return;
  }
  const remaining = session.queue.cooldownUntil - now;
  if (remaining > 0) {
    session.cooldownTimer = setTimeout(() => {
      session.cooldownTimer = undefined;
      void maybeDispatchQueue(session, false);
    }, remaining + 30);
  }
}

function containsNullByte(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 512);
  for (let i = 0; i < limit; i += 1) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

async function prepareAttachmentPayloads(
  session: ActiveTabRuntimeSession,
  attachments: FileAttachment[]
): Promise<{
  files: SerializedFilePayload[];
  inlinedFilesMap: Map<string, string>;
}> {
  const files: SerializedFilePayload[] = [];
  const inlinedFilesMap = new Map<string, string>();
  const baseHttp = normalizeBusHttpUrl(session.busUrl);

  for (const att of attachments) {
    if (att.sizeBytes > MAX_AUTO_ATTACH_BYTES) {
      continue;
    }

    let fileUrl: URL;
    if (att.downloadPath) {
      fileUrl = new URL(att.downloadPath, `${baseHttp}/`);
    } else {
      fileUrl = new URL(`${baseHttp}/api/files/${encodeURIComponent(att.id)}`);
    }
    if (att.ticket && !fileUrl.searchParams.has("ticket")) {
      fileUrl.searchParams.set("ticket", att.ticket);
    }

    try {
      const headers = new Headers();
      if (session.sessionToken) {
        headers.set("Authorization", `Bearer ${session.sessionToken}`);
      }
      const resp = await fetch(fileUrl.toString(), { headers });
      if (!resp.ok) continue;

      const arrayBuf = await resp.arrayBuffer();
      if (arrayBuf.byteLength > MAX_AUTO_ATTACH_BYTES) continue;

      const bytes = new Uint8Array(arrayBuf);
      const base64 = encodeBytesToBase64(bytes);

      let textPreview: string | undefined;
      if (
        bytes.byteLength <= MAX_TEXT_PREVIEW_BYTES &&
        isTextLikeFile(att.filename, att.mimeType) &&
        !containsNullByte(bytes)
      ) {
        textPreview = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
        inlinedFilesMap.set(att.id, textPreview);
      }

      files.push({
        id: att.id,
        filename: att.filename,
        mimeType: att.mimeType || "application/octet-stream",
        base64,
        sizeBytes: bytes.byteLength,
        textPreview,
      });
    } catch {
      // Skip attachment binary if unreachable; metadata line still renders in prompt
    }
  }

  return { files, inlinedFilesMap };
}

async function maybeDispatchQueue(
  session: ActiveTabRuntimeSession,
  force: boolean
): Promise<{ ok: boolean; dispatched: boolean; error?: string }> {
  if (!session.attached) {
    return { ok: false, dispatched: false, error: "Tab is not attached" };
  }
  if (session.dispatchInFlight) {
    return { ok: true, dispatched: false };
  }

  const now = Date.now();
  if (!force && !session.queue.canAutoDispatch(now)) {
    scheduleCooldownCheck(session);
    return { ok: true, dispatched: false };
  }

  if (force ? !session.queue.hasAnyItems() : !session.queue.hasTriggeringItems()) {
    return { ok: true, dispatched: false };
  }

  session.dispatchInFlight = true;
  try {
    const contentReady = await ensureContentScriptReady(session.tabId);
    if (!contentReady) {
      session.lastError = "Unable to reach content script on tab";
      broadcastTabState(session.tabId);
      return { ok: false, dispatched: false, error: session.lastError };
    }

    const pendingAttachments = session.queue.peekPendingAttachments(force);
    const { files, inlinedFilesMap } = await prepareAttachmentPayloads(
      session,
      pendingAttachments
    );

    const drained = session.queue.flush(force, session.channelsMap, inlinedFilesMap, Date.now());
    if (!drained || !drained.promptText) {
      return { ok: true, dispatched: false };
    }

    session.isGenerating = true;
    session.queue.setGenerating(true);
    session.queue.applyCooldown(POST_DISPATCH_COOLDOWN_MS);
    session.lastDispatchedAt = Date.now();
    session.lastError = undefined;
    void syncAgentStatusToBus(session);
    broadcastTabState(session.tabId);

    const injectResp = await sendMessageToTab(session.tabId, {
      type: "INJECT_TURN_BATCH",
      promptText: drained.promptText,
      files,
      reason: force ? "flush" : "auto",
    });

    if (!injectResp || !injectResp.ok) {
      session.isGenerating = false;
      session.queue.setGenerating(false);
      session.lastError = injectResp?.error ?? "Failed to inject prompt into chat composer";
      void syncAgentStatusToBus(session);
      broadcastTabState(session.tabId);
      return { ok: false, dispatched: false, error: session.lastError };
    }

    return { ok: true, dispatched: true };
  } finally {
    session.dispatchInFlight = false;
  }
}

async function uploadSingleFileToBus(
  session: ActiveTabRuntimeSession,
  channelId: string,
  filename: string,
  mimeType: string,
  bytes: Uint8Array
): Promise<FileAttachment> {
  const form = new FormData();
  form.set("channelId", channelId);
  form.set("filename", filename);
  form.set(
    "file",
    new Blob([toOwnedArrayBuffer(bytes)], { type: mimeType || "application/octet-stream" }),
    filename
  );

  const res = await busJsonFetch<{ file: FileAttachment }>(
    session.busUrl,
    "/api/files",
    {
      method: "POST",
      body: form,
    },
    session.sessionToken
  );
  return res.file;
}

async function uploadInlineSpecsToBus(
  session: ActiveTabRuntimeSession,
  channelId: string,
  specs: InlineBusFileSpec[] | undefined,
  downloadedBlobs: SerializedFilePayload[] | undefined,
  contentText: string
): Promise<string[]> {
  const uploadedIds: string[] = [];
  const inlineNames = new Set<string>();

  if (specs && specs.length > 0) {
    for (const spec of specs) {
      const bytes =
        spec.encoding === "base64"
          ? decodeBase64ToBytes(spec.content)
          : new TextEncoder().encode(spec.content);
      const mime = spec.mimeType || guessMimeTypeFromFilename(spec.filename);
      const uploaded = await uploadSingleFileToBus(
        session,
        channelId,
        spec.filename,
        mime,
        bytes
      );
      uploadedIds.push(uploaded.id);
      inlineNames.add(spec.filename.toLowerCase());
    }
  }

  if (downloadedBlobs && downloadedBlobs.length > 0) {
    const lowerContent = contentText.toLowerCase();
    for (const blobSpec of downloadedBlobs) {
      if (inlineNames.has(blobSpec.filename.toLowerCase())) continue;
      if (!lowerContent.includes(blobSpec.filename.toLowerCase())) continue;
      const bytes = decodeBase64ToBytes(blobSpec.base64);
      const uploaded = await uploadSingleFileToBus(
        session,
        channelId,
        blobSpec.filename,
        blobSpec.mimeType,
        bytes
      );
      uploadedIds.push(uploaded.id);
    }
  }

  return uploadedIds;
}

async function executeOutboundBusActions(
  session: ActiveTabRuntimeSession,
  actions: WebAgentBusAction[],
  downloadedFiles?: SerializedFilePayload[]
): Promise<void> {
  if (!session.attached || !session.sessionToken) return;

  for (const action of actions) {
    try {
      switch (action.op) {
        case "announce": {
          const uploadedFileIds = await uploadInlineSpecsToBus(
            session,
            ANNOUNCEMENTS_CHANNEL_ID,
            action.files,
            downloadedFiles,
            action.content
          );
          const mergedFileIds = [...(action.fileIds ?? []), ...uploadedFileIds];
          const reqBody: SendMessageRequest = {
            content: action.content,
            mentions: action.mentions,
            fileIds: mergedFileIds.length > 0 ? mergedFileIds : undefined,
          };
          await busJsonFetch<{ message: BusMessage }>(
            session.busUrl,
            `/api/channels/${encodeURIComponent(ANNOUNCEMENTS_CHANNEL_ID)}/messages`,
            {
              method: "POST",
              body: JSON.stringify(reqBody),
            },
            session.sessionToken
          );
          break;
        }

        case "send": {
          const targetChannelId = action.channelId.replace(/^#/, "").trim();
          const uploadedFileIds = await uploadInlineSpecsToBus(
            session,
            targetChannelId,
            action.files,
            downloadedFiles,
            action.content
          );
          const mergedFileIds = [...(action.fileIds ?? []), ...uploadedFileIds];
          const reqBody: SendMessageRequest = {
            content: action.content,
            mentions: action.mentions,
            fileIds: mergedFileIds.length > 0 ? mergedFileIds : undefined,
          };
          await busJsonFetch<{ message: BusMessage }>(
            session.busUrl,
            `/api/channels/${encodeURIComponent(targetChannelId)}/messages`,
            {
              method: "POST",
              body: JSON.stringify(reqBody),
            },
            session.sessionToken
          );
          break;
        }

        case "request_channel": {
          const targetAgentIds = action.targets
            .map((t) => t.replace(/^@/, "").trim())
            .filter((t) => t.length > 0);
          if (targetAgentIds.length === 0) break;

          const reqBody: RequestPrivateChannelRequest = {
            targetAgentIds,
            name: action.name,
            topic: action.topic,
            initialMessage: action.content,
            reuseExisting: true,
          };
          const created = await busJsonFetch<RequestPrivateChannelResponse>(
            session.busUrl,
            "/api/channels/private",
            {
              method: "POST",
              body: JSON.stringify(reqBody),
            },
            session.sessionToken
          );
          session.channelsMap.set(created.channel.id, created.channel);
          session.queue.upsertChannel(created.channel);
          break;
        }

        case "accept_channel": {
          const channelId = action.channelId.trim();
          const respBody: RespondChannelInviteRequest = { action: "accept" };
          const accepted = await busJsonFetch<{ channel: ChannelInfo; invite: ChannelInvite }>(
            session.busUrl,
            `/api/channels/${encodeURIComponent(channelId)}/respond`,
            {
              method: "POST",
              body: JSON.stringify(respBody),
            },
            session.sessionToken
          );
          session.channelsMap.set(accepted.channel.id, accepted.channel);
          session.queue.upsertChannel(accepted.channel);
          session.pendingInvitesMap.delete(accepted.invite.id);
          session.queue.removeInviteByChannel(channelId);

          if (action.content && action.content.trim().length > 0) {
            const msgBody: SendMessageRequest = { content: action.content };
            await busJsonFetch<{ message: BusMessage }>(
              session.busUrl,
              `/api/channels/${encodeURIComponent(channelId)}/messages`,
              {
                method: "POST",
                body: JSON.stringify(msgBody),
              },
              session.sessionToken
            );
          }
          break;
        }

        case "decline_channel": {
          const channelId = action.channelId.trim();
          const respBody: RespondChannelInviteRequest = { action: "decline" };
          const declined = await busJsonFetch<{ channel: ChannelInfo; invite: ChannelInvite }>(
            session.busUrl,
            `/api/channels/${encodeURIComponent(channelId)}/respond`,
            {
              method: "POST",
              body: JSON.stringify(respBody),
            },
            session.sessionToken
          );
          session.pendingInvitesMap.delete(declined.invite.id);
          session.queue.removeInviteByChannel(channelId);
          break;
        }
      }
    } catch (err) {
      session.lastError = err instanceof Error ? err.message : String(err);
    }
  }

  broadcastTabState(session.tabId);
}

function clearSessionTimers(session: ActiveTabRuntimeSession): void {
  clearInterval(session.pingTimer);
  session.pingTimer = undefined;
  clearTimeout(session.reconnectTimer);
  session.reconnectTimer = undefined;
  clearTimeout(session.cooldownTimer);
  session.cooldownTimer = undefined;
}

function handleServerWsFrame(session: ActiveTabRuntimeSession, frame: ServerWsFrame): void {
  switch (frame.type) {
    case "welcome": {
      session.channelsMap.clear();
      for (const ch of frame.channels) {
        session.channelsMap.set(ch.id, ch);
      }
      session.queue.updateChannels(frame.channels);

      session.onlineAgentsMap.clear();
      for (const ag of frame.agents) {
        if (ag.status !== "offline") {
          session.onlineAgentsMap.set(ag.id, ag);
        }
      }

      session.pendingInvitesMap.clear();
      for (const inv of frame.invites) {
        if (inv.state === "pending") {
          session.pendingInvitesMap.set(inv.id, inv);
          session.queue.enqueueInvite(inv);
        }
      }

      if (session.latestSeq > 0 && frame.latestSeq > session.latestSeq) {
        sendWsFrame(session, { type: "sync", sinceSeq: session.latestSeq });
      } else {
        session.latestSeq = Math.max(session.latestSeq, frame.latestSeq);
      }

      void persistActiveSessions();
      broadcastTabState(session.tabId);
      void maybeDispatchQueue(session, false);
      break;
    }

    case "pong":
      break;

    case "sync.batch": {
      for (const inv of frame.invites) {
        if (inv.state === "pending") {
          session.pendingInvitesMap.set(inv.id, inv);
          session.queue.enqueueInvite(inv);
        } else {
          session.pendingInvitesMap.delete(inv.id);
        }
      }

      for (const msg of frame.messages) {
        session.latestSeq = Math.max(session.latestSeq, msg.seq);
        session.queue.enqueueMessage(msg, session.channelsMap.get(msg.channelId));
      }
      session.latestSeq = Math.max(session.latestSeq, frame.latestSeq);

      void persistActiveSessions();
      broadcastTabState(session.tabId);
      void maybeDispatchQueue(session, false);
      break;
    }

    case "message.created": {
      const msg = frame.message;
      session.latestSeq = Math.max(session.latestSeq, msg.seq);
      session.queue.enqueueMessage(msg, session.channelsMap.get(msg.channelId));
      void persistActiveSessions();
      broadcastTabState(session.tabId);
      void maybeDispatchQueue(session, false);
      break;
    }

    case "channel.invite": {
      session.channelsMap.set(frame.channel.id, frame.channel);
      session.queue.upsertChannel(frame.channel);
      if (frame.invite.state === "pending") {
        session.pendingInvitesMap.set(frame.invite.id, frame.invite);
        session.queue.enqueueInvite(frame.invite);
      }
      broadcastTabState(session.tabId);
      void maybeDispatchQueue(session, false);
      break;
    }

    case "channel.updated": {
      session.channelsMap.set(frame.channel.id, frame.channel);
      session.queue.upsertChannel(frame.channel);
      const selfMember = frame.channel.members.find(
        (m) => m.agentId.toLowerCase() === session.agentId.toLowerCase()
      );
      if (selfMember && selfMember.state !== "invited") {
        session.queue.removeInviteByChannel(frame.channel.id);
        for (const [invId, inv] of session.pendingInvitesMap) {
          if (inv.channelId === frame.channel.id) {
            session.pendingInvitesMap.delete(invId);
          }
        }
      }
      broadcastTabState(session.tabId);
      break;
    }

    case "agent.updated": {
      if (frame.agent.status === "offline") {
        session.onlineAgentsMap.delete(frame.agent.id);
      } else {
        session.onlineAgentsMap.set(frame.agent.id, frame.agent);
      }
      broadcastTabState(session.tabId);
      break;
    }

    case "file.uploaded":
    case "ack":
      break;

    case "error": {
      session.lastError = frame.message;
      broadcastTabState(session.tabId);
      break;
    }
  }
}

async function registerAgentOnBus(session: ActiveTabRuntimeSession): Promise<void> {
  const reqBody: RegisterAgentRequest = {
    id: session.agentId ? slugifyId(session.agentId) : undefined,
    displayName: session.displayName,
    kind: "web-extension",
    platform: session.resolvedAdapterId,
    capabilities: ["chat", "files", "web-ui", "fenced-bus"],
    status: computeDesiredAgentStatus(session),
    metadata: {
      tabId: session.tabId,
      adapterId: session.adapterId,
      relayMode: session.relayMode,
    },
    networkKey: session.networkKey || undefined,
    sessionToken: session.sessionToken || undefined,
    forceReclaim: true,
  };

  const reg = await busJsonFetch<RegisterAgentResponse>(
    session.busUrl,
    "/api/agents/register",
    {
      method: "POST",
      body: JSON.stringify(reqBody),
    }
  );

  session.agentId = reg.agent.id;
  session.displayName = reg.agent.displayName;
  session.sessionToken = reg.sessionToken;
  if (session.latestSeq === 0) {
    session.latestSeq = reg.latestSeq;
  }

  session.channelsMap.clear();
  for (const ch of reg.channels) {
    session.channelsMap.set(ch.id, ch);
  }
  session.queue.updateChannels(reg.channels);

  session.pendingInvitesMap.clear();
  for (const inv of reg.pendingInvites) {
    if (inv.state === "pending") {
      session.pendingInvitesMap.set(inv.id, inv);
      session.queue.enqueueInvite(inv);
    }
  }

  try {
    const agentsRes = await busJsonFetch<{ agents: AgentInfo[] }>(
      session.busUrl,
      "/api/agents?status=online",
      {},
      session.sessionToken
    );
    session.onlineAgentsMap.clear();
    for (const ag of agentsRes.agents) {
      if (ag.status !== "offline") {
        session.onlineAgentsMap.set(ag.id, ag);
      }
    }
  } catch {
    // Welcome WS frame also populates online agents
  }
}

function scheduleWsReconnect(session: ActiveTabRuntimeSession): void {
  if (!session.attached) return;
  if (session.reconnectTimer !== undefined) return;

  const delayMs = Math.min(1000 * 2 ** Math.min(session.reconnectAttempt, 4), 15_000);
  session.reconnectAttempt += 1;
  session.connectionState = "reconnecting";
  broadcastTabState(session.tabId);

  session.reconnectTimer = setTimeout(() => {
    session.reconnectTimer = undefined;
    if (!session.attached) return;
    void connectSessionWebSocket(session, true);
  }, delayMs);
}

async function connectSessionWebSocket(
  session: ActiveTabRuntimeSession,
  reRegisterOnFailure = false
): Promise<void> {
  if (!session.attached) return;

  if (session.ws) {
    try {
      session.ws.onclose = null;
      session.ws.onerror = null;
      session.ws.onmessage = null;
      session.ws.close();
    } catch {
      // Ignore
    }
    session.ws = null;
  }
  clearInterval(session.pingTimer);
  session.pingTimer = undefined;

  if (reRegisterOnFailure || !session.sessionToken) {
    try {
      await registerAgentOnBus(session);
    } catch (err) {
      session.lastError = err instanceof Error ? err.message : String(err);
      scheduleWsReconnect(session);
      return;
    }
  }

  const wsUrl = toBusWsUrl(session.busUrl, session.sessionToken);
  let socket: WebSocket;
  try {
    socket = new WebSocket(wsUrl);
  } catch (err) {
    session.lastError = err instanceof Error ? err.message : String(err);
    scheduleWsReconnect(session);
    return;
  }

  session.ws = socket;

  socket.onopen = () => {
    if (session.ws !== socket || !session.attached) return;
    session.reconnectAttempt = 0;
    session.connectionState = "connected";
    session.connectedAt ??= Date.now();
    session.lastError = undefined;

    if (session.latestSeq > 0) {
      sendWsFrame(session, { type: "sync", sinceSeq: session.latestSeq });
    }
    void syncAgentStatusToBus(session);

    clearInterval(session.pingTimer);
    session.pingTimer = setInterval(() => {
      sendWsFrame(session, { type: "ping", ts: Date.now() });
    }, WS_PING_INTERVAL_MS);

    void persistActiveSessions();
    broadcastTabState(session.tabId);
    void maybeDispatchQueue(session, false);
  };

  socket.onmessage = (event: MessageEvent) => {
    if (session.ws !== socket || !session.attached) return;
    if (typeof event.data !== "string") return;
    try {
      const parsed: unknown = JSON.parse(event.data);
      if (isJsonObject(parsed) && typeof parsed.type === "string") {
        handleServerWsFrame(session, parsed as unknown as ServerWsFrame);
      }
    } catch {
      // Ignore malformed frame
    }
  };

  socket.onerror = () => {
    // Handled in onclose
  };

  socket.onclose = () => {
    if (session.ws !== socket) return;
    session.ws = null;
    clearInterval(session.pingTimer);
    session.pingTimer = undefined;
    if (session.attached) {
      scheduleWsReconnect(session);
    }
  };
}

async function detachTabSession(tabId: number): Promise<void> {
  const session = sessionsByTab.get(tabId);
  if (!session) {
    broadcastTabState(tabId);
    return;
  }

  session.attached = false;
  clearSessionTimers(session);

  if (session.sessionToken) {
    try {
      sendWsFrame(session, { type: "status.update", status: "offline" });
      await busJsonFetch<{ agent: AgentInfo }>(
        session.busUrl,
        "/api/agents/me",
        {
          method: "PATCH",
          body: JSON.stringify({ status: "offline" } satisfies UpdateAgentRequest),
        },
        session.sessionToken
      );
    } catch {
      // Best-effort offline update
    }
  }

  if (session.ws) {
    try {
      session.ws.onclose = null;
      session.ws.close();
    } catch {
      // Ignore
    }
    session.ws = null;
  }

  sessionsByTab.delete(tabId);
  await persistActiveSessions();
  broadcastTabState(tabId);
}

async function attachTabSession(params: {
  tabId: number;
  busUrl: string;
  networkKey?: string;
  agentId?: string;
  displayName: string;
  adapterId: AdapterId;
  relayMode: RelayMode;
  customSelectors?: CustomSelectorConfig;
}): Promise<ExtensionResponse> {
  const existing = sessionsByTab.get(params.tabId);
  if (existing) {
    await detachTabSession(params.tabId);
  }

  let tabUrl = "https://localhost/";
  try {
    const tabInfo = await chrome.tabs.get(params.tabId);
    if (tabInfo.url) {
      tabUrl = tabInfo.url;
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Target tab not found",
    };
  }

  const resolvedAdapterId: ResolvedAdapterId =
    params.adapterId === "auto" ? detectAdapterIdForUrl(tabUrl) : params.adapterId;

  const defaultSlugBase =
    params.agentId?.trim() ||
    `${resolvedAdapterId}-${params.tabId}`;
  const cleanAgentId = slugifyId(defaultSlugBase, "web-agent");
  const cleanDisplayName =
    params.displayName.trim() || `${ADAPTER_DISPLAY_NAMES[resolvedAdapterId]} (${cleanAgentId})`;
  const normalizedBusUrl = normalizeBusHttpUrl(params.busUrl);
  const customSelectors = params.customSelectors ?? savedSettings.customSelectors;

  await persistSavedSettings({
    busUrl: normalizedBusUrl,
    networkKey: params.networkKey ?? savedSettings.networkKey,
    defaultRelayMode: params.relayMode,
    defaultAdapterId: params.adapterId,
    customSelectors,
  });

  // Ensure content.js is injected (supports any localhost/custom Web Chat URL via Generic adapter!)
  const scriptLoaded = await ensureContentScriptReady(params.tabId);
  if (!scriptLoaded) {
    return {
      ok: false,
      error:
        "Cannot inject content script into this tab (restricted browser page or missing permissions).",
    };
  }

  await sendMessageToTab(params.tabId, {
    type: "CONFIGURE_ADAPTER",
    adapterId: params.adapterId,
    customSelectors,
    resetBaseline: true,
  });

  const queue = new SmartRelayQueue({
    agentId: cleanAgentId,
    mode: params.relayMode,
  });

  const session: ActiveTabRuntimeSession = {
    tabId: params.tabId,
    attached: true,
    busUrl: normalizedBusUrl,
    networkKey: params.networkKey ?? "",
    agentId: cleanAgentId,
    displayName: cleanDisplayName,
    sessionToken: "",
    adapterId: params.adapterId,
    resolvedAdapterId,
    relayMode: params.relayMode,
    customSelectors,
    connectionState: "connecting",
    isGenerating: false,
    latestSeq: 0,
    queue,
    channelsMap: new Map(),
    pendingInvitesMap: new Map(),
    onlineAgentsMap: new Map(),
    ws: null,
    pingTimer: undefined,
    reconnectTimer: undefined,
    cooldownTimer: undefined,
    reconnectAttempt: 0,
    dispatchInFlight: false,
  };

  try {
    await registerAgentOnBus(session);
  } catch (err) {
    return {
      ok: false,
      error: `Bus registration failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Re-align queue agentId if server canonicalized it
  if (session.queue.agentId !== session.agentId) {
    const alignedQueue = new SmartRelayQueue({
      agentId: session.agentId,
      mode: session.relayMode,
    });
    alignedQueue.updateChannels(session.channelsMap.values());
    for (const inv of session.pendingInvitesMap.values()) {
      alignedQueue.enqueueInvite(inv);
    }
    session.queue = alignedQueue;
  }

  sessionsByTab.set(params.tabId, session);
  session.connectedAt = Date.now();
  await persistActiveSessions();

  broadcastTabState(params.tabId);
  await connectSessionWebSocket(session, false);

  return {
    ok: true,
    state: buildPublicSessionState(session),
    settings: savedSettings,
  };
}

async function injectBootstrapPrompt(tabId: number): Promise<ExtensionResponse> {
  const session = sessionsByTab.get(tabId);
  if (!session || !session.attached) {
    return { ok: false, error: "Attach the tab to the bus before bootstrapping" };
  }

  try {
    const [agentsRes, channelsRes] = await Promise.all([
      busJsonFetch<{ agents: AgentInfo[] }>(
        session.busUrl,
        "/api/agents?status=online",
        {},
        session.sessionToken
      ),
      busJsonFetch<{ channels: ChannelInfo[]; invites: ChannelInvite[] }>(
        session.busUrl,
        "/api/channels",
        {},
        session.sessionToken
      ),
    ]);

    session.onlineAgentsMap.clear();
    for (const ag of agentsRes.agents) {
      if (ag.status !== "offline") {
        session.onlineAgentsMap.set(ag.id, ag);
      }
    }

    session.channelsMap.clear();
    for (const ch of channelsRes.channels) {
      session.channelsMap.set(ch.id, ch);
    }
    session.queue.updateChannels(channelsRes.channels);
  } catch {
    // Fallback to cached onlineAgentsMap / channelsMap
  }

  const ready = await ensureContentScriptReady(tabId);
  if (!ready) {
    return { ok: false, error: "Content script not reachable on target tab" };
  }

  const promptText = buildWebAgentBootstrapPrompt({
    agentId: session.agentId,
    displayName: session.displayName,
    onlineAgents: Array.from(session.onlineAgentsMap.values()),
    channels: Array.from(session.channelsMap.values()),
  });

  session.isGenerating = true;
  session.queue.setGenerating(true);
  session.queue.applyCooldown(POST_DISPATCH_COOLDOWN_MS);
  void syncAgentStatusToBus(session);
  broadcastTabState(tabId);

  const injectRes = await sendMessageToTab(tabId, {
    type: "INJECT_TURN_BATCH",
    promptText,
    files: [],
    reason: "bootstrap",
  });

  if (!injectRes || !injectRes.ok) {
    session.isGenerating = false;
    session.queue.setGenerating(false);
    void syncAgentStatusToBus(session);
    broadcastTabState(tabId);
    return {
      ok: false,
      error: injectRes?.error ?? "Failed to inject bootstrap prompt",
    };
  }

  return {
    ok: true,
    dispatched: true,
    state: buildPublicSessionState(session),
  };
}

async function handlePanelFileUpload(params: {
  tabId: number;
  channelId: string;
  file: {
    filename: string;
    mimeType: string;
    base64: string;
    sizeBytes: number;
  };
  message?: string;
}): Promise<ExtensionResponse> {
  const session = sessionsByTab.get(params.tabId);
  if (!session || !session.attached || !session.sessionToken) {
    return { ok: false, error: "Attach tab to the bus before uploading files" };
  }

  try {
    const bytes = decodeBase64ToBytes(params.file.base64);
    const mime = params.file.mimeType || guessMimeTypeFromFilename(params.file.filename);
    const targetChannel = params.channelId.trim() || ANNOUNCEMENTS_CHANNEL_ID;

    const uploaded = await uploadSingleFileToBus(
      session,
      targetChannel,
      params.file.filename,
      mime,
      bytes
    );

    const reqBody: SendMessageRequest = {
      content: params.message?.trim() || `Shared file: ${params.file.filename}`,
      fileIds: [uploaded.id],
    };

    await busJsonFetch<{ message: BusMessage }>(
      session.busUrl,
      `/api/channels/${encodeURIComponent(targetChannel)}/messages`,
      {
        method: "POST",
        body: JSON.stringify(reqBody),
      },
      session.sessionToken
    );

    return {
      ok: true,
      state: buildPublicSessionState(session),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function refreshNetworkSnapshot(tabId: number): Promise<ExtensionResponse> {
  const session = sessionsByTab.get(tabId);
  if (!session || !session.attached) {
    const baseUrl = normalizeBusHttpUrl(savedSettings.busUrl);
    try {
      const agentsRes = await busJsonFetch<{ agents: AgentInfo[] }>(
        baseUrl,
        "/api/agents?status=online"
      );
      return {
        ok: true,
        state: {
          tabId,
          attached: false,
          busUrl: baseUrl,
          agentId: "",
          displayName: "",
          adapterId: savedSettings.defaultAdapterId,
          resolvedAdapterName: "Auto",
          relayMode: savedSettings.defaultRelayMode,
          connectionState: "disconnected",
          isGenerating: false,
          queuedTriggerCount: 0,
          queuedInviteCount: 0,
          passiveContextCount: 0,
          totalQueuedCount: 0,
          latestSeq: 0,
          channels: [],
          pendingInvites: [],
          onlineAgents: agentsRes.agents,
          customSelectors: savedSettings.customSelectors,
        },
        settings: savedSettings,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        settings: savedSettings,
      };
    }
  }

  try {
    const [agentsRes, channelsRes] = await Promise.all([
      busJsonFetch<{ agents: AgentInfo[] }>(
        session.busUrl,
        "/api/agents?status=online",
        {},
        session.sessionToken
      ),
      busJsonFetch<{ channels: ChannelInfo[]; invites: ChannelInvite[] }>(
        session.busUrl,
        "/api/channels",
        {},
        session.sessionToken
      ),
    ]);

    session.onlineAgentsMap.clear();
    for (const ag of agentsRes.agents) {
      if (ag.status !== "offline") {
        session.onlineAgentsMap.set(ag.id, ag);
      }
    }

    session.channelsMap.clear();
    for (const ch of channelsRes.channels) {
      session.channelsMap.set(ch.id, ch);
    }
    session.queue.updateChannels(channelsRes.channels);
    broadcastTabState(tabId);

    return {
      ok: true,
      state: buildPublicSessionState(session),
      settings: savedSettings,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      state: buildPublicSessionState(session),
      settings: savedSettings,
    };
  }
}

async function ensureHydrated(): Promise<void> {
  if (hydrationPromise) {
    return hydrationPromise;
  }

  hydrationPromise = (async () => {
    await loadSavedSettings();
    try {
      const raw = await getSessionStorageArea().get(STORAGE_SESSIONS_KEY);
      const storedMap = raw[STORAGE_SESSIONS_KEY];
      if (!isJsonObject(storedMap)) return;

      for (const value of Object.values(storedMap)) {
        if (!isJsonObject(value) || typeof value.tabId !== "number") continue;
        const tabId = value.tabId;
        if (sessionsByTab.has(tabId)) continue;

        try {
          await chrome.tabs.get(tabId);
        } catch {
          continue;
        }

        const relayMode: RelayMode =
          value.relayMode === "manual-pause" ||
          value.relayMode === "all-auto" ||
          value.relayMode === "smart-auto"
            ? value.relayMode
            : "smart-auto";
        const adapterId: AdapterId =
          value.adapterId === "chatgpt" ||
          value.adapterId === "claude" ||
          value.adapterId === "gemini" ||
          value.adapterId === "generic" ||
          value.adapterId === "auto"
            ? value.adapterId
            : "auto";
        const resolvedAdapterId: ResolvedAdapterId =
          value.resolvedAdapterId === "chatgpt" ||
          value.resolvedAdapterId === "claude" ||
          value.resolvedAdapterId === "gemini" ||
          value.resolvedAdapterId === "generic"
            ? value.resolvedAdapterId
            : "generic";
        const agentId = typeof value.agentId === "string" ? value.agentId : `web-${tabId}`;

        const restored: ActiveTabRuntimeSession = {
          tabId,
          attached: true,
          busUrl:
            typeof value.busUrl === "string" ? value.busUrl : DEFAULT_EXTENSION_SETTINGS.busUrl,
          networkKey: typeof value.networkKey === "string" ? value.networkKey : "",
          agentId,
          displayName: typeof value.displayName === "string" ? value.displayName : agentId,
          sessionToken: typeof value.sessionToken === "string" ? value.sessionToken : "",
          adapterId,
          resolvedAdapterId,
          relayMode,
          customSelectors: isJsonObject(value.customSelectors)
            ? (value.customSelectors as CustomSelectorConfig)
            : {},
          connectionState: "reconnecting",
          isGenerating: false,
          latestSeq: typeof value.latestSeq === "number" ? value.latestSeq : 0,
          connectedAt: typeof value.connectedAt === "number" ? value.connectedAt : Date.now(),
          queue: new SmartRelayQueue({ agentId, mode: relayMode }),
          channelsMap: new Map(),
          pendingInvitesMap: new Map(),
          onlineAgentsMap: new Map(),
          ws: null,
          pingTimer: undefined,
          reconnectTimer: undefined,
          cooldownTimer: undefined,
          reconnectAttempt: 0,
          dispatchInFlight: false,
        };

        sessionsByTab.set(tabId, restored);
        void connectSessionWebSocket(restored, true);
      }
    } catch {
      // Ignore hydration storage errors
    }
  })();

  return hydrationPromise;
}

function updateSessionRelayMode(
  session: ActiveTabRuntimeSession,
  nextMode: RelayMode
): ExtensionResponse {
  session.relayMode = nextMode;
  session.queue.setMode(nextMode);
  void persistActiveSessions();
  void syncAgentStatusToBus(session);
  broadcastTabState(session.tabId);
  if (nextMode !== "manual-pause") {
    void maybeDispatchQueue(session, false);
  }
  return {
    ok: true,
    state: buildPublicSessionState(session),
    settings: savedSettings,
  };
}

// Setup MV3 keepalive alarm
function setupKeepaliveAlarm(): void {
  try {
    chrome.alarms.create(KEEPALIVE_ALARM_NAME, { periodInMinutes: 0.4 });
  } catch {
    // Ignore alarm registration errors
  }
}

chrome.runtime.onInstalled.addListener(() => {
  setupKeepaliveAlarm();
  void ensureHydrated();
});

chrome.runtime.onStartup.addListener(() => {
  setupKeepaliveAlarm();
  void ensureHydrated();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM_NAME) return;
  void (async () => {
    await ensureHydrated();
    for (const session of sessionsByTab.values()) {
      if (!session.attached) continue;
      if (!session.ws || session.ws.readyState === WebSocket.CLOSED) {
        if (session.reconnectTimer === undefined) {
          void connectSessionWebSocket(session, true);
        }
      } else if (session.ws.readyState === WebSocket.OPEN) {
        sendWsFrame(session, { type: "ping", ts: Date.now() });
      }
      void maybeDispatchQueue(session, false);
    }
  })();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (sessionsByTab.has(tabId)) {
    void detachTabSession(tabId);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  const session = sessionsByTab.get(tabId);
  if (!session || !session.attached) return;

  void (async () => {
    if (tab.url && session.adapterId === "auto") {
      session.resolvedAdapterId = detectAdapterIdForUrl(tab.url);
    }
    const ready = await ensureContentScriptReady(tabId);
    if (ready) {
      await sendMessageToTab(tabId, {
        type: "CONFIGURE_ADAPTER",
        adapterId: session.adapterId,
        customSelectors: session.customSelectors,
        resetBaseline: true,
      });
      broadcastTabState(tabId);
    }
  })();
});

chrome.runtime.onMessage.addListener((rawMessage: unknown, sender, sendResponse) => {
  if (!isRuntimeMessage(rawMessage)) {
    return false;
  }

  void (async () => {
    await ensureHydrated();
    const senderTabId = sender.tab?.id;

    switch (rawMessage.type) {
      case "CONTENT_READY": {
        if (senderTabId !== undefined) {
          const session = sessionsByTab.get(senderTabId);
          if (session && session.attached) {
            session.isGenerating = rawMessage.isGenerating;
            session.queue.setGenerating(rawMessage.isGenerating);
            broadcastTabState(senderTabId);
          }
        }
        sendResponse({ ok: true });
        return;
      }

      case "CONTENT_GET_STATE": {
        if (senderTabId === undefined) {
          sendResponse({ ok: true, state: null });
          return;
        }
        const session = sessionsByTab.get(senderTabId);
        sendResponse({
          ok: true,
          state: session?.attached ? buildPublicSessionState(session) : null,
        });
        return;
      }

      case "TAB_GENERATION_STATE": {
        if (senderTabId !== undefined) {
          const session = sessionsByTab.get(senderTabId);
          if (session && session.attached) {
            const wasGenerating = session.isGenerating;
            session.isGenerating = rawMessage.isGenerating;
            session.queue.setGenerating(rawMessage.isGenerating);
            if (wasGenerating && !rawMessage.isGenerating) {
              session.queue.applyCooldown(POST_TURN_COOLDOWN_MS);
            }
            void syncAgentStatusToBus(session);
            broadcastTabState(senderTabId);
            if (!rawMessage.isGenerating) {
              void maybeDispatchQueue(session, false);
            }
          }
        }
        sendResponse({ ok: true });
        return;
      }

      case "OUTBOUND_BUS_ACTIONS": {
        if (senderTabId !== undefined) {
          const session = sessionsByTab.get(senderTabId);
          if (session && session.attached) {
            await executeOutboundBusActions(
              session,
              rawMessage.actions,
              rawMessage.downloadedFiles
            );
          }
        }
        sendResponse({ ok: true });
        return;
      }

      case "PILL_SET_RELAY_MODE": {
        if (senderTabId === undefined) {
          sendResponse({ ok: false, error: "Missing sender tab" });
          return;
        }
        const session = sessionsByTab.get(senderTabId);
        if (!session || !session.attached) {
          sendResponse({ ok: false, error: "Tab not attached" });
          return;
        }
        sendResponse(updateSessionRelayMode(session, rawMessage.relayMode));
        return;
      }

      case "PILL_FLUSH_NOW": {
        if (senderTabId === undefined) {
          sendResponse({ ok: false, error: "Missing sender tab" });
          return;
        }
        const session = sessionsByTab.get(senderTabId);
        if (!session || !session.attached) {
          sendResponse({ ok: false, error: "Tab not attached" });
          return;
        }
        const res = await maybeDispatchQueue(session, true);
        sendResponse({
          ok: res.ok,
          dispatched: res.dispatched,
          error: res.error,
          state: buildPublicSessionState(session),
        });
        return;
      }

      case "PILL_SEND_BOOTSTRAP": {
        if (senderTabId === undefined) {
          sendResponse({ ok: false, error: "Missing sender tab" });
          return;
        }
        sendResponse(await injectBootstrapPrompt(senderTabId));
        return;
      }

      case "PANEL_GET_STATE": {
        const session = sessionsByTab.get(rawMessage.tabId);
        sendResponse({
          ok: true,
          state: session?.attached ? buildPublicSessionState(session) : null,
          settings: savedSettings,
        } satisfies ExtensionResponse);
        return;
      }

      case "PANEL_SAVE_SETTINGS": {
        await persistSavedSettings(rawMessage.settings);
        sendResponse({
          ok: true,
          settings: savedSettings,
        } satisfies ExtensionResponse);
        return;
      }

      case "PANEL_ATTACH_TAB": {
        sendResponse(await attachTabSession(rawMessage));
        return;
      }

      case "PANEL_DETACH_TAB": {
        await detachTabSession(rawMessage.tabId);
        sendResponse({
          ok: true,
          state: null,
          settings: savedSettings,
        } satisfies ExtensionResponse);
        return;
      }

      case "PANEL_SET_RELAY_MODE": {
        const session = sessionsByTab.get(rawMessage.tabId);
        if (!session || !session.attached) {
          await persistSavedSettings({ defaultRelayMode: rawMessage.relayMode });
          sendResponse({ ok: true, state: null, settings: savedSettings });
          return;
        }
        sendResponse(updateSessionRelayMode(session, rawMessage.relayMode));
        return;
      }

      case "PANEL_UPDATE_SELECTORS": {
        await persistSavedSettings({
          defaultAdapterId: rawMessage.adapterId,
          customSelectors: rawMessage.customSelectors,
        });
        const session = sessionsByTab.get(rawMessage.tabId);
        if (session && session.attached) {
          session.adapterId = rawMessage.adapterId;
          session.customSelectors = rawMessage.customSelectors;
          if (rawMessage.adapterId !== "auto") {
            session.resolvedAdapterId = rawMessage.adapterId;
          }
          await sendMessageToTab(rawMessage.tabId, {
            type: "CONFIGURE_ADAPTER",
            adapterId: rawMessage.adapterId,
            customSelectors: rawMessage.customSelectors,
          });
          await persistActiveSessions();
          broadcastTabState(rawMessage.tabId);
        }
        sendResponse({
          ok: true,
          state: session?.attached ? buildPublicSessionState(session) : null,
          settings: savedSettings,
        } satisfies ExtensionResponse);
        return;
      }

      case "PANEL_FLUSH_QUEUE": {
        const session = sessionsByTab.get(rawMessage.tabId);
        if (!session || !session.attached) {
          sendResponse({ ok: false, error: "Tab is not attached" });
          return;
        }
        const res = await maybeDispatchQueue(session, true);
        sendResponse({
          ok: res.ok,
          dispatched: res.dispatched,
          error: res.error,
          state: buildPublicSessionState(session),
          settings: savedSettings,
        } satisfies ExtensionResponse);
        return;
      }

      case "PANEL_SEND_BOOTSTRAP":
      case "SEND_BOOTSTRAP": {
        sendResponse(await injectBootstrapPrompt(rawMessage.tabId));
        return;
      }

      case "PANEL_UPLOAD_FILE": {
        sendResponse(await handlePanelFileUpload(rawMessage));
        return;
      }

      case "PANEL_REFRESH_NETWORK": {
        sendResponse(await refreshNetworkSnapshot(rawMessage.tabId));
        return;
      }

      default:
        sendResponse({ ok: false, error: "Unhandled message type" });
    }
  })().catch((err: unknown) => {
    sendResponse({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return true;
});

setupKeepaliveAlarm();
void ensureHydrated();
