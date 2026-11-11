// Pure text helpers of the conversations page: names, paths, times.
import type { Participant } from "@agent-bus/protocol";

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function sortedUnique(ids: readonly string[]): string[] {
  return Array.from(new Set(ids)).sort();
}

/** Names as the website shows them: plain ids, no "@" (that is only for addressing in message text). */
export function nameList(ids: readonly string[]): string {
  return ids.join(", ");
}

export function shortPath(path: string): string {
  return path.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, "~");
}

/** Second sidebar line for an agent: path when it joined by folder, else harness; host when it disambiguates. */
export function agentDetail(agent: Participant, showHost: boolean): string {
  const parts: string[] = [];
  if (agent.path) parts.push(shortPath(agent.path));
  else if (agent.harness) parts.push(agent.harness);
  if (agent.host && (showHost || !agent.path)) parts.push(agent.host);
  return parts.join(" · ");
}

export const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
export const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
});
export const fullFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (dayKey(ts) === dayKey(Date.now())) return timeFormat.format(ts);
  return dayFormat.format(ts);
}

/** "40 s", "14 min", "2 h 5 min". */
export function elapsed(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}
