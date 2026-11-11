// `agent-bus doctor`: what is installed on this machine, which bus each install joins, whether this machine reaches
// it, and which of this machine's agents are on it now. Read-only.
import { existsSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Participant } from "@agent-bus/protocol";
import { HARNESSES } from "./harnesses";

const ok = (text: string): string => `  ✓ ${text}`;
const bad = (text: string): string => `  ✗ ${text}`;
const info = (text: string): string => `    ${text}`;

async function reach(url: string): Promise<{ ms: number; participants: Participant[] } | { error: string }> {
  const started = Date.now();
  try {
    const res = await fetch(`${url}/api/state`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const state = (await res.json()) as { participants: Participant[] };
    return { ms: Date.now() - started, participants: state.participants };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Prints the report; exit code 1 when an install's bus is unreachable. */
export async function runDoctor(urlOverride?: string): Promise<number> {
  const lines: string[] = [];
  const urls = new Set<string>();
  if (urlOverride) urls.add(urlOverride);
  else if (process.env.AGENT_BUS_URL) urls.add(process.env.AGENT_BUS_URL.replace(/\/+$/, ""));

  lines.push(`Harnesses on ${os.hostname()}:`);
  for (const h of HARNESSES) {
    const status = h.status({});
    const cli = h.command === undefined ? "" : Bun.which(h.command) ? `, ${h.command} on PATH` : `, ${h.command} not on PATH`;
    if (!status.installed) {
      lines.push(`  - ${h.name}: not installed${cli}`);
      continue;
    }
    if (status.busUrl) urls.add(status.busUrl);
    lines.push(ok(`${h.name}: ${status.where}${status.busUrl ? ` → ${status.busUrl}` : ""}${cli}`));
    for (const note of status.notes) lines.push(info(note));
  }
  if (existsSync(path.join(os.homedir(), ".hermes", "plugins", "message-bus"))) {
    lines.push(info("hermes: ~/.hermes/plugins/message-bus is there (installed by hand; see PROJECT.md)"));
  }

  const tokenFile = process.env.AGENT_BUS_TOKEN_FILE || path.join(os.homedir(), ".agent-bus", "agent-token");
  if (existsSync(tokenFile)) {
    const mode = statSync(tokenFile).mode & 0o777;
    lines.push(mode & 0o077 ? bad(`agent token ${tokenFile} is readable by others (mode ${mode.toString(8)}); chmod 600 it`) : ok(`agent token ${tokenFile}`));
  } else {
    lines.push(info(`agent token: none yet (${tokenFile}); the first agent that joins creates it`));
  }

  let failed = false;
  if (urls.size === 0) lines.push(info("No bus URL known: install a harness with --url, or pass --url."));
  for (const url of urls) {
    const result = await reach(url);
    if ("error" in result) {
      failed = true;
      lines.push(bad(`bus ${url}: unreachable (${result.error})`));
      continue;
    }
    lines.push(ok(`bus ${url}: reachable (${result.ms} ms)`));
    const mine = result.participants.filter((p) => p.kind === "agent" && p.host === os.hostname());
    if (mine.length === 0) lines.push(info(`no agents from ${os.hostname()} have joined it yet`));
    for (const p of mine) {
      const state = p.online ? (p.status?.state ?? "online") : "offline";
      lines.push(info(`@${p.id} (${p.harness ?? "?"}${p.path ? `, ${p.path}` : ""}): ${state}`));
    }
  }
  console.log(lines.join("\n"));
  return failed ? 1 : 0;
}
