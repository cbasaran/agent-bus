// The conversations page's elements (index.html), looked up once at load, and the message list's scrolling.
import { el } from "./html";

export const dom = {
  linkStatus: el<HTMLSpanElement>("link-status"),
  profileSelect: el<HTMLSelectElement>("profile-select"),
  newGroupBtn: el<HTMLButtonElement>("new-group-btn"),
  unreadBtn: el<HTMLButtonElement>("unread-btn"),
  offlineBtn: el<HTMLButtonElement>("offline-btn"),
  conversationList: el<HTMLUListElement>("conversation-list"),
  agentList: el<HTMLUListElement>("agent-list"),
  agentCount: el<HTMLSpanElement>("agent-count"),
  main: el<HTMLElement>("main"),
  convTitle: el<HTMLHeadingElement>("conv-title"),
  convSubtitle: el<HTMLDivElement>("conv-subtitle"),
  messageScroll: el<HTMLDivElement>("message-scroll"),
  loadEarlier: el<HTMLDivElement>("load-earlier"),
  loadEarlierBtn: el<HTMLButtonElement>("load-earlier-btn"),
  messageList: el<HTMLOListElement>("message-list"),
  messageEmpty: el<HTMLDivElement>("message-empty"),
  composer: el<HTMLFormElement>("composer"),
  composerError: el<HTMLDivElement>("composer-error"),
  stagedFiles: el<HTMLUListElement>("staged-files"),
  attachBtn: el<HTMLButtonElement>("attach-btn"),
  backBtn: el<HTMLButtonElement>("back-btn"),
  backBadge: el<HTMLSpanElement>("back-badge"),
  detailsBtn: el<HTMLButtonElement>("details-btn"),
  fileInput: el<HTMLInputElement>("file-input"),
  mentionMenu: el<HTMLUListElement>("mention-menu"),
  input: el<HTMLTextAreaElement>("composer-input"),
  composerGrip: el<HTMLDivElement>("composer-grip"),
  sendBtn: el<HTMLButtonElement>("send-btn"),
  dropOverlay: el<HTMLDivElement>("drop-overlay"),
  profileDialog: el<HTMLDialogElement>("profile-dialog"),
  profileChoices: el<HTMLDivElement>("profile-choices"),
  groupDialog: el<HTMLDialogElement>("group-dialog"),
  groupForm: el<HTMLFormElement>("group-form"),
  groupChoices: el<HTMLUListElement>("group-choices"),
  groupError: el<HTMLDivElement>("group-error"),
  groupCancel: el<HTMLButtonElement>("group-cancel"),
  notifyBtn: el<HTMLButtonElement>("notify-btn"),
  authLink: el<HTMLAnchorElement>("auth-link"),
  convFilter: el<HTMLDivElement>("conv-filter"),
  lightbox: el<HTMLDialogElement>("lightbox"),
  lightboxImg: el<HTMLImageElement>("lightbox-img"),
  lightboxName: el<HTMLSpanElement>("lightbox-name"),
  lightboxDownload: el<HTMLAnchorElement>("lightbox-download"),
  lightboxHint: el<HTMLSpanElement>("lightbox-hint"),
  app: el<HTMLDivElement>("app"),
  docPanel: el<HTMLElement>("doc-panel"),
  docTitle: el<HTMLSpanElement>("doc-title"),
  docDownload: el<HTMLAnchorElement>("doc-download"),
  docClose: el<HTMLButtonElement>("doc-close"),
  docBody: el<HTMLDivElement>("doc-body"),
  agentPanel: el<HTMLDivElement>("agent-panel"),
  agentInfo: el<HTMLDivElement>("agent-info"),
  agentOutput: el<HTMLDivElement>("agent-output"),
  agentOutputNote: el<HTMLSpanElement>("agent-output-note"),
  agentOutputToggle: el<HTMLButtonElement>("agent-output-toggle"),
  replyBar: el<HTMLDivElement>("reply-bar"),
  replyBarText: el<HTMLSpanElement>("reply-bar-text"),
  replyCancel: el<HTMLButtonElement>("reply-cancel"),
};

/** The phone layout of styles.css (one screen at a time: the conversation list or a conversation). */
export const PHONE = window.matchMedia("(max-width: 640px)");

export function nearBottom(): boolean {
  const s = dom.messageScroll;
  return s.scrollHeight - s.scrollTop - s.clientHeight < 80;
}

export function scrollToBottom(): void {
  dom.messageScroll.scrollTop = dom.messageScroll.scrollHeight;
}
