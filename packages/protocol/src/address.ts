import type { AgentSettings, Conversation, ParticipantKind, Receipt } from "./types";

export type ParsedAddress = { kind: "all" } | { kind: "ids"; ids: string[] };

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

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
    if (!ID_RE.test(id)) throw new Error(`Invalid id "${id}" in "${input}"`);
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

/**
 * Candidate agent ids for a project, most preferred first: folder name, then parent-folder
 * prefixed names, then the host-suffixed folder name. The server takes the first one not held
 * by a different host+path and falls back to a numeric suffix.
 */
export function agentIdCandidates(projectPath: string, host: string): string[] {
  const parts = projectPath.split(/[\\/]+/).filter(Boolean);
  const out: string[] = [];
  for (let n = 1; n <= Math.min(parts.length, 3); n++) {
    const id = slugifyId(parts.slice(-n).join("-"));
    if (id && !out.includes(id)) out.push(id);
  }
  const base = out[0] ?? "agent";
  const withHost = slugifyId(`${base}-${host}`);
  if (withHost && !out.includes(withHost)) out.push(withHost);
  return out.length > 0 ? out : ["agent"];
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

/**
 * First line of the text a harness injects for delivery `seq`. Harnesses find it again in what goes to the
 * model to report the message as seen.
 */
export function deliveryHeader(seq: number, from: string, where: string): string {
  return `[message-bus] #${seq} @${from} → ${where}`;
}

/** Message seqs whose delivery headers appear in `text`. */
export function deliveryHeaderSeqs(text: string): number[] {
  return Array.from(text.matchAll(/\[message-bus\] #(\d+) @/g), (m) => Number(m[1]));
}
