// Drafts: unsent text is kept per conversation and profile, across navigation and reloads.
import { autosize, updateComposerState } from "./composer";
import { dom } from "./dom";
import { viewHash } from "./routing";
import { state, type View } from "./state";

const DRAFT_KEY_PREFIX = "agent-bus.draft.";

function draftKey(view: View): string {
  return `${DRAFT_KEY_PREFIX}${state.me}.${viewHash(view)}`;
}

export function saveDraft(view: View, text: string): void {
  if (!state.me) return;
  if (text.trim()) localStorage.setItem(draftKey(view), text);
  else localStorage.removeItem(draftKey(view));
}

export function loadDraft(): void {
  dom.input.value = state.me ? (localStorage.getItem(draftKey(state.view)) ?? "") : "";
  autosize();
  updateComposerState();
}
