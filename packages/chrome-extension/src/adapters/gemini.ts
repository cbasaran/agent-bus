import type { CustomSelectorConfig } from "../types";
import type { WebChatAdapter } from "./adapter-types";
import { createSelectorAdapter } from "./dom-helpers";

export const GEMINI_COMPOSER_SELECTORS = [
  "rich-textarea .ql-editor[contenteditable='true']",
  "div.ql-editor[contenteditable='true']",
  "rich-textarea [contenteditable='true']",
  "[aria-label*='Enter a prompt' i][contenteditable='true']",
  "[aria-label*='Ask Gemini' i][contenteditable='true']",
  "textarea[aria-label*='prompt' i]",
] as const;

export const GEMINI_SEND_SELECTORS = [
  "button.send-button",
  "button[aria-label*='Send message' i]",
  "button[aria-label*='Submit' i]",
  ".send-button-container button",
] as const;

export const GEMINI_STOP_SELECTORS = [
  "button[aria-label*='Stop response' i]",
  "button[aria-label*='Stop generating' i]",
  "button.stop",
  "message-content[aria-busy='true']",
  "model-response [aria-busy='true']",
] as const;

export const GEMINI_ASSISTANT_SELECTORS = [
  "model-response message-content",
  "model-response .model-response-text",
  ".model-response-text",
  "[data-message-author-role='model']",
] as const;

export const GEMINI_FILE_SELECTORS = [
  "input[type='file']",
] as const;

export const GEMINI_DROP_SELECTORS = [
  "rich-textarea",
  ".input-area-container",
  "main",
] as const;

export function createGeminiAdapter(customSelectors?: CustomSelectorConfig): WebChatAdapter {
  return createSelectorAdapter({
    id: "gemini",
    name: "Gemini",
    hostnames: ["gemini.google.com"],
    composerSelectors: GEMINI_COMPOSER_SELECTORS,
    sendButtonSelectors: GEMINI_SEND_SELECTORS,
    stopButtonSelectors: GEMINI_STOP_SELECTORS,
    assistantMessageSelectors: GEMINI_ASSISTANT_SELECTORS,
    fileInputSelectors: GEMINI_FILE_SELECTORS,
    dropZoneSelectors: GEMINI_DROP_SELECTORS,
    customSelectors,
  });
}
