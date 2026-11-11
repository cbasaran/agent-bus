// The main pane: header and messages (with quotes, receipts, attachments), and renderAll.
import type { Message, Quote, ReceiptFrame } from "@agent-bus/protocol";
import { renderFile } from "./attachments";
import { setReplyTo, updateComposerState } from "./composer";
import { dom } from "./dom";
import { dayFormat, dayKey, fullFormat, nameList, timeFormat } from "./format";
import { h } from "./html";
import { renderMarkdown } from "./markdown";
import { setTitleBase } from "./notify";
import { navigate } from "./routing";
import { renderSidebar } from "./sidebar";
import { conversationTitle, state } from "./state";
import { flashMessage, mentionNodes, mentionsMe, shownMessage } from "./text";

export function renderAll(): void {
  renderProfileSelect();
  renderSidebar();
  renderHeader();
  renderMessages();
  updateComposerState();
}

function renderProfileSelect(): void {
  dom.profileSelect.replaceChildren(
    ...state.humans.map((id) => {
      const option = h("option", undefined, id);
      option.value = id;
      return option;
    })
  );
  dom.profileSelect.value = state.me;
}

export function renderHeader(): void {
  const view = state.view;
  if (view.kind === "draft") {
    dom.convTitle.textContent = nameList(view.to);
    dom.convSubtitle.textContent = `New conversation between you and ${nameList(view.to)} — created when you send the first message.`;
    setTitleBase(`${nameList(view.to)} · Agent Bus`);
    return;
  }
  const conv = state.conversations.get(view.id);
  if (!conv) {
    dom.convTitle.textContent = view.id;
    dom.convSubtitle.textContent = "Unknown conversation.";
    setTitleBase("Agent Bus");
    return;
  }
  const title = conversationTitle(conv);
  dom.convTitle.textContent = title;
  setTitleBase(`${title} · Agent Bus`);
  if (conv.kind === "all") {
    dom.convSubtitle.textContent = "Everyone. Every agent receives what is written here.";
  } else {
    const membership = conv.members.includes(state.me)
      ? ""
      : " You are viewing; you join when you send a message.";
    dom.convSubtitle.textContent = `Members: ${nameList(conv.members)}.${membership}`;
  }
}

export function showEmpty(text: string): void {
  dom.messageList.replaceChildren();
  dom.loadEarlier.hidden = true;
  dom.messageEmpty.hidden = false;
  dom.messageEmpty.textContent = text;
}

export function renderMessages(): void {
  const view = state.view;
  if (view.kind === "draft") {
    showEmpty(`No messages yet. Write below to start the conversation with ${nameList(view.to)}.`);
    return;
  }
  const cache = state.caches.get(view.id);
  if (!cache) {
    showEmpty("Loading…");
    return;
  }
  if (cache.messages.length === 0) {
    showEmpty("No messages yet.");
    return;
  }
  dom.messageEmpty.hidden = true;
  dom.loadEarlier.hidden = !cache.hasEarlier;

  const nodes: HTMLElement[] = [];
  let lastDay = "";
  let previous: Message | undefined;
  for (const message of cache.messages) {
    const day = dayKey(message.createdAt);
    if (day !== lastDay) {
      nodes.push(h("li", "day-divider", dayFormat.format(message.createdAt)));
      lastDay = day;
      previous = undefined;
    }
    const continued =
      previous !== undefined && previous.from === message.from && message.createdAt - previous.createdAt < 5 * 60_000;
    nodes.push(renderMessage(message, continued));
    previous = message;
  }
  dom.messageList.replaceChildren(...nodes);
}

function renderMessage(message: Message, continued: boolean): HTMLLIElement {
  const human = message.fromKind === "human";
  const li = h("li", `msg ${human ? "msg-human" : "msg-agent"}`);
  if (message.from === state.me) li.classList.add("msg-mine");
  else if (message.text && mentionsMe(message.text)) li.classList.add("msg-mentions-me");
  if (continued) li.classList.add("msg-continued");
  li.dataset.seq = String(message.seq);

  const head = h("div", "msg-head");
  const sender = h("button", "msg-sender", message.from);
  sender.type = "button";
  sender.title = human ? "Human" : "Agent — click to open a direct conversation";
  if (!human) sender.addEventListener("click", () => navigate({ kind: "draft", to: [message.from] }));
  head.append(sender, h("span", `kind-tag ${human ? "kind-human" : "kind-agent"}`, human ? "human" : "agent"));
  // Human messages written while the bus checks who humans are: signed in with a passkey, or not.
  if (message.verified === true) {
    const badge = h("span", "verified-tag", "✓");
    badge.title = "Signed in with a passkey: really them";
    head.append(badge);
  } else if (message.verified === false) {
    const badge = h("span", "unverified-tag", "not verified");
    badge.title = "Written without signing in: anyone on the LAN could have written this";
    head.append(badge);
  }
  const time = h("time", "msg-time", timeFormat.format(message.createdAt));
  time.dateTime = new Date(message.createdAt).toISOString();
  time.title = fullFormat.format(message.createdAt);
  head.append(h("span", "msg-seq", `#${message.seq}`), time);
  const replyBtn = h("button", "msg-reply-btn", "↩ Reply");
  replyBtn.type = "button";
  replyBtn.title = "Reply to this message (quotes it)";
  replyBtn.addEventListener("click", () => setReplyTo(message));
  head.append(replyBtn);
  li.append(head);

  if (message.quote) li.append(renderQuote(message.quote));
  if (message.text) li.append(renderText(message.text));
  if (message.files.length > 0) {
    const files = h("ul", "msg-files");
    for (const file of message.files) files.append(renderFile(file));
    li.append(files);
  }
  const receipts = renderReceipts(message);
  if (receipts) li.append(receipts);
  return li;
}

/**
 * "✓✓ seen by @a" / "✓ delivered to @a · not seen yet" / "○ not delivered yet to @a"; with several recipients
 * "✓✓ seen by all 3" or "✓✓ seen: @a · ✓ delivered: @b · ○ waiting: @c". Null when there are no agent recipients.
 */
function renderReceipts(message: Message): HTMLDivElement | null {
  const { receipts } = message;
  if (receipts.length === 0) return null;
  const seen = receipts.filter((r) => r.seenAt !== null);
  const delivered = receipts.filter((r) => r.seenAt === null && r.deliveredAt !== null);
  const pending = receipts.filter((r) => r.deliveredAt === null);
  const status = pending.length > 0 ? "receipts-pending" : delivered.length > 0 ? "receipts-delivered" : "receipts-seen";
  const el = h("div", `msg-receipts ${status}`);
  el.dataset.receipts = String(message.seq);
  const names = (list: typeof receipts) => list.map((r) => r.to).join(", ");
  if (receipts.length === 1) {
    const to = receipts[0]?.to ?? "";
    el.textContent = seen.length ? `✓✓ seen by ${to}` : delivered.length ? `✓ delivered to ${to} · not seen yet` : `○ not delivered yet to ${to}`;
  } else if (seen.length === receipts.length) {
    el.textContent = `✓✓ seen by all ${receipts.length}`;
  } else {
    el.textContent = [
      seen.length ? `✓✓ seen: ${names(seen)}` : "",
      delivered.length ? `✓ delivered: ${names(delivered)}` : "",
      pending.length ? `○ waiting: ${names(pending)}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
  }
  el.title = receipts
    .map((r) =>
      r.seenAt !== null
        ? `${r.to}: seen ${fullFormat.format(r.seenAt)}`
        : r.deliveredAt !== null
          ? `${r.to}: delivered ${fullFormat.format(r.deliveredAt)}, not seen yet`
          : `${r.to}: not delivered yet`
    )
    .join("\n");
  return el;
}

/** Updates the cached message and, if it is on screen, its receipt line. */
export function applyReceipt(receipt: ReceiptFrame): void {
  const message = state.caches.get(receipt.conversationId)?.messages.find((m) => m.seq === receipt.seq);
  const entry = message?.receipts.find((r) => r.to === receipt.to);
  if (!message || !entry) return;
  entry.deliveredAt = receipt.deliveredAt;
  entry.seenAt = receipt.seenAt;
  const shown = dom.messageList.querySelector(`[data-receipts="${receipt.seq}"]`);
  const updated = renderReceipts(message);
  if (shown && updated) shown.replaceWith(updated);
}

/** Quote block of a reply; clicking jumps to the original when it is loaded. */
function renderQuote(quote: Quote): HTMLButtonElement {
  const el = h("button", "msg-quote");
  el.type = "button";
  el.title = `Reply to #${quote.seq} — click to show it`;
  const files = quote.files > 0 ? ` · ${quote.files} file${quote.files === 1 ? "" : "s"}` : "";
  el.append(h("span", "msg-quote-from", quote.from), h("span", "msg-quote-text", `${quote.text || "(no text)"}${files}`));
  el.addEventListener("click", () => {
    const target = shownMessage(quote.seq);
    if (target) flashMessage(target);
  });
  return el;
}

/** Message text as markdown (see markdown.ts), with @mentions highlighted outside code. */
function renderText(text: string): HTMLDivElement {
  const body = h("div", "msg-text");
  body.append(...renderMarkdown(text, mentionNodes));
  return body;
}
