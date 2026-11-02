import type { CustomSelectorConfig } from "../types";
import type {
  AdapterSelectorSpec,
  AssistantTurnSnapshot,
  WebChatAdapter,
} from "./adapter-types";

function isExplicitlyHidden(el: HTMLElement): boolean {
  if (el.hidden) return true;
  if (el.getAttribute("aria-hidden") === "true") return true;
  const inlineStyle = el.style;
  if (inlineStyle && (inlineStyle.display === "none" || inlineStyle.visibility === "hidden")) {
    return true;
  }
  const view = el.ownerDocument?.defaultView;
  if (view && typeof view.getComputedStyle === "function") {
    try {
      const computed = view.getComputedStyle(el);
      if (computed.display === "none" || computed.visibility === "hidden") {
        return true;
      }
    } catch {
      // Ignore synthetic DOM computedStyle failures
    }
  }
  return false;
}

export function isButtonDisabled(el: HTMLElement): boolean {
  if ((el as HTMLButtonElement).disabled === true) return true;
  if (el.hasAttribute("disabled")) return true;
  if (el.getAttribute("aria-disabled") === "true") return true;
  return false;
}

function buildSelectorList(
  customSelector: string | undefined,
  defaults: readonly string[]
): string[] {
  const trimmed = customSelector?.trim();
  if (!trimmed) {
    return [...defaults];
  }
  return [trimmed, ...defaults];
}

export function queryFirstMatching<T extends HTMLElement = HTMLElement>(
  selectors: readonly string[],
  root: ParentNode = document
): T | null {
  let fallbackVisible: T | null = null;

  for (const selector of selectors) {
    if (!selector.trim()) continue;
    let nodes: NodeListOf<Element>;
    try {
      nodes = root.querySelectorAll(selector);
    } catch {
      continue;
    }

    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) continue;
      if (node.closest("#agent-bus-shadow-host")) continue;
      if (isExplicitlyHidden(node)) continue;

      if (typeof node.getBoundingClientRect === "function") {
        const rect = node.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          return node as T;
        }
      }
      if (!fallbackVisible) {
        fallbackVisible = node as T;
      }
    }
  }

  return fallbackVisible;
}

export function queryFirstFileInput(
  selectors: readonly string[],
  root: ParentNode = document
): HTMLInputElement | null {
  for (const selector of selectors) {
    if (!selector.trim()) continue;
    let nodes: NodeListOf<Element>;
    try {
      nodes = root.querySelectorAll(selector);
    } catch {
      continue;
    }
    for (const node of nodes) {
      if (node instanceof HTMLInputElement && node.type === "file") {
        if (node.closest("#agent-bus-shadow-host")) continue;
        return node;
      }
    }
  }
  return null;
}

export function queryAllMatching<T extends HTMLElement = HTMLElement>(
  selectors: readonly string[],
  root: ParentNode = document
): T[] {
  for (const selector of selectors) {
    if (!selector.trim()) continue;
    let nodes: NodeListOf<Element>;
    try {
      nodes = root.querySelectorAll(selector);
    } catch {
      continue;
    }
    const collected: T[] = [];
    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) continue;
      if (node.closest("#agent-bus-shadow-host")) continue;
      if (isExplicitlyHidden(node)) continue;
      collected.push(node as T);
    }
    // Filter out ancestor containers if nested matches occur within the same selector list
    if (collected.length > 0) {
      return collected.filter(
        (candidate) => !collected.some((other) => other !== candidate && candidate.contains(other))
      );
    }
  }
  return [];
}

function createInputLikeEvent(type: string, data?: string): Event {
  if (typeof InputEvent === "function") {
    try {
      return new InputEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        inputType: "insertText",
        data: data ?? null,
      });
    } catch {
      // Fallback to standard Event below
    }
  }
  return new Event(type, { bubbles: true, cancelable: true });
}

/**
 * Sets prompt text on either a native `<textarea>`/`<input>` (including React-controlled inputs)
 * or a `contenteditable` editor (`div.ProseMirror`, Gemini `.ql-editor`, etc.).
 */
export function setElementPromptText(el: HTMLElement, text: string): boolean {
  const doc = el.ownerDocument ?? document;
  el.focus();

  const tag = el.tagName.toUpperCase();
  if (tag === "TEXTAREA" || tag === "INPUT") {
    const target = el as HTMLTextAreaElement | HTMLInputElement;
    const proto =
      tag === "TEXTAREA"
        ? typeof HTMLTextAreaElement !== "undefined"
          ? HTMLTextAreaElement.prototype
          : Object.getPrototypeOf(target)
        : typeof HTMLInputElement !== "undefined"
          ? HTMLInputElement.prototype
          : Object.getPrototypeOf(target);

    const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, "value") : undefined;
    if (descriptor?.set) {
      descriptor.set.call(target, text);
    } else {
      target.value = text;
    }

    target.dispatchEvent(createInputLikeEvent("input", text));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  // Contenteditable path (ProseMirror, Quill .ql-editor, generic contenteditable)
  const selection = doc.getSelection?.() ?? (typeof window !== "undefined" ? window.getSelection?.() : null);
  if (selection && typeof doc.createRange === "function") {
    try {
      const range = doc.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
    } catch {
      // Ignore selection range errors in minimal test DOMs
    }
  }

  el.dispatchEvent(createInputLikeEvent("beforeinput", text));

  let insertedViaExecCommand = false;
  if (typeof doc.execCommand === "function") {
    try {
      insertedViaExecCommand = doc.execCommand("insertText", false, text);
    } catch {
      insertedViaExecCommand = false;
    }
  }

  const normalizedExpected = text.replace(/\r\n/g, "\n").trim();
  const currentText = (el.textContent ?? "").replace(/\r\n/g, "\n").trim();

  if (!insertedViaExecCommand || (normalizedExpected.length > 0 && currentText !== normalizedExpected)) {
    // Paragraph DOM fallback for ProseMirror / Quill / synthetic DOMs
    while (el.firstChild) {
      el.removeChild(el.firstChild);
    }
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    for (const line of lines) {
      const p = doc.createElement("p");
      if (line.length === 0) {
        p.appendChild(doc.createElement("br"));
      } else {
        p.textContent = line;
      }
      el.appendChild(p);
    }

    if (selection && typeof doc.createRange === "function") {
      try {
        const endRange = doc.createRange();
        endRange.selectNodeContents(el);
        endRange.collapse(false);
        selection.removeAllRanges();
        selection.addRange(endRange);
      } catch {
        // Ignore cursor placement failure
      }
    }
  }

  el.dispatchEvent(createInputLikeEvent("input", text));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

/**
 * Attaches `File` objects to a Web Chat UI via `<input type="file">` DataTransfer assignment,
 * falling back to synthetic `ClipboardEvent("paste")` and `DragEvent("drop")` on `dropTarget`.
 */
export function attachFilesToPage(
  files: File[],
  fileInput: HTMLInputElement | null,
  dropTarget: HTMLElement | null
): boolean {
  if (files.length === 0) {
    return true;
  }
  if (typeof DataTransfer === "undefined") {
    return false;
  }

  const dt = new DataTransfer();
  for (const file of files) {
    dt.items.add(file);
  }

  if (fileInput) {
    try {
      fileInput.files = dt.files;
    } catch {
      Object.defineProperty(fileInput, "files", {
        value: dt.files,
        configurable: true,
      });
    }
    fileInput.dispatchEvent(new Event("input", { bubbles: true }));
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  if (dropTarget) {
    dropTarget.focus();

    // 1. Dispatch ClipboardEvent("paste")
    let pasteEvent: Event;
    if (typeof ClipboardEvent === "function") {
      try {
        pasteEvent = new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: dt,
        });
      } catch {
        pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
      }
    } else {
      pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    }
    if (!("clipboardData" in pasteEvent) || !(pasteEvent as ClipboardEvent).clipboardData) {
      Object.defineProperty(pasteEvent, "clipboardData", {
        value: dt,
        configurable: true,
      });
    }
    dropTarget.dispatchEvent(pasteEvent);

    // 2. Dispatch DragEvent("dragenter" / "dragover" / "drop")
    for (const dragType of ["dragenter", "dragover", "drop"] as const) {
      let dragEvent: Event;
      if (typeof DragEvent === "function") {
        try {
          dragEvent = new DragEvent(dragType, {
            bubbles: true,
            cancelable: true,
            dataTransfer: dt,
          });
        } catch {
          dragEvent = new Event(dragType, { bubbles: true, cancelable: true });
        }
      } else {
        dragEvent = new Event(dragType, { bubbles: true, cancelable: true });
      }
      if (!("dataTransfer" in dragEvent) || !(dragEvent as DragEvent).dataTransfer) {
        Object.defineProperty(dragEvent, "dataTransfer", {
          value: dt,
          configurable: true,
        });
      }
      dropTarget.dispatchEvent(dragEvent);
    }

    return true;
  }

  return false;
}

function isBusLabeledCodeBlock(pre: HTMLElement, code: HTMLElement): boolean {
  const combinedClass = `${pre.className || ""} ${code.className || ""}`;
  if (/\b(?:language|lang)-(?:agent-)?bus\b/i.test(combinedClass)) {
    return true;
  }
  const dataLang = (
    code.getAttribute("data-language") ??
    pre.getAttribute("data-language") ??
    pre.parentElement?.getAttribute("data-language") ??
    ""
  )
    .trim()
    .toLowerCase();
  if (dataLang === "bus" || dataLang === "agent-bus") {
    return true;
  }

  // Check sibling header labels in ChatGPT / Claude / Gemini rendered code containers
  const wrapper = pre.parentElement;
  const candidates = [
    ...Array.from(pre.querySelectorAll("span, div")),
    ...(wrapper ? Array.from(wrapper.children) : []),
  ];
  for (const node of candidates) {
    if (node === code || node.contains(code) || code.contains(node)) continue;
    const label = (node.textContent ?? "").trim().toLowerCase();
    if (
      label === "bus" ||
      label === "agent-bus" ||
      label.startsWith("bus\n") ||
      label === "buscopy" ||
      label === "buscopy code"
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Extracts text from an assistant message container while reconstructing fenced ```bus blocks
 * when the chat UI's Markdown renderer converted them into `<pre><code>` DOM nodes.
 */
export function extractAssistantTurnText(el: HTMLElement): string {
  const baseText = (el.innerText || el.textContent || "").trim();
  const preBlocks = Array.from(el.querySelectorAll("pre"));
  if (preBlocks.length === 0) {
    return baseText;
  }

  const reconstructedFences: string[] = [];
  for (const pre of preBlocks) {
    if (!(pre instanceof HTMLElement)) continue;
    const codeEl = pre.querySelector("code");
    const targetCode = codeEl instanceof HTMLElement ? codeEl : pre;
    const codeBody = (targetCode.textContent ?? "").trim();
    if (!codeBody) continue;

    if (isBusLabeledCodeBlock(pre, targetCode)) {
      const fenceCheck = new RegExp(
        "```(?:bus|agent-bus)\\s*\\r?\\n[\\s\\S]*?" +
          codeBody.slice(0, 32).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i"
      );
      if (!fenceCheck.test(baseText)) {
        reconstructedFences.push("```bus\n" + codeBody + "\n```");
      }
    }
  }

  if (reconstructedFences.length === 0) {
    return baseText;
  }
  return baseText + "\n\n" + reconstructedFences.join("\n\n");
}

export function extractDownloadLinks(
  el: HTMLElement
): Array<{ href: string; filename: string }> {
  const links: Array<{ href: string; filename: string }> = [];
  const anchors = el.querySelectorAll("a[download], a[href^='blob:']");
  for (const anchor of anchors) {
    if (!(anchor instanceof HTMLAnchorElement)) continue;
    const href = anchor.href;
    if (!href) continue;
    const filename =
      anchor.getAttribute("download")?.trim() ||
      (anchor.textContent ?? "").trim() ||
      "download.bin";
    links.push({ href, filename });
  }
  return links;
}

function sleepMs(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export function createSelectorAdapter(spec: AdapterSelectorSpec): WebChatAdapter {
  const custom: CustomSelectorConfig = spec.customSelectors ?? {};
  const composerSelectors = buildSelectorList(custom.composerSelector, spec.composerSelectors);
  const sendSelectors = buildSelectorList(custom.sendButtonSelector, spec.sendButtonSelectors);
  const stopSelectors = buildSelectorList(custom.stopButtonSelector, spec.stopButtonSelectors);
  const assistantSelectors = buildSelectorList(
    custom.assistantMessageSelector,
    spec.assistantMessageSelectors
  );
  const fileSelectors = buildSelectorList(custom.fileInputSelector, spec.fileInputSelectors);
  const dropSelectors = buildSelectorList(custom.dropZoneSelector, spec.dropZoneSelectors);

  return {
    id: spec.id,
    name: spec.name,

    matchesUrl(urlInput: string | URL): boolean {
      if (spec.hostnames.length === 0) return true;
      try {
        const parsed = typeof urlInput === "string" ? new URL(urlInput) : urlInput;
        const host = parsed.hostname.toLowerCase();
        return spec.hostnames.some((h) => host === h || host.endsWith(`.${h}`));
      } catch {
        return false;
      }
    },

    findComposer(root: ParentNode = document): HTMLElement | null {
      return queryFirstMatching<HTMLElement>(composerSelectors, root);
    },

    findSendButton(root: ParentNode = document): HTMLElement | null {
      return queryFirstMatching<HTMLElement>(sendSelectors, root);
    },

    findStopButton(root: ParentNode = document): HTMLElement | null {
      return queryFirstMatching<HTMLElement>(stopSelectors, root);
    },

    findFileInput(root: ParentNode = document): HTMLInputElement | null {
      return queryFirstFileInput(fileSelectors, root);
    },

    findDropTarget(root: ParentNode = document): HTMLElement | null {
      const explicit = queryFirstMatching<HTMLElement>(dropSelectors, root);
      if (explicit) return explicit;
      const composer = queryFirstMatching<HTMLElement>(composerSelectors, root);
      if (composer) return composer;
      if (root instanceof Document && root.body) return root.body;
      return root instanceof HTMLElement ? root : null;
    },

    isGenerating(root: ParentNode = document): boolean {
      const stopEl = queryFirstMatching<HTMLElement>(stopSelectors, root);
      if (!stopEl) return false;
      if (stopEl.tagName.toUpperCase() === "BUTTON" && isButtonDisabled(stopEl)) {
        return false;
      }
      return true;
    },

    getAssistantTurns(root: ParentNode = document): AssistantTurnSnapshot[] {
      const nodes = queryAllMatching<HTMLElement>(assistantSelectors, root);
      return nodes.map((el, idx) => {
        const attrId =
          el.getAttribute("data-message-id") ??
          el.getAttribute("data-testid") ??
          el.id ??
          `turn-${idx}`;
        return {
          id: `${idx}:${attrId}`,
          text: extractAssistantTurnText(el),
          element: el,
          downloadLinks: extractDownloadLinks(el),
        };
      });
    },

    setPromptText(text: string, root: ParentNode = document): boolean {
      const composer = this.findComposer(root);
      if (!composer) return false;
      return setElementPromptText(composer, text);
    },

    clickSend(root: ParentNode = document): boolean {
      const sendBtn = this.findSendButton(root);
      if (sendBtn && !isButtonDisabled(sendBtn)) {
        sendBtn.click();
        return true;
      }
      const composer = this.findComposer(root);
      if (composer) {
        composer.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true,
          })
        );
        return true;
      }
      return false;
    },

    async attachFiles(files: File[], root: ParentNode = document): Promise<boolean> {
      if (files.length === 0) return true;
      const fileInput = this.findFileInput(root);
      const dropTarget = this.findDropTarget(root);
      return attachFilesToPage(files, fileInput, dropTarget);
    },

    async submitTurn(
      text: string,
      files: File[] = [],
      root: ParentNode = document
    ): Promise<{ ok: boolean; error?: string }> {
      const composer = this.findComposer(root);
      if (!composer) {
        return { ok: false, error: `Composer element not found (${spec.name})` };
      }

      if (files.length > 0) {
        const attached = await this.attachFiles(files, root);
        if (attached) {
          await sleepMs(220);
        }
      }

      const textSet = setElementPromptText(composer, text);
      if (!textSet) {
        return { ok: false, error: `Failed to populate composer (${spec.name})` };
      }

      // Allow UI framework state tick to enable the Send button
      const deadline = Date.now() + 750;
      while (Date.now() < deadline) {
        const sendBtn = this.findSendButton(root);
        if (sendBtn && !isButtonDisabled(sendBtn)) {
          sendBtn.click();
          return { ok: true };
        }
        await sleepMs(45);
      }

      const clicked = this.clickSend(root);
      if (!clicked) {
        return { ok: false, error: `Send button unavailable or disabled (${spec.name})` };
      }
      return { ok: true };
    },
  };
}
