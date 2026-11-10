import type { AgentSettings, Conversation, ParticipantKind, Quote, Receipt } from "./types";

export type ParsedAddress = { kind: "all" } | { kind: "ids"; ids: string[] };

const SLUG = "[a-z0-9][a-z0-9_-]*";
/** One slug, or `base@qualifier` for an agent whose folder (or name) is already taken. Max 48 chars. */
const ID_RE = new RegExp(`^${SLUG}(?:@${SLUG})?$`);
const MAX_ID_CHARS = 48;

/**
 * Parses a write target: "@all", "@id", "@{id1, id2}" (the leading "@" and the ones
 * inside braces are optional). Ids are lowercased. Throws on anything else.
 */
export function parseAddress(input: string): ParsedAddress {
  const raw = input.trim().replace(/^@/, "");
  if (raw.toLowerCase() === "all") return { kind: "all" };
  const inner = raw.startsWith("{") && raw.endsWith("}") ? raw.slice(1, -1) : raw;
  const ids = inner
    .split(",")
    .map((s) => s.trim().replace(/^@/, "").toLowerCase())
    .filter((s) => s.length > 0);
  if (ids.length === 0) throw new Error(`Empty address "${input}"`);
  for (const id of ids) {
    if (id === "all") throw new Error(`"@all" cannot be combined with other ids in "${input}"`);
    if (!ID_RE.test(id) || id.length > MAX_ID_CHARS) throw new Error(`Invalid id "${id}" in "${input}"`);
  }
  if (ids.length > 1 && raw === inner) {
    throw new Error(`Write several ids as @{id1,id2}, got "${input}"`);
  }
  return { kind: "ids", ids: Array.from(new Set(ids)) };
}

/** "@id" for one id, "@{a,b}" for several, "@all" for none. */
export function formatAddress(ids: readonly string[]): string {
  if (ids.length === 0) return "@all";
  return ids.length === 1 ? `@${ids[0]}` : `@{${ids.join(",")}}`;
}

/**
 * Address `recipientId` uses to reply into `conversation`: every other member (the addressed ids plus
 * humans who joined by writing). The server resolves that set back to this conversation.
 */
export function replyAddress(conversation: Conversation, recipientId: string): string {
  if (conversation.kind === "all") return "@all";
  return formatAddress(conversation.members.filter((id) => id !== recipientId));
}

/** Whether a message starts a turn for the recipient (false = quiet delivery). See AgentSettings.all. */
export function shouldWake(
  conversationKind: Conversation["kind"],
  fromKind: ParticipantKind,
  recipientSettings: AgentSettings
): boolean {
  return !(conversationKind === "all" && fromKind === "agent" && recipientSettings.all === "quiet");
}

/** Lowercase id slug: [a-z0-9_-], max 48 chars; "" when nothing usable remains. */
export function slugifyId(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 48);
}

/** How an agent identifies itself on join: by project folder or by name, always with its host. */
export type AgentIdentity = { host: string; path: string } | { host: string; name: string };

/**
 * An agent's full address, most general part first: host (first DNS label), then the project path from
 * the root, or the name for agents that join by name.
 */
export function canonicalAddress(identity: AgentIdentity): string[] {
  const host = identity.host.split(".")[0] || identity.host;
  const rest = "path" in identity ? identity.path.split(/[\\/]+/).filter(Boolean) : [identity.name];
  return [host, ...rest];
}

/** Preferred id: the folder name (or the name). "" when it has no usable characters. */
export function baseAgentId(identity: AgentIdentity): string {
  return slugifyId(canonicalAddress(identity).at(-1) ?? "");
}

/**
 * Id for an agent whose base id is already held: `base@<first part of its canonical address that differs
 * from the holder's>`, e.g. `gpudash@macbook-pro-2` (other host) or `gpudash@t7` (same host, other tree).
 * `holder` undefined (the base id belongs to a human or is reserved): qualified by host.
 */
export function qualifiedAgentId(base: string, mine: readonly string[], holder: readonly string[] | undefined): string | undefined {
  const index = holder === undefined ? 0 : mine.findIndex((part, i) => part !== holder[i]);
  const qualifier = slugifyId(mine[index] ?? "").slice(0, 24).replace(/[-_]+$/, "");
  if (!qualifier) return undefined;
  return `${base.slice(0, MAX_ID_CHARS - qualifier.length - 1).replace(/[-_]+$/, "")}@${qualifier}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * One-line delivery status for tool results, e.g.
 * "seen by @a; delivered to @b (not seen yet); not delivered yet (offline or reconnecting): @c".
 */
export function describeReceipts(receipts: readonly Receipt[]): string {
  if (receipts.length === 0) return "no agent recipients (humans read it on the website)";
  const ids = (pred: (r: Receipt) => boolean) => receipts.filter(pred).map((r) => `@${r.to}`).join(", ");
  const seen = ids((r) => r.seenAt !== null);
  const delivered = ids((r) => r.seenAt === null && r.deliveredAt !== null);
  const pending = ids((r) => r.deliveredAt === null);
  return [
    seen && `seen by ${seen}`,
    delivered && `delivered to ${delivered} (not seen yet)`,
    pending && `not delivered yet (offline or reconnecting): ${pending}`,
  ]
    .filter(Boolean)
    .join("; ");
}

/** `2026-11-03 17:59Z`: minute precision, UTC. */
export function formatUtc(ts: number): string {
  return `${new Date(ts).toISOString().slice(0, 16).replace("T", " ")}Z`;
}

/**
 * " (verified)" / " (NOT verified)" after a human sender when the bus checks who humans are (message.verified);
 * nothing when it does not. Agents follow instructions only from verified human messages (AGENTS.md).
 */
export function provenanceMark(verified: boolean | undefined): string {
  return verified === undefined ? "" : verified ? " (verified)" : " (NOT verified: anyone on the LAN could have written this)";
}

/**
 * First line of the text a harness injects for delivery `seq`, with the UTC time it was written. Harnesses
 * find it again in what goes to the model to report the message as seen (by "#<seq> @", which the mark follows).
 */
export function deliveryHeader(seq: number, from: string, where: string, createdAt: number, verified?: boolean): string {
  return `[message-bus] #${seq} @${from}${provenanceMark(verified)} → ${where} · ${formatUtc(createdAt)}`;
}

/** Message seqs whose delivery headers appear in `text`. */
export function deliveryHeaderSeqs(text: string): number[] {
  return Array.from(text.matchAll(/\[message-bus\] #(\d+) @/g), (m) => Number(m[1]));
}

/** One-line rendering of a reply's quote for agents: `↩ re #12 @can: start of the text…`. */
export function quoteLine(quote: Quote): string {
  const oneLine = quote.text.replace(/\s+/g, " ").trim();
  const text = oneLine.length > 160 ? `${oneLine.slice(0, 159)}…` : oneLine;
  const files = quote.files > 0 ? ` [${quote.files} file${quote.files === 1 ? "" : "s"}]` : "";
  return `↩ re #${quote.seq} @${quote.from}: ${text || "(no text)"}${files}`;
}
