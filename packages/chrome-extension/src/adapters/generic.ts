import type { CustomSelectorConfig } from "../types";
import type { WebChatAdapter } from "./adapter-types";
import { createSelectorAdapter } from "./dom-helpers";

export const GENERIC_COMPOSER_SELECTORS = [
  "#composer-input, textarea, [contenteditable=\"true\"]",
] as const;

export const GENERIC_SEND_SELECTORS = [
  "#send-btn, button[type=\"submit\"], button[aria-label*=\"Send\" i]",
] as const;

export const GENERIC_STOP_SELECTORS = [
  "#stop-btn, [data-generating=\"true\"], [data-streaming=\"true\"], button[aria-label*=\"Stop\" i]",
] as const;

export const GENERIC_ASSISTANT_SELECTORS = [
  "[data-role=\"assistant\"], .assistant-message",
] as const;

export const GENERIC_FILE_SELECTORS = [
  "input[type=\"file\"]",
] as const;

export const GENERIC_DROP_SELECTORS = [
  "#drop-zone, #composer-input, form, main, body",
] as const;

export function createGenericAdapter(customSelectors?: CustomSelectorConfig): WebChatAdapter {
  return createSelectorAdapter({
    id: "generic",
    name: "Generic CSS",
    hostnames: [],
    composerSelectors: GENERIC_COMPOSER_SELECTORS,
    sendButtonSelectors: GENERIC_SEND_SELECTORS,
    stopButtonSelectors: GENERIC_STOP_SELECTORS,
    assistantMessageSelectors: GENERIC_ASSISTANT_SELECTORS,
    fileInputSelectors: GENERIC_FILE_SELECTORS,
    dropZoneSelectors: GENERIC_DROP_SELECTORS,
    customSelectors,
  });
}
