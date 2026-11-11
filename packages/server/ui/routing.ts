// Routing (#/c/<id>, #/to/<a,b>): the address names the open view.
import { ALL_CONVERSATION_ID } from "@agent-bus/protocol";
import { sortedUnique } from "./format";
import { hooks } from "./hooks";
import type { View } from "./state";

export function viewHash(view: View): string {
  return view.kind === "conversation" ? `#/c/${encodeURIComponent(view.id)}` : `#/to/${view.to.join(",")}`;
}

export function parseHash(): View {
  const hash = location.hash;
  const conv = /^#\/c\/(.+)$/.exec(hash);
  if (conv?.[1]) return { kind: "conversation", id: decodeURIComponent(conv[1]) };
  const draft = /^#\/to\/(.+)$/.exec(hash);
  if (draft?.[1]) {
    const to = sortedUnique(decodeURIComponent(draft[1]).split(",").map((s) => s.trim()).filter(Boolean));
    if (to.length > 0) return { kind: "draft", to };
  }
  return { kind: "conversation", id: ALL_CONVERSATION_ID };
}

export function navigate(view: View): void {
  const hash = viewHash(view);
  if (location.hash === hash) hooks.applyView(view);
  else location.hash = hash;
}
