// The conversations page (index.html): wires the modules together, routes between views and boots.
import type { ViewerServerFrame } from "@agent-bus/protocol";
import { api, PROFILE_KEY } from "./api";
import { hideError, setReplyTo, showError } from "./composer";
import { dom, PHONE, scrollToBottom } from "./dom";
import { loadDraft } from "./drafts";
import { errorText } from "./format";
import "./group";
import { hooks } from "./hooks";
import { applyActivity, syncWatch } from "./live";
import { loadEarlier, loadMessages, loadState, receive } from "./loading";
import { closeMention, updateMention } from "./mentions";
import { setDetails, setPhoneList } from "./phones";
import { askProfile } from "./profile";
import { applyReceipt, renderAll, showEmpty } from "./render";
import { parseHash, viewHash } from "./routing";
import "./send";
import { renderSidebar } from "./sidebar";
import { connectViewer, setLinkStatus } from "./socket";
import { findGroup, isCurrent, state, type View } from "./state";
import { flashMessage, fetchMessage, shownMessage } from "./text";
import { loadReadMarkers, markRead, refreshUnread } from "./unread";

// ---- Routing (#/c/<id>, #/to/<a,b>) ----

/** Drafts whose group already exists open the conversation instead. */
function resolveView(view: View): View {
  if (view.kind !== "draft") return view;
  const existing = findGroup([state.me, ...view.to]);
  return existing ? { kind: "conversation", id: existing.id } : view;
}

function applyView(view: View): void {
  const resolved = resolveView(view);
  if (resolved !== view) {
    history.replaceState(null, "", viewHash(resolved));
  }
  const changed = viewHash(resolved) !== viewHash(state.view);
  state.view = resolved;
  if (resolved.kind === "conversation") {
    markRead(resolved.id);
    if (!state.caches.has(resolved.id)) void loadMessages(resolved.id);
  }
  if (changed) {
    hideError();
    closeMention();
    setReplyTo(undefined);
    setDetails(false);
  }
  setPhoneList(false);
  renderAll();
  if (changed) {
    loadDraft();
    scrollToBottom();
  }
}

window.addEventListener("hashchange", () => applyView(parseHash()));

/** Opens the conversation of message `seq` (loading earlier pages as needed), scrolls to it and flashes it. */
async function showMessage(seq: number): Promise<void> {
  const here = shownMessage(seq);
  if (here) return flashMessage(here);
  let id: string;
  try {
    id = (await fetchMessage(seq)).conversation.id;
  } catch (err) {
    showError(`Message #${seq}: ${errorText(err)}`);
    return;
  }
  if (!state.caches.has(id)) await loadMessages(id);
  if (!isCurrent(id)) {
    const view: View = { kind: "conversation", id };
    history.pushState(null, "", viewHash(view));
    applyView(view);
  }
  for (;;) {
    const cache = state.caches.get(id);
    const first = cache?.messages[0]?.seq;
    if (shownMessage(seq) || !cache?.hasEarlier || !isCurrent(id) || first === undefined || first < seq) break;
    await loadEarlier();
    if (state.caches.get(id)?.messages[0]?.seq === first) break; // the page failed to load
  }
  const target = shownMessage(seq);
  if (target) flashMessage(target);
}

hooks.applyView = applyView;
hooks.showMessage = showMessage;

// ---- Viewer socket ----

function handleFrame(frame: ViewerServerFrame): void {
  switch (frame.type) {
    case "participants":
      state.participants = frame.participants;
      renderSidebar();
      if (state.mention.open) updateMention();
      break;
    case "message":
      receive(frame.message, frame.conversation);
      break;
    case "receipt":
      applyReceipt(frame);
      break;
    case "activity":
      applyActivity(frame);
      break;
  }
}

/** After a reconnect: refresh state and drop message caches (they may have gaps). */
async function resync(): Promise<void> {
  try {
    await loadState();
  } catch (err) {
    setLinkStatus("offline", `state refresh failed: ${errorText(err)}`);
    return;
  }
  state.caches.clear();
  applyView(state.view);
  await refreshUnread();
}

// ---- Boot ----

/** Authentication state for the topbar link; the signed-in human, if any. */
async function loadAuth(): Promise<string | undefined> {
  try {
    const auth = await api<{ mode: string; me: string | null }>("/api/auth/state");
    if (auth.mode === "off") return undefined;
    dom.authLink.hidden = false;
    dom.authLink.textContent = auth.me ? `✓ ${auth.me}` : auth.mode === "required" ? "Sign in to write" : "Sign in";
    dom.authLink.title = auth.me ? "Signed in with a passkey (manage passkeys, sign out)" : "Sign in with a passkey so your messages count as verified";
    return auth.me ?? undefined;
  } catch {
    return undefined;
  }
}

async function boot(): Promise<void> {
  try {
    await loadState();
  } catch (err) {
    setLinkStatus("offline", "server unreachable");
    showEmpty(`Could not reach the bus: ${errorText(err)}. Reload to retry.`);
    return;
  }
  const saved = localStorage.getItem(PROFILE_KEY);
  state.me = saved && state.humans.includes(saved) ? saved : "";
  // With passkeys on, a signed-in browser is that human (the server refuses any other `from`).
  const signedIn = await loadAuth();
  if (signedIn && state.humans.includes(signedIn)) {
    state.me = signedIn;
    localStorage.setItem(PROFILE_KEY, signedIn);
    dom.profileSelect.disabled = true;
    dom.profileSelect.title = `Signed in as ${signedIn} with a passkey`;
  }
  if (state.me) loadReadMarkers();
  connectViewer({
    onOpen: (reconnected) => {
      if (reconnected) void resync();
      syncWatch(true);
    },
    onFrame: handleFrame,
  });
  // Phones opened without a conversation in the address start on the conversation list.
  const startOnList = location.hash === "";
  applyView(parseHash());
  if (startOnList) setPhoneList(true);
  loadDraft();
  if (!state.me) askProfile();
  else {
    // On phones the keyboard should open only when the box is tapped.
    if (!PHONE.matches) dom.input.focus();
    void refreshUnread();
  }
}

void boot();
// Keeps "n min ago" labels in the sidebar current.
setInterval(renderSidebar, 60_000);
