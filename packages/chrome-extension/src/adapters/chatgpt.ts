import type { CustomSelectorConfig } from "../types";
import type { WebChatAdapter } from "./adapter-types";
import { createSelectorAdapter } from "./dom-helpers";

export const CHATGPT_COMPOSER_SELECTORS = [
  "#prompt-textarea",
  "div.ProseMirror[contenteditable='true']",
  "form textarea[data-id]",
  "main textarea",
  "main [contenteditable='true'][role='textbox']",
] as const;

export const CHATGPT_SEND_SELECTORS = [
  "button[data-testid='send-button']",
  "button[aria-label*='Send prompt' i]",
  "button[aria-label*='Send message' i]",
  "form button[type='submit']",
] as const;

export const CHATGPT_STOP_SELECTORS = [
  "button[data-testid='stop-button']",
  "button[aria-label*='Stop generating' i]",
  "button[aria-label*='Stop streaming' i]",
  "[data-testid='streaming-indicator']",
  ".result-streaming",
] as const;

export const CHATGPT_ASSISTANT_SELECTORS = [
  "[data-message-author-role='assistant']",
  "article[data-turn='assistant']",
  "[data-testid^='conversation-turn-'] [data-message-author-role='assistant']",
] as const;

export const CHATGPT_FILE_SELECTORS = [
  "input[type='file'][multiple]",
  "input[type='file']",
] as const;

export const CHATGPT_DROP_SELECTORS = [
  "#prompt-textarea",
  "form",
  "main",
] as const;

export function createChatGptAdapter(customSelectors?: CustomSelectorConfig): WebChatAdapter {
  return createSelectorAdapter({
    id: "chatgpt",
    name: "ChatGPT",
    hostnames: ["chatgpt.com", "chat.openai.com"],
    composerSelectors: CHATGPT_COMPOSER_SELECTORS,
    sendButtonSelectors: CHATGPT_SEND_SELECTORS,
    stopButtonSelectors: CHATGPT_STOP_SELECTORS,
    assistantMessageSelectors: CHATGPT_ASSISTANT_SELECTORS,
    fileInputSelectors: CHATGPT_FILE_SELECTORS,
    dropZoneSelectors: CHATGPT_DROP_SELECTORS,
    customSelectors,
  });
}
