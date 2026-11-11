// Browser notifications for messages for me, and the tab title and icon that show how many are unread.
import type { Conversation, Message } from "@agent-bus/protocol";
import { dom } from "./dom";
import { el } from "./html";
import { navigate } from "./routing";
import { conversationTitle, isCurrent, state } from "./state";

type NotifyState = "unsupported" | "insecure" | NotificationPermission;

function notifyState(): NotifyState {
  if (!("Notification" in window)) return "unsupported";
  if (!window.isSecureContext) return "insecure";
  return Notification.permission;
}

export function renderNotifyButton(): void {
  const s = notifyState();
  const btn = dom.notifyBtn;
  btn.hidden = s === "granted" || s === "unsupported";
  if (s === "default") {
    btn.textContent = "🔔 Enable notifications";
    btn.title = "Get a browser notification for messages that mention you or are in your conversations";
  } else if (s === "denied") {
    btn.textContent = "🔕 Notifications blocked";
    btn.title = "Allow notifications for this site in the browser's site settings (icon left of the address bar), then reload.";
  } else if (s === "insecure") {
    btn.textContent = "🔕 Notifications unavailable";
    btn.title =
      "Browsers allow notifications only on https:// or localhost pages. In Chrome: open " +
      "chrome://flags/#unsafely-treat-insecure-origin-as-secure, add " +
      `${location.origin}, set it to Enabled and relaunch.`;
  }
}

dom.notifyBtn.addEventListener("click", () => {
  if (notifyState() === "default") void Notification.requestPermission().then(renderNotifyButton);
  else alert(dom.notifyBtn.title);
});

export function notify(message: Message, conv: Conversation): void {
  if (notifyState() !== "granted" || (isCurrent(conv.id) && document.hasFocus())) return;
  const files = message.files.length > 0 ? ` [${message.files.map((f) => f.name).join(", ")}]` : "";
  const n = new Notification(`${message.from} · ${conversationTitle(conv)}`, {
    body: `${message.text.slice(0, 300)}${files}`,
    tag: `agent-bus-${message.seq}`,
  });
  n.addEventListener("click", () => {
    window.focus();
    navigate({ kind: "conversation", id: conv.id });
    n.close();
  });
}

let titleBase = "Agent Bus";

/** Tab icon: the header's ⇄ mark; a red dot while messages for me are unread. */
function faviconHref(attention: boolean): string {
  const dot = attention ? '<circle cx="26" cy="6" r="6" fill="#e5484d" stroke="#fff" stroke-width="2"/>' : "";
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
    '<rect x="1" y="1" width="30" height="30" rx="7" fill="#3563e9"/>' +
    '<path d="M8 12h14l-4-4M24 20H10l4 4" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>' +
    dot +
    "</svg>";
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

let faviconState: boolean | undefined;

export function applyTitle(): void {
  let n = 0;
  for (const count of state.attention.values()) n += count;
  let urgent = 0;
  for (const count of state.urgent.values()) urgent += count;
  document.title = n > 0 ? `${urgent > 0 ? "●●" : "●"} (${n}) ${titleBase}` : titleBase;
  if (faviconState !== n > 0) {
    faviconState = n > 0;
    el<HTMLLinkElement>("favicon").href = faviconHref(faviconState);
  }
}

/** The tab title without the unread marks: the open conversation's. */
export function setTitleBase(text: string): void {
  titleBase = text;
  applyTitle();
}
