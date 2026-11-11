// Inline nodes of message text: @mentions highlighted, #n message references linked.
import type { Conversation, Message } from "@agent-bus/protocol";
import { api } from "./api";
import { dom } from "./dom";
import { errorText } from "./format";
import { hooks } from "./hooks";
import { h } from "./html";
import { conversationTitle, state } from "./state";

const MENTION_RE = /(^|[\s({,])(@(?:\{[^}\n]*\}|[a-z0-9][a-z0-9_-]*(?:@[a-z0-9][a-z0-9_-]*)?))/gi;

/** `text` mentions me as `@me` or inside `@{…}`. */
export function mentionsMe(text: string): boolean {
  for (const match of text.matchAll(MENTION_RE)) {
    const ids = (match[2] ?? "")
      .replace(/^@\{?|\}$/g, "")
      .split(",")
      .map((s) => s.trim().replace(/^@/, "").toLowerCase());
    if (ids.includes(state.me)) return true;
  }
  return false;
}

/** Plain text with @mentions highlighted and #n message references linked. */
export function mentionNodes(text: string): Node[] {
  const out: Node[] = [];
  let last = 0;
  for (const match of text.matchAll(MENTION_RE)) {
    const lead = match[1] ?? "";
    const mention = match[2] ?? "";
    const start = (match.index ?? 0) + lead.length;
    if (start > last) out.push(...refNodes(text.slice(last, start)));
    const span = h("span", "mention", mention);
    const id = mention.slice(1).toLowerCase();
    if (id === state.me || id === "all") span.classList.add("mention-me");
    out.push(span);
    last = start + mention.length;
  }
  if (last < text.length) out.push(...refNodes(text.slice(last)));
  return out;
}

// ---- Message references (#n) ----

const REF_RE = /(^|[^\w#&])#(\d{1,7})(?!\w)/g;

function refNodes(text: string): Node[] {
  const out: Node[] = [];
  let last = 0;
  for (const match of text.matchAll(REF_RE)) {
    const start = (match.index ?? 0) + (match[1] ?? "").length;
    if (start > last) out.push(document.createTextNode(text.slice(last, start)));
    out.push(refLink(Number(match[2])));
    last = start + 1 + (match[2] ?? "").length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

/**
 * "#n" as a link: click shows message n (in its conversation); hovering highlights it when it is on screen,
 * otherwise its text shows as a tooltip.
 */
function refLink(seq: number): HTMLAnchorElement {
  const a = h("a", "msg-ref", `#${seq}`);
  a.href = "#";
  a.addEventListener("click", (event) => {
    event.preventDefault();
    void hooks.showMessage(seq);
  });
  a.addEventListener("mouseenter", () => {
    const target = shownMessage(seq);
    if (target && onScreen(target)) {
      a.removeAttribute("title");
      target.classList.add("msg-ref-target");
      return;
    }
    void refSummary(seq).then((text) => (a.title = text));
  });
  a.addEventListener("mouseleave", () => shownMessage(seq)?.classList.remove("msg-ref-target"));
  return a;
}

export function shownMessage(seq: number): HTMLElement | null {
  return dom.messageList.querySelector<HTMLElement>(`[data-seq="${seq}"]`);
}

function onScreen(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  const view = dom.messageScroll.getBoundingClientRect();
  return r.bottom > view.top && r.top < view.bottom;
}

export function flashMessage(el: HTMLElement): void {
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.remove("msg-flash");
  void el.offsetWidth; // restart the animation
  el.classList.add("msg-flash");
}

type MessageWithConversation = { message: Message; conversation: Conversation };

const refFetches = new Map<number, Promise<MessageWithConversation>>();

export function fetchMessage(seq: number): Promise<MessageWithConversation> {
  let pending = refFetches.get(seq);
  if (!pending) {
    pending = api<MessageWithConversation>(`/api/messages/${seq}`);
    pending.catch(() => refFetches.delete(seq));
    refFetches.set(seq, pending);
  }
  return pending;
}

/** Tooltip for "#n": sender, conversation and the start of the text. */
async function refSummary(seq: number): Promise<string> {
  try {
    const { message, conversation } = await fetchMessage(seq);
    const text = message.text.replace(/\s+/g, " ").trim();
    const files = message.files.length > 0 ? ` [${message.files.map((f) => f.name).join(", ")}]` : "";
    return `#${seq} · ${message.from} in ${conversationTitle(conversation)}\n${text.length > 400 ? `${text.slice(0, 399)}…` : text}${files}`;
  } catch (err) {
    return `#${seq}: ${errorText(err)}`;
  }
}
