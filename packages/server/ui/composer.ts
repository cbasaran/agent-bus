// The message box: its state, size, reply bar and staged files. Sending is send.ts.
import { formatBytes, type Message } from "@agent-bus/protocol";
import { dom, nearBottom, PHONE, scrollToBottom } from "./dom";
import { nameList } from "./format";
import { h } from "./html";
import { conversationTitle, state } from "./state";

export function showError(text: string): void {
  dom.composerError.textContent = text;
  dom.composerError.hidden = false;
}

export function hideError(): void {
  dom.composerError.hidden = true;
  dom.composerError.textContent = "";
}

export function updateComposerState(): void {
  const hasContent = dom.input.value.trim().length > 0 || state.staged.length > 0;
  dom.sendBtn.disabled = state.sending || !state.me || !hasContent;
  dom.sendBtn.textContent = state.sending ? "Sending…" : "Send";
  const view = state.view;
  const conv = view.kind === "conversation" ? state.conversations.get(view.id) : undefined;
  const target = view.kind === "draft" ? nameList(view.to) : conv ? conversationTitle(conv) : "";
  dom.input.placeholder = PHONE.matches
    ? `Message ${target}…`
    : `Message ${target}…  (Enter to send, Shift+Enter for a new line, @ to mention)`;
}

/** Height the user gave the message box with its grip (px); undefined = grows with its text. Kept per browser. */
const COMPOSER_HEIGHT_KEY = "agent-bus.composerHeight";
const COMPOSER_MIN = 40;
const COMPOSER_AUTO_MAX = 240;
let composerHeight: number | undefined = Number(localStorage.getItem(COMPOSER_HEIGHT_KEY)) || undefined;

/** Tallest the box may be dragged: most of the chat, leaving room to see the newest messages. */
function composerMax(): number {
  const chat = dom.composer.parentElement;
  return Math.max(COMPOSER_MIN, Math.floor((chat?.clientHeight ?? window.innerHeight) * 0.7));
}

export function autosize(): void {
  if (composerHeight !== undefined) {
    dom.input.style.height = `${Math.min(composerHeight, composerMax())}px`;
    return;
  }
  dom.input.style.height = "auto";
  dom.input.style.height = `${Math.min(dom.input.scrollHeight, COMPOSER_AUTO_MAX)}px`;
}

function setComposerHeight(height: number | undefined): void {
  composerHeight = height;
  if (height === undefined) localStorage.removeItem(COMPOSER_HEIGHT_KEY);
  else localStorage.setItem(COMPOSER_HEIGHT_KEY, String(height));
  dom.composerGrip.setAttribute("aria-valuenow", String(height ?? dom.input.offsetHeight));
  autosize();
}

// Dragging the grip: read the sizes once at the start, then write only the box's height (one write per frame).
{
  const grip = dom.composerGrip;
  let drag: { startY: number; startHeight: number; max: number; stick: boolean; target: number; frame: number } | undefined;
  grip.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    try {
      grip.setPointerCapture(event.pointerId);
    } catch {
      // The pointer is already gone (released before this ran): the drag still follows moves over the grip.
    }
    grip.classList.add("dragging");
    const startHeight = dom.input.offsetHeight;
    drag = { startY: event.clientY, startHeight, max: composerMax(), stick: nearBottom(), target: startHeight, frame: 0 };
  });
  grip.addEventListener("pointermove", (event) => {
    const d = drag;
    if (!d) return;
    d.target = Math.round(Math.min(d.max, Math.max(COMPOSER_MIN, d.startHeight + d.startY - event.clientY)));
    d.frame ||= requestAnimationFrame(() => {
      d.frame = 0;
      dom.input.style.height = `${d.target}px`;
      // Writing (not reading) the scroll position keeps the newest message in view while the box grows.
      if (d.stick) dom.messageScroll.scrollTop = 1e9;
    });
  });
  const end = (): void => {
    const d = drag;
    if (!d) return;
    drag = undefined;
    cancelAnimationFrame(d.frame);
    grip.classList.remove("dragging");
    if (d.target !== d.startHeight) setComposerHeight(d.target);
    if (d.stick) scrollToBottom();
  };
  grip.addEventListener("pointerup", end);
  grip.addEventListener("pointercancel", end);
  grip.addEventListener("dblclick", () => setComposerHeight(undefined));
  grip.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const step = event.key === "ArrowUp" ? 24 : -24;
    setComposerHeight(Math.min(composerMax(), Math.max(COMPOSER_MIN, dom.input.offsetHeight + step)));
  });
  grip.setAttribute("aria-valuemin", String(COMPOSER_MIN));
}

export function setReplyTo(message: Message | undefined): void {
  state.replyTo = message;
  dom.replyBar.hidden = !message;
  if (message) {
    const text = message.text.replace(/\s+/g, " ").trim();
    dom.replyBarText.textContent = `Replying to ${message.from}: ${text.length > 120 ? `${text.slice(0, 119)}…` : text || "(file)"}`;
    dom.input.focus();
  }
}

dom.replyCancel.addEventListener("click", () => setReplyTo(undefined));

/** Object URLs of the staged image previews currently shown; revoked on every re-render. */
let stagedPreviewUrls: string[] = [];

export function renderStaged(): void {
  for (const url of stagedPreviewUrls) URL.revokeObjectURL(url);
  stagedPreviewUrls = [];
  dom.stagedFiles.hidden = state.staged.length === 0;
  dom.stagedFiles.replaceChildren(
    ...state.staged.map((file, index) => {
      const li = h("li", "staged-file");
      if (file.type.startsWith("image/")) {
        const url = URL.createObjectURL(file);
        stagedPreviewUrls.push(url);
        const img = h("img", "staged-preview");
        img.src = url;
        img.alt = file.name;
        li.append(img);
      }
      li.append(h("span", "file-name", file.name), h("span", "file-size", formatBytes(file.size)));
      const remove = h("button", "staged-remove", "×");
      remove.type = "button";
      remove.title = "Remove";
      remove.disabled = state.sending;
      remove.addEventListener("click", () => {
        state.staged.splice(index, 1);
        renderStaged();
        updateComposerState();
      });
      li.append(remove);
      return li;
    })
  );
}

function stageFiles(files: Iterable<File>): void {
  for (const file of files) state.staged.push(file);
  renderStaged();
  updateComposerState();
  dom.input.focus();
}

/** Browsers name every pasted image "image.png"; give each a distinct, dated name instead. */
function pastedName(file: File, index: number): File {
  if (file.name && file.name !== "image.png" && file.name !== "image.jpeg") return file;
  const ext = file.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  return new File([file], `pasted-${stamp}${index > 0 ? `-${index + 1}` : ""}.${ext}`, { type: file.type });
}

// Ctrl/⌘+V of an image (a screenshot) or of copied files attaches them; text pastes as usual.
dom.input.addEventListener("paste", (event) => {
  const files = Array.from(event.clipboardData?.files ?? []);
  if (files.length === 0) return;
  event.preventDefault();
  stageFiles(files.map(pastedName));
});

dom.attachBtn.addEventListener("click", () => dom.fileInput.click());
dom.fileInput.addEventListener("change", () => {
  if (dom.fileInput.files) stageFiles(Array.from(dom.fileInput.files));
  dom.fileInput.value = "";
});

// Drag and drop anywhere on the page.
let dragDepth = 0;

function hasFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes("Files") ?? false;
}

document.addEventListener("dragenter", (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth++;
  dom.dropOverlay.hidden = false;
});
document.addEventListener("dragover", (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
});
document.addEventListener("dragleave", (event) => {
  if (!hasFiles(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dom.dropOverlay.hidden = true;
});
document.addEventListener("drop", (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  dom.dropOverlay.hidden = true;
  if (event.dataTransfer) stageFiles(Array.from(event.dataTransfer.files));
});
