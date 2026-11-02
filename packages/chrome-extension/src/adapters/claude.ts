import type { CustomSelectorConfig } from "../types";
import type { WebChatAdapter } from "./adapter-types";
import { createSelectorAdapter } from "./dom-helpers";

export const CLAUDE_COMPOSER_SELECTORS = [
  "fieldset div.ProseMirror[contenteditable='true']",
  "div.ProseMirror[contenteditable='true']",
  "[data-testid='chat-input'] [contenteditable='true']",
  "[aria-label*='Write your prompt' i][contenteditable='true']",
  "[contenteditable='true'][role='textbox']",
  "fieldset textarea",
] as const;

export const CLAUDE_SEND_SELECTORS = [
  "button[aria-label='Send Message']",
  "button[aria-label*='Send message' i]",
  "button[data-testid='send-button']",
  "button[aria-label*='Send' i]",
  "form button[type='submit']",
] as const;

export const CLAUDE_STOP_SELECTORS = [
  "button[aria-label*='Stop Response' i]",
  "button[aria-label*='Stop generating' i]",
  "button[data-testid='stop-button']",
  "[data-is-streaming='true']",
] as const;

export const CLAUDE_ASSISTANT_SELECTORS = [
  ".font-claude-message",
  "[data-testid='assistant-message']",
  "[data-is-streaming] .font-claude-message",
  "[data-message-author-role='assistant']",
] as const;

export const CLAUDE_FILE_SELECTORS = [
  "input[data-testid='file-upload']",
  "input[type='file']",
] as const;

export const CLAUDE_DROP_SELECTORS = [
  "fieldset",
  "div.ProseMirror[contenteditable='true']",
  "main",
] as const;

export function createClaudeAdapter(customSelectors?: CustomSelectorConfig): WebChatAdapter {
  return createSelectorAdapter({
    id: "claude",
    name: "Claude",
    hostnames: ["claude.ai"],
    composerSelectors: CLAUDE_COMPOSER_SELECTORS,
    sendButtonSelectors: CLAUDE_SEND_SELECTORS,
    stopButtonSelectors: CLAUDE_STOP_SELECTORS,
    assistantMessageSelectors: CLAUDE_ASSISTANT_SELECTORS,
    fileInputSelectors: CLAUDE_FILE_SELECTORS,
    dropZoneSelectors: CLAUDE_DROP_SELECTORS,
    customSelectors,
  });
}
