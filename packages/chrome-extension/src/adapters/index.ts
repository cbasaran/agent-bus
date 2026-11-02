import type { AdapterId, CustomSelectorConfig, ResolvedAdapterId } from "../types";
import type { WebChatAdapter } from "./adapter-types";
import { createChatGptAdapter } from "./chatgpt";
import { createClaudeAdapter } from "./claude";
import { createGeminiAdapter } from "./gemini";
import { createGenericAdapter } from "./generic";

export * from "./adapter-types";
export * from "./dom-helpers";
export * from "./chatgpt";
export * from "./claude";
export * from "./gemini";
export * from "./generic";

export function detectAdapterIdForUrl(urlInput: string | URL): ResolvedAdapterId {
  try {
    const parsed = typeof urlInput === "string" ? new URL(urlInput) : urlInput;
    const host = parsed.hostname.toLowerCase();
    if (host === "chatgpt.com" || host.endsWith(".chatgpt.com") || host === "chat.openai.com") {
      return "chatgpt";
    }
    if (host === "claude.ai" || host.endsWith(".claude.ai")) {
      return "claude";
    }
    if (host === "gemini.google.com" || host.endsWith(".gemini.google.com")) {
      return "gemini";
    }
    return "generic";
  } catch {
    return "generic";
  }
}

export function resolveAdapter(
  adapterId: AdapterId,
  urlInput: string | URL,
  customSelectors?: CustomSelectorConfig
): WebChatAdapter {
  const effectiveId: ResolvedAdapterId =
    adapterId === "auto" ? detectAdapterIdForUrl(urlInput) : adapterId;

  switch (effectiveId) {
    case "chatgpt":
      return createChatGptAdapter(customSelectors);
    case "claude":
      return createClaudeAdapter(customSelectors);
    case "gemini":
      return createGeminiAdapter(customSelectors);
    case "generic":
      return createGenericAdapter(customSelectors);
  }
}
