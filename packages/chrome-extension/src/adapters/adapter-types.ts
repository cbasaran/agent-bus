import type { CustomSelectorConfig, ResolvedAdapterId } from "../types";

export interface AssistantTurnSnapshot {
  id: string;
  text: string;
  element: HTMLElement;
  downloadLinks: Array<{ href: string; filename: string }>;
}

export interface WebChatAdapter {
  readonly id: ResolvedAdapterId;
  readonly name: string;
  matchesUrl(url: string | URL): boolean;
  findComposer(root?: ParentNode): HTMLElement | null;
  findSendButton(root?: ParentNode): HTMLElement | null;
  findStopButton(root?: ParentNode): HTMLElement | null;
  findFileInput(root?: ParentNode): HTMLInputElement | null;
  findDropTarget(root?: ParentNode): HTMLElement | null;
  isGenerating(root?: ParentNode): boolean;
  getAssistantTurns(root?: ParentNode): AssistantTurnSnapshot[];
  setPromptText(text: string, root?: ParentNode): boolean;
  clickSend(root?: ParentNode): boolean;
  attachFiles(files: File[], root?: ParentNode): Promise<boolean>;
  submitTurn(
    text: string,
    files?: File[],
    root?: ParentNode
  ): Promise<{ ok: boolean; error?: string }>;
}

export interface AdapterSelectorSpec {
  id: ResolvedAdapterId;
  name: string;
  hostnames: readonly string[];
  composerSelectors: readonly string[];
  sendButtonSelectors: readonly string[];
  stopButtonSelectors: readonly string[];
  assistantMessageSelectors: readonly string[];
  fileInputSelectors: readonly string[];
  dropZoneSelectors: readonly string[];
  customSelectors?: CustomSelectorConfig;
}
