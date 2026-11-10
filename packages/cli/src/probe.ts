// agent-bus probe: runs on a GPU host and reports to the bus, every 30 s, what each GPU is doing and which processes
// use it, with what the bus needs to attribute them: working directory, container (and its labels), and the
// AGENT_BUS_RESERVATION variable that `agent-bus run` sets. Read-only: it never touches a process.
import { execFile } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import * as os from "node:os";
import type { Observation } from "@agent-bus/protocol";

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

function csv(text: string): string[][] {
  return text
    .trim()
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => line.split(",").map((cell) => cell.trim()));
}

/** /proc/<pid>/environ's AGENT_BUS_RESERVATION (only readable for our own processes). */
function reservationEnv(pid: number): string | undefined {
  try {
    const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
    return env.find((e) => e.startsWith("AGENT_BUS_RESERVATION="))?.slice("AGENT_BUS_RESERVATION=".length) || undefined;
  } catch {
    return undefined;
  }
}

function cwdOf(pid: number): string | undefined {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return undefined;
  }
}

function commandOf(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
  } catch {
    return "";
  }
}

/** The docker container id of a process, from its cgroup ("…/docker-<id>.scope" or "…/docker/<id>"). */
function containerIdOf(pid: number): string | undefined {
  try {
    return /docker[-/]([0-9a-f]{64})/.exec(readFileSync(`/proc/${pid}/cgroup`, "utf8"))?.[1];
  } catch {
    return undefined;
  }
}

const containerCache = new Map<string, { name: string; labels: Record<string, string> } | null>();

async function container(id: string): Promise<{ name: string; labels: Record<string, string> } | undefined> {
  if (!containerCache.has(id)) {
    try {
      const out = await run("docker", ["inspect", "--format", "{{.Name}}\t{{json .Config.Labels}}", id]);
      const [name, labels] = out.trim().split("\t");
      containerCache.set(id, { name: (name ?? id).replace(/^\//, ""), labels: (JSON.parse(labels ?? "{}") as Record<string, string> | null) ?? {} });
    } catch {
      containerCache.set(id, null);
    }
  }
  return containerCache.get(id) ?? undefined;
}

/** One report of this host's GPUs and their processes. */
export async function observe(host = os.hostname()): Promise<Observation> {
  const gpus = csv(
    await run("nvidia-smi", ["--query-gpu=uuid,index,name,memory.total,memory.used,utilization.gpu", "--format=csv,noheader,nounits"])
  ).map(([uuid, index, model, total, used, util]) => ({
    uuid: uuid ?? "",
    index: Number(index),
    model: model ?? "",
    // GB10 (unified memory) reports [N/A]: sent as 0, and the bus then books that GPU only as a whole.
    memoryTotal: Number(total) || 0,
    memoryUsed: Number(used) || 0,
    utilization: Number(util) || 0,
  }));
  const apps = csv(await run("nvidia-smi", ["--query-compute-apps=gpu_uuid,pid,used_memory", "--format=csv,noheader,nounits"]));
  const processes: Observation["processes"] = [];
  for (const [gpuUuid, pidText, memory] of apps) {
    const pid = Number(pidText);
    if (!gpuUuid || !Number.isInteger(pid)) continue;
    const entry: Observation["processes"][number] = { gpuUuid, pid, memory: Number(memory) || 0, command: commandOf(pid) };
    const cwd = cwdOf(pid);
    if (cwd) entry.cwd = cwd;
    const env = reservationEnv(pid);
    if (env) entry.reservationEnv = env;
    const containerId = containerIdOf(pid);
    if (containerId) {
      const info = await container(containerId);
      if (info) {
        entry.container = info.name;
        entry.containerLabels = info.labels;
      }
    }
    processes.push(entry);
  }
  return { host, at: Date.now(), gpus, processes };
}

/** Reports every `intervalMs` until stopped; `once` reports a single time (and prints it). */
export async function runProbe(busUrl: string, options: { intervalMs: number; once: boolean; dryRun: boolean }): Promise<number> {
  const report = async (): Promise<void> => {
    const observation = await observe();
    if (options.once) console.log(JSON.stringify(observation, null, 2));
    if (options.dryRun) return;
    const res = await fetch(`${busUrl}/api/observations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(observation),
    });
    if (!res.ok) throw new Error(`bus answered HTTP ${res.status}: ${await res.text()}`);
  };
  if (options.once) {
    await report();
    return 0;
  }
  for (;;) {
    try {
      await report();
    } catch (error) {
      console.error(`probe: ${error instanceof Error ? error.message : String(error)}`);
    }
    await Bun.sleep(options.intervalMs);
  }
}
