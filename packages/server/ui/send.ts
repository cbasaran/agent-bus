// Sending what the message box holds, and the box's keys.
import {
  ALL_CONVERSATION_ID,
  formatAddress,
  type FileRef,
  type PostMessageRequest,
  type PostMessageResponse,
} from "@agent-bus/protocol";
import { api, postJson } from "./api";
import { autosize, hideError, renderStaged, setReplyTo, showError, updateComposerState } from "./composer";
import { dom, PHONE } from "./dom";
import { saveDraft } from "./drafts";
import { errorText } from "./format";
import { loadMessages, receive } from "./loading";
import { closeMention, handleMentionKey, updateMention } from "./mentions";
import { navigate } from "./routing";
import { state } from "./state";

async function uploadFile(file: File): Promise<FileRef> {
  const params = new URLSearchParams({ from: state.me, name: file.name });
  const res = await api<{ file: FileRef }>(`/api/files?${params}`, {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  return res.file;
}

async function send(): Promise<void> {
  if (state.sending || !state.me) return;
  const text = dom.input.value;
  if (!text.trim() && state.staged.length === 0) return;
  const view = state.view;
  state.sending = true;
  hideError();
  updateComposerState();
  renderStaged();
  try {
    const fileIds: string[] = [];
    for (const file of state.staged) {
      try {
        fileIds.push((await uploadFile(file)).id);
      } catch (err) {
        throw new Error(`Upload of ${file.name} failed: ${errorText(err)}`);
      }
    }
    const request: PostMessageRequest = { from: state.me, text };
    if (fileIds.length > 0) request.fileIds = fileIds;
    if (state.replyTo && view.kind === "conversation" && state.replyTo.conversationId === view.id) {
      request.replyToSeq = state.replyTo.seq;
    } else if (view.kind === "draft") request.to = formatAddress(view.to);
    else if (view.id === ALL_CONVERSATION_ID) request.to = "@all";
    else request.conversationId = view.id;

    const res = await postJson<PostMessageResponse>("/api/messages", request);
    dom.input.value = "";
    saveDraft(view, "");
    state.staged = [];
    setReplyTo(undefined);
    autosize();
    // Groups not loaded yet (e.g. a draft that just became a group) get their history fetched.
    if (!state.caches.has(res.conversation.id)) void loadMessages(res.conversation.id);
    receive(res.message, res.conversation);
    if (view.kind === "draft") navigate({ kind: "conversation", id: res.conversation.id });
  } catch (err) {
    showError(errorText(err));
  } finally {
    state.sending = false;
    renderStaged();
    updateComposerState();
    dom.input.focus();
  }
}

dom.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  void send();
});

// Tapping Send keeps the input focused: the keyboard stays up and nothing moves before the tap lands.
dom.sendBtn.addEventListener("pointerdown", (event) => {
  if (PHONE.matches && document.activeElement === dom.input) event.preventDefault();
});

dom.input.addEventListener("keydown", (event) => {
  if (state.mention.open && handleMentionKey(event)) return;
  if (event.key === "Escape" && state.replyTo) {
    event.preventDefault();
    setReplyTo(undefined);
    return;
  }
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void send();
  }
});

dom.input.addEventListener("input", () => {
  autosize();
  updateComposerState();
  updateMention();
  saveDraft(state.view, dom.input.value);
});
dom.input.addEventListener("click", () => updateMention());
dom.input.addEventListener("blur", () => closeMention());
