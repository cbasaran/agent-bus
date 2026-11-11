// Phones: one screen at a time (the conversation list, or one conversation), sized above the keyboard.
import { dom, nearBottom, PHONE, scrollToBottom } from "./dom";
import { isCurrent, state } from "./state";

// The iOS keyboard covers the page instead of shrinking it: pin the page to the visible area above it
// (CSS vars --vvh and --vvt), so the message box sits on the keyboard and the newest messages right above.
const viewport = window.visualViewport;
function fitViewport(): void {
  if (!viewport || !PHONE.matches) return;
  const stick = nearBottom();
  const root = document.documentElement.style;
  root.setProperty("--vvh", `${Math.round(viewport.height)}px`);
  root.setProperty("--vvt", `${Math.round(viewport.offsetTop)}px`);
  if (stick) scrollToBottom();
}
viewport?.addEventListener("resize", fitViewport);
viewport?.addEventListener("scroll", fitViewport);

/** Phones: show the conversation list (← in the conversation bar) instead of the open conversation. */
export function setPhoneList(on: boolean): void {
  dom.app.classList.toggle("phone-list", on);
}
dom.backBtn.addEventListener("click", () => {
  dom.input.blur();
  setPhoneList(true);
});

/** Phones: members, subtitle and the agent panel stay folded behind ⓘ so the messages get the screen. */
export function setDetails(on: boolean): void {
  dom.main.classList.toggle("show-details", on);
  dom.detailsBtn.setAttribute("aria-pressed", String(on));
}
dom.detailsBtn.addEventListener("click", () => setDetails(!dom.main.classList.contains("show-details")));

/** Unread messages in the other conversations, on the ← button. */
export function renderBackBadge(): void {
  let n = 0;
  let forMe = false;
  for (const [id, count] of state.unread) {
    if (isCurrent(id)) continue;
    n += count;
    if ((state.attention.get(id) ?? 0) > 0) forMe = true;
  }
  dom.backBadge.hidden = n === 0;
  dom.backBadge.textContent = n > 99 ? "99+" : String(n);
  dom.backBadge.classList.toggle("badge-for-me", forMe);
}
