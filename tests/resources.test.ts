import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Observation, ResourcesResponse } from "@agent-bus/protocol";
import { createBusServer, type BusServerHandle } from "@agent-bus/server";
import { checkTickets, ticketEnv } from "../packages/cli/src/run";
import { ResourceSchedule, type Actor } from "../packages/server/src/resources";

const HOUR = 3600_000;
const MIN = 60_000;
const GPU = "GPU-aaaa1111-2222-3333-4444-555566667777";
const ALPHA: Actor = { id: "alpha", kind: "agent" };
const BETA: Actor = { id: "beta", kind: "agent" };
const CAN: Actor = { id: "can", kind: "human" };

let t = 0;
let notices: Array<{ to: string; text: string }> = [];
let schedule: ResourceSchedule;

function observation(processes: Observation["processes"] = [], at = t): Observation {
  return {
    host: "bariton.lan",
    at,
    gpus: [{ uuid: GPU, index: 2, model: "RTX PRO 6000", memoryTotal: 97887, memoryUsed: processes.reduce((s, p) => s + p.memory, 0), utilization: 50 }],
    processes,
  };
}

function process(extra: Partial<Observation["processes"][number]> = {}): Observation["processes"][number] {
  return { gpuUuid: GPU, pid: 100, memory: 40_000, command: "python train.py", ...extra };
}

beforeEach(() => {
  t = Date.parse("2026-11-10T08:00:00Z");
  notices = [];
  schedule = new ResourceSchedule(new Database(":memory:", { strict: true }), {
    notify: (to, text) => notices.push({ to, text }),
    changed: () => {},
    agentFolders: () => [
      { id: "alpha", host: "bariton", path: "/home/x/code/alpha" },
      { id: "beta", host: "bariton", path: "/home/x/code/beta" },
    ],
    now: () => t,
  });
  schedule.observe(observation());
});

test("a GPU is shared by memory until it is full; a refusal names the holder and when it is next free", () => {
  const gpu = schedule.resolve("bariton GPU 2");
  expect(gpu.id).toBe("bariton/gpu/GPU-aaaa1111");
  expect(schedule.resolve("aaaa1111").id).toBe(gpu.id);
  schedule.reserve({ from: "alpha", resource: "bariton GPU 2", hours: 2, amount: 40_000, purpose: "eval" }, ALPHA);
  schedule.reserve({ from: "beta", resource: "aaaa1111", hours: 4, amount: 40_000, purpose: "training" }, BETA);
  expect(() => schedule.reserve({ from: "beta", resource: gpu.id, hours: 1, amount: 40_000, purpose: "more" }, BETA)).toThrow(
    /taken then by @alpha .*@beta .*next free for this at 2026-11-10 10:00Z/
  );
  // All of it: only when nobody holds any of it.
  expect(() => schedule.reserve({ from: "beta", resource: gpu.id, hours: 1, purpose: "all" }, BETA)).toThrow(/next free for this at 2026-11-10 12:00Z/);
  // Booking that start works.
  const later = schedule.reserve({ from: "beta", resource: gpu.id, hours: 1, start: Date.parse("2026-11-10T12:00:00Z"), purpose: "all" }, BETA);
  expect(later.state).toBe("planned");
});

test("holds are bounded: at most 48 h, at most 24 h ahead, one planned or queued reservation per holder and resource", () => {
  expect(() => schedule.reserve({ from: "alpha", resource: "bariton GPU 2", hours: 49, purpose: "x" }, ALPHA)).toThrow(/at most 48 h/);
  expect(() => schedule.reserve({ from: "alpha", resource: "bariton GPU 2", hours: 1, start: t + 25 * HOUR, purpose: "x" }, ALPHA)).toThrow(/at most 24 h ahead/);
  schedule.reserve({ from: "alpha", resource: "bariton GPU 2", hours: 1, start: t + 2 * HOUR, purpose: "x" }, ALPHA);
  expect(() => schedule.reserve({ from: "alpha", resource: "bariton GPU 2", hours: 1, start: t + 5 * HOUR, purpose: "y" }, ALPHA)).toThrow(/already has a planned or queued/);
  expect(() => schedule.reserve({ from: "alpha", resource: "bariton GPU 2", hours: 1, purpose: " " }, ALPHA)).toThrow(/purpose is required/);
});

test("only a human can book over capacity, and it shows as a conflict", () => {
  schedule.reserve({ from: "alpha", resource: "bariton GPU 2", hours: 2, purpose: "run" }, ALPHA);
  expect(() => schedule.reserve({ from: "beta", resource: "bariton GPU 2", hours: 1, purpose: "x", force: true }, BETA)).toThrow(/taken then/);
  schedule.reserve({ from: "can", resource: "bariton GPU 2", hours: 1, purpose: "demo", force: true }, CAN);
  expect(schedule.listing().warnings.map((w) => w.kind)).toContain("conflict");
});

test("past its end a hold is overdue (holder told once), then expires and the queued holder gets it", () => {
  const a = schedule.reserve({ from: "alpha", resource: "bariton GPU 2", hours: 1, purpose: "run" }, ALPHA);
  const b = schedule.reserve({ from: "beta", resource: "bariton GPU 2", hours: 2, start: "next", purpose: "next run" }, BETA);
  expect(b.state).toBe("queued");
  // Alpha keeps using it, so the idle rule does not interfere.
  const use = (): void => schedule.observe(observation([process({ cwd: "/home/x/code/alpha" })]));
  t += HOUR + MIN;
  use();
  schedule.tick();
  schedule.tick();
  expect(notices.filter((n) => n.to === "alpha" && /ended at/.test(n.text))).toHaveLength(1);
  expect(schedule.listing().reservations.find((r) => r.id === a.id)?.state).toBe("overdue");
  // Grace: 30 min after the end.
  t += 30 * MIN;
  use();
  schedule.tick();
  const states = new Map(schedule.listing().reservations.map((r) => [r.id, r]));
  expect(states.get(a.id)?.state).toBe("expired");
  expect(states.get(b.id)?.state).toBe("active");
  expect(states.get(b.id)?.end).toBe(t + 2 * HOUR);
  expect(notices.some((n) => n.to === "alpha" && /expired/.test(n.text))).toBe(true);
  expect(notices.some((n) => n.to === "beta" && /is yours now/.test(n.text))).toBe(true);
});

test("an idle hold is flagged and its holder told; it is reclaimed only when someone waits", () => {
  const a = schedule.reserve({ from: "alpha", resource: "bariton GPU 2", hours: 8, purpose: "long run" }, ALPHA);
  // Nothing of alpha's runs: flagged after 30 min, told once.
  for (let i = 0; i < 4; i++) {
    t += 15 * MIN;
    schedule.observe(observation([process({ cwd: "/home/x/code/beta", memory: 2_000 })]));
    schedule.tick();
  }
  expect(schedule.listing().reservations.find((r) => r.id === a.id)?.idleSince).toBeDefined();
  expect(notices.filter((n) => n.to === "alpha" && /nothing of yours has run|but nothing/.test(n.text))).toHaveLength(1);
  // Idle without anyone waiting costs nothing: still alpha's after 3 h.
  t += 2 * HOUR;
  schedule.observe(observation());
  schedule.tick();
  expect(schedule.listing().reservations.find((r) => r.id === a.id)?.state).toBe("active");
  // Beta queues: the idle hold goes to beta.
  const b = schedule.reserve({ from: "beta", resource: "bariton GPU 2", hours: 1, start: "next", purpose: "short eval" }, BETA);
  schedule.tick();
  const states = new Map(schedule.listing().reservations.map((r) => [r.id, r.state]));
  expect(states.get(a.id)).toBe("reclaimed");
  expect(states.get(b.id)).toBe("active");
  expect(notices.some((n) => n.to === "alpha" && /reclaimed/.test(n.text))).toBe(true);
});

test("use clears the idle flag; no probe report means no idle verdict at all", () => {
  const a = schedule.reserve({ from: "alpha", resource: "bariton GPU 2", hours: 8, purpose: "run" }, ALPHA);
  t += 45 * MIN;
  schedule.observe(observation());
  schedule.tick();
  expect(schedule.listing().reservations.find((r) => r.id === a.id)?.idleSince).toBeDefined();
  // A process started with agent-bus run (env names the reservation) counts, wherever it runs.
  schedule.observe(observation([process({ cwd: "/tmp", reservationEnv: `r_other,${a.id}` })]));
  expect(schedule.listing().reservations.find((r) => r.id === a.id)?.idleSince).toBeUndefined();
  // The probe stops reporting: hours later still no idle flag, and a stale-probe warning instead.
  t += 3 * HOUR;
  schedule.tick();
  const listing = schedule.listing();
  expect(listing.reservations.find((r) => r.id === a.id)?.idleSince).toBeUndefined();
  expect(listing.warnings.map((w) => w.kind)).toContain("stale-probe");
});

test("processes are attributed by reservation, label or folder; the rest of real use is unclaimed", () => {
  const a = schedule.reserve({ from: "alpha", resource: "bariton GPU 2", hours: 2, amount: 30_000, purpose: "run" }, ALPHA);
  schedule.observe(
    observation([
      process({ pid: 1, reservationEnv: a.id, cwd: "/tmp" }),
      process({ pid: 2, cwd: "/home/x/code/beta/sub" }),
      process({ pid: 3, container: "vllm-x", containerLabels: { "agent-bus.agent": "gamma" } }),
      process({ pid: 4, container: "v3-gemma", memory: 59_000 }),
      process({ pid: 5, memory: 100 }),
    ])
  );
  const listing: ResourcesResponse = schedule.listing();
  const procs = listing.observed["bariton/gpu/GPU-aaaa1111"]?.processes ?? [];
  expect(procs.map((p) => [p.pid, p.agentId ?? null, p.reservationId ?? null])).toEqual([
    [1, "alpha", a.id],
    [2, "beta", null],
    [3, "gamma", null],
    [4, null, null],
    [5, null, null],
  ]);
  const unclaimed = listing.warnings.filter((w) => w.kind === "unclaimed").map((w) => w.text);
  // Beta, gamma and the unlabeled container use it without a reservation; the tiny process is ignored.
  expect(unclaimed).toHaveLength(3);
  expect(unclaimed.join("\n")).toContain("v3-gemma");
});

test("extend: the holder while using it (not while idle), up to 48 h from now; release: the holder or a human", () => {
  const a = schedule.reserve({ from: "alpha", resource: "bariton GPU 2", hours: 1, purpose: "run" }, ALPHA);
  schedule.observe(observation([process({ cwd: "/home/x/code/alpha" })]));
  expect(schedule.extend(a.id, 2, ALPHA).end).toBe(t + 3 * HOUR);
  expect(() => schedule.extend(a.id, 49, ALPHA)).toThrow(/at most 48/);
  expect(() => schedule.extend(a.id, 1, BETA)).toThrow(/alpha's/);
  t += 45 * MIN;
  schedule.observe(observation());
  schedule.tick();
  expect(() => schedule.extend(a.id, 1, ALPHA)).toThrow(/release it, or start using it/);
  expect(() => schedule.release(a.id, BETA)).toThrow(/only they or a human/);
  expect(schedule.release(a.id, CAN).state).toBe("released");
  expect(notices.some((n) => n.to === "alpha" && /@can released your reservation/.test(n.text))).toBe(true);
});

test("services and accounts are registered by hand and booked by slots", () => {
  schedule.register({ kind: "service", host: "spark2", name: "deepseek", label: "DeepSeek on spark2", capacity: 2, unit: "slot" });
  schedule.reserve({ from: "alpha", resource: "DeepSeek on spark2", hours: 1, amount: 1, purpose: "eval" }, ALPHA);
  schedule.reserve({ from: "beta", resource: "spark2/service/deepseek", hours: 1, amount: 1, purpose: "eval" }, BETA);
  expect(() => schedule.reserve({ from: "can", resource: "deepseek", hours: 1, amount: 1, purpose: "x" }, CAN)).toThrow(/taken then/);
  expect(() => schedule.register({ kind: "gpu", host: "x", name: "y" })).toThrow(/gpudash/);
});

test("agent-bus run: tickets must be active now; the command sees exactly their GPUs", () => {
  const a = schedule.reserve({ from: "alpha", resource: "bariton GPU 2", hours: 1, purpose: "run" }, ALPHA);
  const b = schedule.reserve({ from: "beta", resource: "bariton GPU 2", hours: 1, start: t + 2 * HOUR, purpose: "later" }, BETA);
  const listing = schedule.listing();
  const env = ticketEnv(checkTickets(listing, [a.id]), { PATH: "/bin", CUDA_VISIBLE_DEVICES: "0,1,2,3" });
  expect(env.CUDA_VISIBLE_DEVICES).toBe(GPU);
  expect(env.AGENT_BUS_RESERVATION).toBe(a.id);
  expect(() => checkTickets(listing, [b.id])).toThrow(/not yet/);
  expect(() => checkTickets(listing, ["r_nope"])).toThrow(/Unknown reservation/);
  schedule.release(a.id, ALPHA);
  expect(() => checkTickets(schedule.listing(), [a.id])).toThrow(/is over \(released\)/);
});

// ---- Over HTTP: the server's routes and @resources notices reaching an agent ----

let bus: BusServerHandle;
let dataDir: string;

afterEach(async () => {
  if (bus) await bus.stop();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

test("over HTTP: an observation, reservation, refusal, and a human's release reaching the holder from @resources", async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "mb-res-test-"));
  bus = createBusServer({ host: "127.0.0.1", port: 0, dataDir, humans: ["can", "umit"] });
  const delivered: string[] = [];
  const ws = new WebSocket(`${bus.url.replace(/^http/, "ws")}/ws/agent?host=bariton&harness=raw&path=/home/x/code/alpha`);
  ws.onmessage = (e) => {
    const frame = JSON.parse(String(e.data)) as { type: string; message?: { seq: number; from: string; text: string } };
    if (frame.type === "deliver" && frame.message) {
      delivered.push(`${frame.message.from}: ${frame.message.text}`);
      ws.send(JSON.stringify({ type: "ack", seq: frame.message.seq }));
    }
  };
  await new Promise((resolve) => ws.addEventListener("open", resolve));
  const post = async (p: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(`${bus.url}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  expect((await post("/api/observations", observation([], Date.now()))).status).toBe(200);
  const made = await post("/api/reservations", { from: "alpha", resource: "bariton GPU 2", hours: 1, purpose: "run" });
  expect(made.status).toBe(200);
  const id = (made.body.reservation as { id: string }).id;
  const refused = await post("/api/reservations", { from: "umit", resource: "bariton GPU 2", hours: 1, purpose: "x" });
  expect(refused.status).toBe(409);
  expect(String(refused.body.error)).toContain("@alpha");
  expect((await post("/api/reservations", { from: "nobody", resource: "bariton GPU 2", hours: 1, purpose: "x" })).status).toBe(400);
  expect((await post(`/api/reservations/${id}/release`, { from: "can" })).status).toBe(200);
  const deadline = Date.now() + 4000;
  while (!delivered.some((d) => d.startsWith("resources: @can released")) && Date.now() < deadline) await Bun.sleep(25);
  expect(delivered.find((d) => d.startsWith("resources:"))).toContain(`@can released your reservation ${id}`);
  const listing = (await (await fetch(`${bus.url}/api/resources`)).json()) as ResourcesResponse;
  expect(listing.reservations.find((r) => r.id === id)?.state).toBe("released");
  ws.close();
});

test("with --gpudash, the bus reads what runs from gpudash's /api/observations (registering the GPUs)", async () => {
  const gpudash = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) =>
      new URL(req.url).pathname === "/api/observations"
        ? Response.json([observation([process({ pid: 7, cwd: "/home/x/code/alpha/runs" })], Date.now())])
        : new Response("no", { status: 404 }),
  });
  try {
    dataDir = mkdtempSync(path.join(tmpdir(), "mb-res-test-"));
    bus = createBusServer({ host: "127.0.0.1", port: 0, dataDir, humans: ["can"], gpudash: `http://127.0.0.1:${gpudash.port}/` });
    const deadline = Date.now() + 4000;
    let listing: ResourcesResponse | undefined;
    while (Date.now() < deadline) {
      listing = (await (await fetch(`${bus.url}/api/resources`)).json()) as ResourcesResponse;
      if (listing.resources.length > 0) break;
      await Bun.sleep(50);
    }
    expect(listing?.resources.map((r) => r.label)).toEqual(["bariton GPU 2"]);
    expect(listing?.observed["bariton/gpu/GPU-aaaa1111"]?.processes[0]?.pid).toBe(7);
  } finally {
    gpudash.stop(true);
  }
});
