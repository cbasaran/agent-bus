// The @ autocomplete of the message box.
import { autosize, updateComposerState } from "./composer";
import { dom } from "./dom";
import { saveDraft } from "./drafts";
import { shortPath } from "./format";
import { h } from "./html";
import { agents, state, type MentionCandidate } from "./state";

const MAX_MENTIONS = 8;

/** Online agents, other agents, humans (not me), then `all`. */
function mentionCandidates(): MentionCandidate[] {
  const out: MentionCandidate[] = agents().map((a) => ({
    id: a.id,
    label: `@${a.id}`,
    hint: [a.online ? "online" : "offline", a.path ? shortPath(a.path) : a.harness ?? ""].filter(Boolean).join(" · "),
  }));
  for (const id of state.humans) {
    if (id !== state.me) out.push({ id, label: `@${id}`, hint: "human" });
  }
  out.push({ id: "all", label: "@all", hint: "everyone" });
  return out;
}

export function updateMention(): void {
  const caret = dom.input.selectionStart;
  if (caret === null || caret !== dom.input.selectionEnd) {
    closeMention();
    return;
  }
  const before = dom.input.value.slice(0, caret);
  const match = /(^|[\s({,])@([a-z0-9_-]*(?:@[a-z0-9_-]*)?)$/i.exec(before);
  if (!match) {
    closeMention();
    return;
  }
  const prefix = (match[2] ?? "").toLowerCase();
  const items = mentionCandidates()
    .filter((c) => c.id.startsWith(prefix))
    .slice(0, MAX_MENTIONS);
  if (items.length === 0) {
    closeMention();
    return;
  }
  const start = caret - prefix.length - 1;
  const previousId = state.mention.open ? state.mention.items[state.mention.index]?.id : undefined;
  const keep = previousId ? items.findIndex((c) => c.id === previousId) : -1;
  state.mention = { open: true, start, items, index: keep >= 0 ? keep : 0 };
  renderMention();
}

function renderMention(): void {
  const { items, index } = state.mention;
  dom.mentionMenu.hidden = false;
  dom.mentionMenu.replaceChildren(
    ...items.map((item, i) => {
      const li = h("li", i === index ? "mention-item selected" : "mention-item");
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(i === index));
      li.append(h("span", "mention-label", item.label), h("span", "mention-hint", item.hint));
      // mousedown keeps focus in the textarea (no blur → close).
      li.addEventListener("mousedown", (event) => {
        event.preventDefault();
        insertMention(item);
      });
      return li;
    })
  );
}

export function closeMention(): void {
  if (!state.mention.open) return;
  state.mention = { open: false, start: 0, items: [], index: 0 };
  dom.mentionMenu.hidden = true;
  dom.mentionMenu.replaceChildren();
}

function insertMention(item: MentionCandidate): void {
  const caret = dom.input.selectionStart ?? dom.input.value.length;
  const value = dom.input.value;
  const insert = `@${item.id} `;
  dom.input.value = value.slice(0, state.mention.start) + insert + value.slice(caret);
  const pos = state.mention.start + insert.length;
  dom.input.setSelectionRange(pos, pos);
  closeMention();
  autosize();
  saveDraft(state.view, dom.input.value);
  updateComposerState();
  dom.input.focus();
}

/** Returns true when the key was consumed by the menu. */
export function handleMentionKey(event: KeyboardEvent): boolean {
  const { items, index } = state.mention;
  switch (event.key) {
    case "ArrowDown":
      state.mention.index = (index + 1) % items.length;
      break;
    case "ArrowUp":
      state.mention.index = (index - 1 + items.length) % items.length;
      break;
    case "Enter":
    case "Tab": {
      if (event.shiftKey || event.isComposing) return false;
      const item = items[index];
      if (!item) return false;
      event.preventDefault();
      insertMention(item);
      return true;
    }
    case "Escape":
      event.preventDefault();
      closeMention();
      return true;
    default:
      return false;
  }
  event.preventDefault();
  renderMention();
  return true;
}
