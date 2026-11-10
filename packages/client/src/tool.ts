// The `message-bus` tool, harness-neutral: its parameters, its description, the ops (reply, write, send, set, inbox,
// show, history, search) and the texts the model sees for deliveries and read results. Harness bindings (the omp
// extension, the Antigravity and Claude Code plugins) only turn the parameter list into their schema format and pass calls here.
// Hermes (Python) keeps its own copy of these texts; keep them in step.
import { realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deliveryHeader, describeReceipts, formatAddress, formatUtc, quoteLine } from "../../protocol/src/address";
import type { Reservation, ReservationResponse, Resource, ResourcesResponse } from "../../protocol/src/resources";
import type { Conversation, FileRef, Message, PostMessageResponse, ReadResponse, ReceiptFrame } from "../../protocol/src/types";
import type { BusConnection, Delivery } from "./connection";

export const TOOL_NAME = "message-bus";

export interface MessageBusToolParams {
  op: "reply" | "write" | "send" | "set" | "inbox" | "show" | "history" | "search" | "resources" | "reserve" | "release" | "extend";
  message_id?: number;
  to?: string;
  message?: string;
  files?: string[];
  key?: string;
  value?: string;
  query?: string;
  sender?: string;
  since?: number;
  limit?: number;
  scope?: "mine" | "all";
  resource?: string;
  reservation?: string;
  hours?: number;
  amount?: number;
  start?: string;
  purpose?: string;
}

/** One tool parameter, for building a harness's schema (zod for omp, JSON schema for MCP). Only `op` is required. */
export interface ToolParam {
  name: keyof MessageBusToolParams;
  type: "string" | "number" | "string[]";
  enum?: readonly string[];
  description: string;
}

export const TOOL_PARAMS: readonly ToolParam[] = [
  {
    name: "op",
    type: "string",
    enum: ["reply", "write", "send", "set", "inbox", "show", "history", "search", "resources", "reserve", "release", "extend"],
    description: "reply/write/send a message, set a setting, read (inbox, show, history, search), or the resource schedule (resources, reserve, release, extend)",
  },
  { name: "message_id", type: "number", description: "a message's #number (reply, show, history)" },
  { name: "to", type: "string", description: '"@all", "@id" or "@{id1,id2}" (write/send, history)' },
  { name: "message", type: "string", description: "message text (reply/write; optional caption for send)" },
  { name: "files", type: "string[]", description: "file paths, relative to the project folder or absolute (optional for reply and write)" },
  { name: "key", type: "string", description: "setting name (set)" },
  { name: "value", type: "string", description: "setting value (set)" },
  { name: "query", type: "string", description: "text to find, case-insensitive (search)" },
  { name: "sender", type: "string", description: "only messages from this id (search)" },
  { name: "since", type: "number", description: "only messages after this #number (inbox)" },
  { name: "limit", type: "number", description: "how many messages, default 20, at most 100 (inbox, history, search)" },
  { name: "scope", type: "string", enum: ["mine", "all"], description: '"mine" (default): your conversations and @all; "all": every conversation' },
  { name: "resource", type: "string", description: 'a resource: its label ("bariton GPU 2"), GPU uuid prefix or id (resources, reserve, release)' },
  { name: "reservation", type: "string", description: "a reservation id, r_… (release, extend)" },
  { name: "hours", type: "number", description: "how long (reserve) or how much longer from now (extend), at most 48" },
  { name: "amount", type: "number", description: "part of the resource (GPUs: GB of memory; services: slots); omit for all of it (reserve)" },
  { name: "start", type: "string", description: 'reserve: omit for now, a UTC time ("2026-11-10 14:00Z", at most 24 h ahead), or "next" to queue until it is free' },
  { name: "purpose", type: "string", description: "one line: what it is for (reserve)" },
];

/** Every argument the tool takes; anything else is rejected rather than silently ignored. */
export const TOOL_ARGS: readonly string[] = TOOL_PARAMS.map((p) => p.name);

/**
 * The tool description. `arrives` says when bus messages reach the model in this harness; `notJoining` says which
 * sessions are not on the bus.
 */
export function toolDescription(harness: { arrives: string; notJoining: string }): string {
  return (
    "Talk to the other agents and the humans (@can, @umit) on the shared message bus. " +
    // Same text as the cost note in packages/hermes-plugin/message-bus/__init__.py.
    "Every message you send starts a paid model turn for each agent it reaches (@all reaches every agent), so use the " +
    "bus sparingly: write only when the recipients need it (a result, a decision, a question, a claim or release of a " +
    "shared resource). Do not send acknowledgements, thanks or \"noted/received\" messages, and do not restate other " +
    "agents' messages; not replying is the default. Send to the fewest recipients who need it: @id or @{ids} rather " +
    "than @all, and only the agents who have to read or act on it. Your bus id comes from your " +
    `project folder and is shown in every result (${harness.notJoining}). ` +
    "Messages for you arrive in this conversation on their own as " +
    `"[message-bus] #<message_id> @sender → …", also while you are working: ${harness.arrives}. ` +
    "So never poll, and never read the bus database or files under ~/.agent-bus to " +
    "look for replies; keep working (or wait) and the reply comes to you. " +
    "op=reply: answer a message you received: `message_id` (the #number) plus `message` and/or `files`; it goes to that " +
    "message's conversation, so you never need to work out an address. " +
    "op=write: start or continue a conversation: `to` is \"@all\", \"@id\" or \"@{id1,id2}\" (a group; the same set always " +
    "reuses the same conversation), plus `message` and/or `files` (local paths). " +
    "op=send: the same as write, with `files` required. Unknown arguments are rejected and nothing is sent; every " +
    "result says what the bus stored (text length, file names). " +
    "op=set: `key` + `value`; settings: all = wake | quiet (whether @all messages from other agents start a turn for you; default quiet). " +
    "Reading (no turns for anyone, only your own tokens; never read the bus database instead): " +
    "op=inbox: messages sent to you, newest `limit` (default 20), optionally only after #`since`. " +
    "op=show: one message by `message_id`, in full, with its files downloaded. " +
    "op=history: the last `limit` messages of a conversation: `to` (as you would write to it, e.g. \"@all\", \"@hilde\") " +
    "or the conversation of `message_id`. " +
    "op=search: messages whose text contains `query` and/or from `sender`, newest `limit`, as one-line hits. " +
    "show, history and search cover the conversations you are in (and @all); add scope=\"all\" for every conversation. " +
    "Shared GPUs, services and accounts (experimental; instead of claim/release messages): op=resources lists who holds " +
    "what now and next, and what is actually running; op=reserve takes `resource`, `hours`, `purpose` (optional " +
    "`amount`, `start`) and refuses when it does not fit, saying when it is free; start GPU jobs with " +
    "`agent-bus run <reservation> -- <command>` so they run on exactly those GPUs and count as yours; op=release " +
    "(`reservation` or `resource`) as soon as you are done; op=extend (`reservation`, `hours`) while you still use it. " +
    "@resources writes to you when a hold is over, idle, or yours after a wait."
  );
}

/** `dir` is the temp directory (`os.tmpdir()`, symlinks resolved) or inside it. */
export function isUnderTempDir(dir: string): boolean {
  let tmp = os.tmpdir();
  try {
    tmp = realpathSync(tmp);
    dir = realpathSync(dir);
  } catch {
    // Keep the unresolved paths.
  }
  return dir === tmp || dir.startsWith(tmp.endsWith(path.sep) ? tmp : tmp + path.sep);
}

/** Where an agent's received attachments are saved. */
export function receivedDir(agentId: string): string {
  return path.join(os.homedir(), ".agent-bus", "received", agentId);
}

/** Downloads a delivery's attachments and returns the text the session gets for it. */
export async function deliveryText(conn: BusConnection, delivery: Delivery): Promise<string> {
  const saved: string[] = [];
  if (delivery.message.files.length > 0 && conn.id) {
    for (const file of delivery.message.files) saved.push(await conn.downloadFile(file, receivedDir(conn.id)));
  }
  return formatDelivery(delivery, saved);
}

/** Text injected into the session for one delivery; `savedFiles` are local paths of its attachments. */
export function formatDelivery(delivery: Delivery, savedFiles: string[]): string {
  const { message, conversation, replyTo } = delivery;
  const where = conversation.kind === "all" ? "@all" : formatAddress(conversation.addressed);
  const lines = [deliveryHeader(message.seq, message.from, where, message.createdAt)];
  if (message.quote) lines.push(quoteLine(message.quote));
  if (message.text) lines.push(message.text);
  message.files.forEach((file, i) => {
    lines.push(`File: ${savedFiles[i] ?? file.name} (${file.name}, ${file.size} B, sha256 ${file.sha256.slice(0, 12)}…)`);
  });
  lines.push(`(Reply only if they need something from you: ${TOOL_NAME} reply, message_id ${message.seq} → ${replyTo}.)`);
  return lines.join("\n");
}

/** Text the session gets when a late group recipient has now received one of its messages. */
export function receiptNoticeText(receipt: ReceiptFrame): string {
  return `[message-bus] @${receipt.to} has now received your message #${receipt.seq} (conversation ${receipt.conversationId}).`;
}

/** Per-message text shown by inbox and history; `show` gives all of it. */
const READ_TEXT_CHARS = 3000;
/** Total size of one read result, so a large page cannot flood the context (older messages are dropped first). */
const READ_BUDGET_CHARS = 30_000;

/**
 * One message as the read ops list it. Deliberately not the delivery header (`[message-bus] #n @…`): read results
 * must not look like new messages, and the seen-detection keys on that header.
 */
export function formatReadMessage(message: Message, conversation: Conversation | undefined, maxText: number, savedFiles: string[] = []): string {
  const where = !conversation ? message.conversationId : conversation.kind === "all" ? "@all" : formatAddress(conversation.members);
  const lines = [`#${message.seq} @${message.from} → ${where} · ${formatUtc(message.createdAt)}`];
  if (message.quote) lines.push(quoteLine(message.quote));
  if (message.text) {
    lines.push(
      message.text.length > maxText
        ? `${message.text.slice(0, maxText)}… (${message.text.length} chars; op=show message_id ${message.seq} for all)`
        : message.text
    );
  }
  message.files.forEach((file, i) => lines.push(`File: ${savedFiles[i] ?? file.name} (${file.name}, ${file.size} B)`));
  return lines.join("\n");
}

/** "#n · time · @from → where: …snippet…" around the first match of `query`. */
export function formatSearchHit(message: Message, conversation: Conversation | undefined, query: string): string {
  const where = !conversation ? message.conversationId : conversation.kind === "all" ? "@all" : formatAddress(conversation.members);
  const flat = message.text.replace(/\s+/g, " ").trim();
  const at = query ? flat.toLowerCase().indexOf(query.toLowerCase()) : 0;
  const start = Math.max(0, at - 80);
  const snippet = `${start > 0 ? "…" : ""}${flat.slice(start, start + 200)}${start + 200 < flat.length ? "…" : ""}`;
  const files = message.files.length > 0 ? ` [${message.files.map((f) => f.name).join(", ")}]` : "";
  return `#${message.seq} · ${formatUtc(message.createdAt)} · @${message.from} → ${where}: ${snippet || "(no text)"}${files}`;
}

/** Joins entries newest-last within the budget, dropping the oldest first. */
function withinBudget(entries: string[], separator: string): { text: string; dropped: number } {
  const kept: string[] = [];
  let size = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] ?? "";
    if (kept.length > 0 && size + entry.length > READ_BUDGET_CHARS) break;
    kept.unshift(entry);
    size += entry.length + separator.length;
  }
  return { text: kept.join(separator), dropped: entries.length - kept.length };
}

// ---- Resource schedule texts ----

/** "now", a UTC time ("2026-11-10 14:00Z" or ISO) or "next", as the server takes it. */
function parseStart(start: string): number | "next" {
  const s = start.trim().toLowerCase();
  if (s === "next") return "next";
  if (s === "now") return Date.now();
  const at = Date.parse(start.trim().replace(" ", "T"));
  if (Number.isNaN(at)) throw new Error(`start must be "next", "now" or a UTC time like "2026-11-10 14:00Z", not ${JSON.stringify(start)}.`);
  return at;
}

function findResource(resources: Resource[], query: string): Resource | undefined {
  const q = query.trim().toLowerCase();
  return resources.find((r) => r.id.toLowerCase() === q || r.label.toLowerCase() === q || (r.uuid ?? "").toLowerCase().replace(/^gpu-/, "").startsWith(q.replace(/^gpu-/, "")));
}

/** An amount in the resource's unit, as people say it: GB for GPU memory. */
function formatAmount(amount: number, resource: Resource): string {
  if (resource.unit === "MiB") return `${(amount / 1024).toFixed(amount >= 10 * 1024 ? 0 : 1)} GB`;
  return `${amount} ${resource.unit}`;
}

const SHORT_TIME = (ts: number): string => formatUtc(ts).slice(5);

export function formatReservation(r: Reservation, resource: Resource): string {
  const part = r.amount === undefined ? "all of it" : formatAmount(r.amount, resource);
  const when =
    r.state === "queued"
      ? `queued for ${Math.round(r.durationMs / 360_000) / 10} h once free`
      : `${SHORT_TIME(r.start ?? 0)} – ${SHORT_TIME(r.end ?? 0)}`;
  return `${r.id} @${r.holder} ${resource.label} (${part}), ${when}, ${r.state}: ${r.purpose}`;
}

function runHint(res: ReservationResponse): string {
  if (res.resource.kind !== "gpu") return "";
  const run = `agent-bus run ${res.reservation.id} -- <command> (only that GPU is visible to it, and it counts as yours)`;
  if (res.reservation.state === "queued") return ` @resources writes to you when it is yours; then start its jobs with: ${run}.`;
  if (res.reservation.state === "planned") return ` From its start, run its jobs with: ${run}.`;
  return ` Start its jobs with: ${run}.`;
}

/** The schedule as the resources op shows it: per resource, holders now and next, then what runs on it; warnings last. */
export function formatSchedule(res: ResourcesResponse, only?: string): string {
  const resources = only ? res.resources.filter((r) => r === findResource(res.resources, only)) : res.resources;
  if (resources.length === 0) return only ? `No resource matches "${only}".` : "No resources on the schedule yet.";
  const lines: string[] = [];
  for (const resource of resources) {
    const observed = res.observed[resource.id];
    const head = [`${resource.label} (${resource.id}`];
    if (resource.unit === "MiB") head.push(`, ${formatAmount(resource.capacity, resource)}`);
    head.push(")");
    if (observed) head.push(`: ${formatAmount(observed.memoryUsed, resource)} used, ${observed.utilization}% busy`);
    lines.push(head.join(""));
    const open = res.reservations.filter((r) => r.resourceId === resource.id && ["active", "overdue", "planned", "queued"].includes(r.state));
    if (open.length === 0) lines.push("  reserved: nobody");
    for (const r of open) lines.push(`  ${formatReservation(r, resource)}${r.idleSince !== undefined ? " (idle)" : ""}`);
    for (const p of observed?.processes ?? []) {
      const who = p.agentId ? `@${p.agentId}` : p.container ? `container ${p.container}` : `pid ${p.pid}`;
      const what = p.container && p.agentId ? ` container ${p.container}` : ` ${p.command.slice(0, 50)}`;
      lines.push(`  runs: ${who}${what}, ${formatAmount(p.memory, resource)}${p.reservationId ? ` (${p.reservationId})` : ""}`);
    }
  }
  const warnings = res.warnings.filter((w) => resources.some((r) => r.id === w.resourceId));
  if (warnings.length > 0) lines.push("Warnings:", ...warnings.map((w) => `  ${w.text}`));
  return lines.join("\n");
}

/** How long write/send wait for recipients' harnesses to accept the message before reporting (ms). */
const receiptWaitMs = (): number => Number(process.env.AGENT_BUS_RECEIPT_WAIT_MS) || 5000;

/**
 * The tool's ops for one agent connection. Also tracks group messages whose recipients were still pending when the
 * tool returned, so the agent can be told when they receive them (`receiptNotice`).
 */
export class BusTool {
  private readonly awaitingReceipts = new Map<number, Set<string>>();

  constructor(private readonly conn: BusConnection) {}

  /** The text for a receipt the agent was promised ("You will be told when they receive it"), else undefined. */
  receiptNotice(receipt: ReceiptFrame): string | undefined {
    const pending = this.awaitingReceipts.get(receipt.seq);
    if (!pending?.delete(receipt.to)) return undefined;
    if (pending.size === 0) this.awaitingReceipts.delete(receipt.seq);
    return receiptNoticeText(receipt);
  }

  /** Runs one call; `cwd` resolves relative file paths. Returns the result text; throws with a message for the model. */
  async run(params: MessageBusToolParams, cwd: string): Promise<string> {
    const conn = this.conn;
    const unknown = Object.keys(params).filter((key) => !TOOL_ARGS.includes(key));
    if (unknown.length > 0) {
      throw new Error(`Unknown argument${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}; the arguments are ${TOOL_ARGS.join(", ")}. Nothing was sent.`);
    }
    const result = (out: string): string => `${out} (you are @${conn.id})`;
    const upload = async (files: string[]): Promise<FileRef[]> => {
      const refs: FileRef[] = [];
      for (const file of files) refs.push(await conn.uploadFile(path.resolve(cwd, file)));
      return refs;
    };
    /** "text 812 chars, 2 files: a.patch, b.py" — what the bus stored, so a wrong argument shows at once. */
    const contents = (res: PostMessageResponse): string => {
      const files = res.message.files;
      const text = res.message.text.length > 0 ? `text ${res.message.text.length} chars` : "no text";
      return files.length > 0 ? `${text}, ${files.length} file${files.length === 1 ? "" : "s"}: ${files.map((f) => f.name).join(", ")}` : text;
    };
    const sent = async (what: string, res: PostMessageResponse): Promise<string> =>
      result(`${what} (conversation ${res.conversation.id}, message #${res.message.seq}): ${contents(res)}; ${await this.deliveryStatus(res)}.`);
    /** Messages of a read result, newest kept when the page is too large. */
    const listed = (res: ReadResponse, what: string): string => {
      const byId = new Map(res.conversations.map((c) => [c.id, c]));
      const entries = res.messages.map((m) => formatReadMessage(m, byId.get(m.conversationId), READ_TEXT_CHARS));
      const { text, dropped } = withinBudget(entries, "\n\n");
      return `${res.messages.length} ${what}${dropped ? ` (${dropped} older ones left out; use a smaller limit)` : ""}:\n\n${text}\n`;
    };
    switch (params.op) {
      case "reply": {
        if (params.message_id === undefined || (!params.message && !params.files?.length)) {
          throw new Error("reply needs `message_id` and `message` (or `files`).");
        }
        const refs = await upload(params.files ?? []);
        const res = await conn.write({ replyToSeq: params.message_id }, params.message ?? "", refs.map((r) => r.id));
        return sent(`Replied to #${params.message_id}`, res);
      }
      case "write": {
        if (!params.to || (!params.message && !params.files?.length)) throw new Error("write needs `to` and `message` (or `files`).");
        const refs = await upload(params.files ?? []);
        return sent(`Sent to ${params.to}`, await conn.write({ to: params.to }, params.message ?? "", refs.map((r) => r.id)));
      }
      case "send": {
        if (!params.to || !params.files?.length) throw new Error("send needs `to` and `files`.");
        const refs = await upload(params.files);
        const res = await conn.write({ to: params.to }, params.message ?? "", refs.map((r) => r.id));
        return sent(`Sent to ${params.to}`, res);
      }
      case "set": {
        if (!params.key || params.value === undefined) throw new Error("set needs `key` and `value`.");
        const res = await conn.set(params.key, params.value);
        return result(`Settings now: ${JSON.stringify(res.participant.settings)}.`);
      }
      case "inbox": {
        const res = await conn.inbox(params.since ?? 0, params.limit ?? 20);
        if (res.messages.length === 0) return result(`No messages for you${params.since ? ` after #${params.since}` : ""}.`);
        return result(listed(res, "messages sent to you"));
      }
      case "show": {
        if (params.message_id === undefined) throw new Error("show needs `message_id`.");
        const { message, conversation } = await conn.message(params.message_id);
        if (params.scope !== "all" && conversation.kind === "group" && !conversation.members.includes(conn.id ?? "")) {
          throw new Error(`#${message.seq} is in a conversation you are not in (${formatAddress(conversation.members)}); add scope "all" to read it.`);
        }
        const saved: string[] = [];
        if (message.files.length > 0) {
          for (const file of message.files) saved.push(await conn.downloadFile(file, receivedDir(conn.id ?? "")));
        }
        return result(formatReadMessage(message, conversation, Number.MAX_SAFE_INTEGER, saved));
      }
      case "history": {
        let target: { to: string } | { conversationId: string };
        if (params.to) target = { to: params.to };
        else if (params.message_id !== undefined) target = { conversationId: (await conn.message(params.message_id)).message.conversationId };
        else throw new Error("history needs `to` (an address) or `message_id` (that message's conversation).");
        const res = await conn.history(target, params.limit ?? 20, params.scope === "all");
        if (res.messages.length === 0) return result("No messages in that conversation yet.");
        return result(listed(res, "messages, oldest first"));
      }
      case "search": {
        if (!params.query?.trim() && !params.sender) throw new Error("search needs `query` and/or `sender`.");
        const res = await conn.search(params.query ?? "", params.sender, params.limit ?? 20, params.scope === "all");
        if (res.messages.length === 0) return result("No matching messages.");
        const byId = new Map(res.conversations.map((c) => [c.id, c]));
        const hits = res.messages.map((m) => formatSearchHit(m, byId.get(m.conversationId), params.query ?? ""));
        const { text, dropped } = withinBudget(hits, "\n");
        return result(`${res.messages.length} matching messages, oldest first${dropped ? ` (${dropped} older ones left out)` : ""}:\n${text}\n`);
      }
      case "resources": {
        const res = await conn.resources();
        return result(formatSchedule(res, params.resource));
      }
      case "reserve": {
        if (!params.resource || params.hours === undefined || !params.purpose?.trim()) {
          throw new Error("reserve needs `resource`, `hours` and `purpose`.");
        }
        const body: Record<string, unknown> = { resource: params.resource, hours: params.hours, purpose: params.purpose };
        if (params.start !== undefined) body.start = parseStart(params.start);
        if (params.amount !== undefined) {
          // GPUs are booked in MiB; the model speaks GB.
          const target = findResource((await conn.resources()).resources, params.resource);
          body.amount = target?.unit === "MiB" ? Math.round(params.amount * 1024) : params.amount;
        }
        const res = await conn.schedule("/api/reservations", body);
        return result(`Reserved: ${formatReservation(res.reservation, res.resource)}.${runHint(res)}`);
      }
      case "release": {
        if (!params.reservation && !params.resource) throw new Error("release needs `reservation` or `resource`.");
        const res = params.reservation
          ? await conn.schedule(`/api/reservations/${encodeURIComponent(params.reservation)}/release`, {})
          : await conn.schedule("/api/reservations/current/release", { resource: params.resource });
        return result(`${res.reservation.state === "cancelled" ? "Cancelled" : "Released"}: ${formatReservation(res.reservation, res.resource)}.`);
      }
      case "extend": {
        if (!params.reservation || params.hours === undefined) throw new Error("extend needs `reservation` and `hours`.");
        const res = await conn.schedule(`/api/reservations/${encodeURIComponent(params.reservation)}/extend`, { hours: params.hours });
        return result(`Extended: ${formatReservation(res.reservation, res.resource)}.`);
      }
      default:
        throw new Error(`Unknown op ${JSON.stringify((params as { op?: unknown }).op)}; the ops are ${TOOL_PARAMS[0]?.enum?.join(", ")}.`);
    }
  }

  /** Waits for receipts and returns the delivery line for the tool result; remembers late group recipients. */
  private async deliveryStatus(sent: PostMessageResponse): Promise<string> {
    const message = await this.conn.waitForReceipts(sent.message.seq, receiptWaitMs());
    const pending = message.receipts.filter((r) => r.deliveredAt === null).map((r) => r.to);
    const late = pending.length > 0 && sent.conversation.kind === "group";
    if (late) this.awaitingReceipts.set(message.seq, new Set(pending));
    return `${describeReceipts(message.receipts)}${late ? ". You will be told when they receive it" : ""}`;
  }
}
