import {
  DEFAULT_BUS_PORT,
  isJsonObject,
  type AgentInfo,
  type ChannelInfo,
  type ChannelInvite,
  type WebAgentBusAction,
} from "@agent-bus/protocol";

export type RelayMode = "smart-auto" | "manual-pause" | "all-auto";

export type AdapterId = "auto" | "chatgpt" | "claude" | "gemini" | "generic";

export type ResolvedAdapterId = "chatgpt" | "claude" | "gemini" | "generic";

export type BusConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export interface CustomSelectorConfig {
  composerSelector?: string;
  sendButtonSelector?: string;
  stopButtonSelector?: string;
  assistantMessageSelector?: string;
  fileInputSelector?: string;
  dropZoneSelector?: string;
}

export interface SerializedFilePayload {
  id: string;
  filename: string;
  mimeType: string;
  base64: string;
  sizeBytes: number;
  textPreview?: string;
}

export interface TabBusSessionState {
  tabId: number;
  attached: boolean;
  busUrl: string;
  agentId: string;
  displayName: string;
  adapterId: AdapterId;
  resolvedAdapterName: string;
  relayMode: RelayMode;
  connectionState: BusConnectionState;
  lastError?: string;
  isGenerating: boolean;
  queuedTriggerCount: number;
  queuedInviteCount: number;
  passiveContextCount: number;
  totalQueuedCount: number;
  latestSeq: number;
  channels: ChannelInfo[];
  pendingInvites: ChannelInvite[];
  onlineAgents: AgentInfo[];
  customSelectors?: CustomSelectorConfig;
  connectedAt?: number;
  lastDispatchedAt?: number;
}

export interface ExtensionSavedSettings {
  busUrl: string;
  networkKey: string;
  defaultRelayMode: RelayMode;
  defaultAdapterId: AdapterId;
  customSelectors: CustomSelectorConfig;
}

export const DEFAULT_EXTENSION_SETTINGS: ExtensionSavedSettings = {
  busUrl: `http://127.0.0.1:${DEFAULT_BUS_PORT}`,
  networkKey: "",
  defaultRelayMode: "smart-auto",
  defaultAdapterId: "auto",
  customSelectors: {},
};

/**
 * Messages sent from Content Script -> Background Service Worker.
 */
export type ContentToBackgroundMessage =
  | {
      type: "CONTENT_READY";
      url: string;
      title: string;
      detectedAdapter: ResolvedAdapterId;
      isGenerating: boolean;
    }
  | {
      type: "TAB_GENERATION_STATE";
      isGenerating: boolean;
    }
  | {
      type: "OUTBOUND_BUS_ACTIONS";
      actions: WebAgentBusAction[];
      rawBlocks: string[];
      downloadedFiles?: SerializedFilePayload[];
    }
  | {
      type: "PILL_SET_RELAY_MODE";
      relayMode: RelayMode;
    }
  | {
      type: "PILL_FLUSH_NOW";
    }
  | {
      type: "PILL_SEND_BOOTSTRAP";
    }
  | {
      type: "CONTENT_GET_STATE";
    };

/**
 * Messages sent from Background Service Worker -> Content Script.
 */
export type BackgroundToContentMessage =
  | {
      type: "PING_CONTENT";
    }
  | {
      type: "CONFIGURE_ADAPTER";
      adapterId: AdapterId;
      customSelectors?: CustomSelectorConfig;
      resetBaseline?: boolean;
    }
  | {
      type: "SESSION_STATE_UPDATE";
      state: TabBusSessionState | null;
    }
  | {
      type: "INJECT_TURN_BATCH";
      promptText: string;
      files: SerializedFilePayload[];
      reason: "auto" | "flush" | "bootstrap";
    };

/**
 * Messages sent from Popup / SidePanel -> Background Service Worker.
 */
export type PanelToBackgroundMessage =
  | {
      type: "PANEL_GET_STATE";
      tabId: number;
    }
  | {
      type: "PANEL_SAVE_SETTINGS";
      settings: Partial<ExtensionSavedSettings>;
    }
  | {
      type: "PANEL_ATTACH_TAB";
      tabId: number;
      busUrl: string;
      networkKey?: string;
      agentId?: string;
      displayName: string;
      adapterId: AdapterId;
      relayMode: RelayMode;
      customSelectors?: CustomSelectorConfig;
    }
  | {
      type: "PANEL_DETACH_TAB";
      tabId: number;
    }
  | {
      type: "PANEL_SET_RELAY_MODE";
      tabId: number;
      relayMode: RelayMode;
    }
  | {
      type: "PANEL_UPDATE_SELECTORS";
      tabId: number;
      adapterId: AdapterId;
      customSelectors: CustomSelectorConfig;
    }
  | {
      type: "PANEL_FLUSH_QUEUE";
      tabId: number;
    }
  | {
      type: "PANEL_SEND_BOOTSTRAP";
      tabId: number;
    }
  | {
      type: "SEND_BOOTSTRAP";
      tabId: number;
    }
  | {
      type: "PANEL_UPLOAD_FILE";
      tabId: number;
      channelId: string;
      file: {
        filename: string;
        mimeType: string;
        base64: string;
        sizeBytes: number;
      };
      message?: string;
    }
  | {
      type: "PANEL_REFRESH_NETWORK";
      tabId: number;
    };

/**
 * Broadcast messages sent from Background Service Worker -> Popup / SidePanel.
 */
export type BackgroundToPanelMessage = {
  type: "PANEL_STATE_BROADCAST";
  tabId: number;
  state: TabBusSessionState | null;
  settings: ExtensionSavedSettings;
};

export type ExtensionRuntimeMessage =
  | ContentToBackgroundMessage
  | BackgroundToContentMessage
  | PanelToBackgroundMessage
  | BackgroundToPanelMessage;

export interface ExtensionResponse {
  ok: boolean;
  error?: string;
  state?: TabBusSessionState | null;
  settings?: ExtensionSavedSettings;
  dispatched?: boolean;
}

export function isRuntimeMessage(value: unknown): value is ExtensionRuntimeMessage {
  return isJsonObject(value) && typeof value.type === "string";
}

export function encodeBytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const slice = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    parts.push(String.fromCharCode(...slice));
  }
  return btoa(parts.join(""));
}

export function decodeBase64ToBytes(base64: string): Uint8Array {
  const cleaned = base64.includes(",") ? (base64.split(",")[1] ?? "") : base64;
  const binary = atob(cleaned.trim());
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function toOwnedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

const TEXT_EXTENSIONS: Record<string, true> = {
  txt: true,
  md: true,
  markdown: true,
  json: true,
  jsonl: true,
  ndjson: true,
  js: true,
  jsx: true,
  mjs: true,
  cjs: true,
  ts: true,
  tsx: true,
  py: true,
  rs: true,
  go: true,
  java: true,
  kt: true,
  c: true,
  h: true,
  cpp: true,
  hpp: true,
  cs: true,
  rb: true,
  php: true,
  swift: true,
  sh: true,
  bash: true,
  zsh: true,
  yaml: true,
  yml: true,
  toml: true,
  ini: true,
  cfg: true,
  conf: true,
  env: true,
  sql: true,
  graphql: true,
  gql: true,
  html: true,
  htm: true,
  css: true,
  scss: true,
  svg: true,
  xml: true,
  csv: true,
  tsv: true,
  log: true,
  diff: true,
  patch: true,
};

const TEXT_MIME_PATTERNS = [
  /^text\//i,
  /^application\/(json|ld\+json|ndjson|xml|xhtml\+xml|javascript|x-javascript|ecmascript|typescript|x-typescript|yaml|x-yaml|toml|sql|graphql|x-sh|csv)$/i,
  /\+(json|xml|yaml)$/i,
];

export function isTextLikeFile(filename: string, mimeType: string): boolean {
  const trimmedMime = mimeType.split(";")[0]?.trim() ?? "";
  if (TEXT_MIME_PATTERNS.some((re) => re.test(trimmedMime))) {
    return true;
  }
  const dotIdx = filename.lastIndexOf(".");
  if (dotIdx !== -1 && dotIdx < filename.length - 1) {
    const ext = filename.slice(dotIdx + 1).toLowerCase();
    if (TEXT_EXTENSIONS[ext]) {
      return true;
    }
  }
  return false;
}

export function guessMimeTypeFromFilename(filename: string): string {
  const dotIdx = filename.lastIndexOf(".");
  const ext = dotIdx !== -1 ? filename.slice(dotIdx + 1).toLowerCase() : "";
  switch (ext) {
    case "txt":
    case "log":
      return "text/plain";
    case "md":
    case "markdown":
      return "text/markdown";
    case "json":
      return "application/json";
    case "jsonl":
    case "ndjson":
      return "application/x-ndjson";
    case "html":
    case "htm":
      return "text/html";
    case "css":
      return "text/css";
    case "js":
    case "mjs":
    case "cjs":
      return "text/javascript";
    case "ts":
    case "tsx":
      return "text/typescript";
    case "py":
      return "text/x-python";
    case "yaml":
    case "yml":
      return "application/yaml";
    case "xml":
      return "application/xml";
    case "svg":
      return "image/svg+xml";
    case "csv":
      return "text/csv";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}
