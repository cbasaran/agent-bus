// Resource schedule (experimental, docs/design/resources-and-auth.md part A): resources, reservations against them,
// and what probes observe on GPU hosts. The rules that counter greed (bounded holds, bounded booking ahead, overdue
// expiry, idle flags and reclaim when someone waits) run in `tick`. Advisory: nothing here stops a process; the
// launcher (`agent-bus run`) and the observations make following it easy and not following it visible.
import type { Database } from "bun:sqlite";
import {
  formatUtc,
  type Observation,
  type ObservedGpu,
  type ObservedProcess,
  type Reservation,
  type ReservationState,
  type ReserveRequest,
  type Resource,
  type ResourceKind,
  type ResourcesResponse,
  type ResourceWarning,
  type ScheduleRules,
} from "@agent-bus/protocol";

export class ScheduleError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

const HOUR = 3600_000;
const MIN = 60_000;

export const DEFAULT_RULES: ScheduleRules = {
  maxHoldMs: 48 * HOUR,
  overdueGraceMs: 30 * MIN,
  idleAfterMs: 30 * MIN,
  reclaimAfterMs: 2 * HOUR,
};

/** A probe's report older than this means the host is not observed now (no idle flags from stale data). */
const OBSERVATION_FRESH_MS = 3 * MIN;
/** Reservations that ended within this are still listed (the website's timeline looks back 6 h). */
const LIST_ENDED_MS = 24 * HOUR;
/** A process using more GPU memory than this counts as use. */
const USE_MIN_MIB = 256;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS resources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  host TEXT NOT NULL,
  label TEXT NOT NULL,
  capacity INTEGER NOT NULL,
  unit TEXT NOT NULL,
  source TEXT NOT NULL,
  uuid TEXT,
  model TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES resources(id),
  holder TEXT NOT NULL,
  amount INTEGER,
  start_at INTEGER,
  end_at INTEGER,
  duration_ms INTEGER NOT NULL,
  purpose TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  approved_by TEXT,
  forced INTEGER NOT NULL DEFAULT 0,
  private INTEGER NOT NULL DEFAULT 0,
  ended_at INTEGER,
  end_reason TEXT,
  last_used_at INTEGER,
  idle_since INTEGER,
  overdue_noticed INTEGER NOT NULL DEFAULT 0,
  idle_noticed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS reservations_open ON reservations(resource_id) WHERE ended_at IS NULL;
CREATE TABLE IF NOT EXISTS observations (
  host TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  observed_json TEXT NOT NULL
);
`;

interface ResourceRow {
  id: string;
  kind: string;
  host: string;
  label: string;
  capacity: number;
  unit: string;
  source: string;
  uuid: string | null;
  model: string | null;
}

interface ReservationRow {
  id: string;
  resource_id: string;
  holder: string;
  amount: number | null;
  start_at: number | null;
  end_at: number | null;
  duration_ms: number;
  purpose: string;
  created_by: string;
  created_at: number;
  approved_by: string | null;
  forced: number;
  private: number;
  ended_at: number | null;
  end_reason: string | null;
  last_used_at: number | null;
  idle_since: number | null;
  overdue_noticed: number;
  idle_noticed: number;
}

/** Who acts: the writer of a request (humans may act on anyone's reservation). */
export interface Actor {
  id: string;
  kind: "agent" | "human";
}

/** An agent's project folder, for attributing processes by working directory. */
export interface AgentFolder {
  id: string;
  host: string;
  path: string;
}

export interface ScheduleOptions {
  /** Tells a holder something (overdue, idle, reclaimed, now yours). */
  notify: (holder: string, text: string) => void;
  /** The schedule or the observations changed. */
  changed: () => void;
  agentFolders: () => AgentFolder[];
  now?: () => number;
  rules?: Partial<ScheduleRules>;
}

function toResource(row: ResourceRow): Resource {
  const resource: Resource = {
    id: row.id,
    kind: row.kind as ResourceKind,
    host: row.host,
    label: row.label,
    capacity: row.capacity,
    unit: row.unit,
    source: row.source === "probe" ? "probe" : "manual",
  };
  if (row.uuid) resource.uuid = row.uuid;
  if (row.model) resource.model = row.model;
  return resource;
}

/** GPU resource id from its host and UUID: "bariton/gpu/GPU-bee4b5d4". */
export function gpuResourceId(host: string, uuid: string): string {
  return `${host}/gpu/${uuid.slice(0, 12)}`;
}

function shortHost(host: string): string {
  return host.split(".")[0]?.toLowerCase() ?? host.toLowerCase();
}

function hours(ms: number): string {
  const h = ms / HOUR;
  return h >= 1 ? `${Number(h.toFixed(1))} h` : `${Math.round(ms / MIN)} min`;
}

/** An amount as people say it: GB for GPU memory (booked in MiB), else in the resource's unit. */
function amountText(amount: number, unit: string): string {
  return unit === "MiB" ? `${(amount / 1024).toFixed(amount >= 10 * 1024 ? 0 : 1)} GB` : `${amount} ${unit}`;
}

export class ResourceSchedule {
  readonly rules: ScheduleRules;
  private readonly now: () => number;

  constructor(
    private readonly db: Database,
    private readonly options: ScheduleOptions
  ) {
    this.db.exec(SCHEMA);
    // Schedules created before shared/private (10 Nov) lack the column: their holds are shared.
    const columns = this.db.query<{ name: string }, []>("PRAGMA table_info(reservations)").all();
    if (!columns.some((c) => c.name === "private")) this.db.exec("ALTER TABLE reservations ADD COLUMN private INTEGER NOT NULL DEFAULT 0");
    this.now = options.now ?? Date.now;
    this.rules = { ...DEFAULT_RULES, ...options.rules };
  }

  // ---- Reading ----

  private resourceRows(): ResourceRow[] {
    return this.db.query<ResourceRow, []>("SELECT * FROM resources ORDER BY host, label").all();
  }

  private getResource(id: string): Resource | undefined {
    const row = this.db.query<ResourceRow, [string]>("SELECT * FROM resources WHERE id = ?1").get(id);
    return row ? toResource(row) : undefined;
  }

  /**
   * Finds a resource by id, GPU UUID (or its start, with or without "GPU-"), label ("bariton GPU 2") or
   * "<host> gpu <index>". Throws with the candidates when none or several match.
   */
  resolve(query: string): Resource {
    const q = query.trim().toLowerCase();
    const all = this.resourceRows().map(toResource);
    const exact = all.find((r) => r.id.toLowerCase() === q);
    if (exact) return exact;
    const bare = q.replace(/^gpu-/, "");
    const matches = all.filter(
      (r) =>
        r.label.toLowerCase() === q ||
        (r.uuid && bare.length >= 4 && r.uuid.toLowerCase().replace(/^gpu-/, "").startsWith(bare)) ||
        r.id.toLowerCase().endsWith(`/${q}`)
    );
    if (matches.length === 1 && matches[0]) return matches[0];
    const list = (matches.length > 1 ? matches : all).map((r) => `${r.label} (${r.id})`).join("; ");
    throw new ScheduleError(
      matches.length > 1 ? 409 : 404,
      `${matches.length > 1 ? "Several resources match" : "No resource matches"} "${query}". ${matches.length > 1 ? "Candidates" : "Resources"}: ${list || "none yet"}.`
    );
  }

  private stateOf(row: ReservationRow, now: number): ReservationState {
    if (row.ended_at !== null) return (row.end_reason as ReservationState | null) ?? "released";
    if (row.start_at === null || row.end_at === null) return "queued";
    if (now < row.start_at) return "planned";
    if (now < row.end_at) return "active";
    return "overdue";
  }

  private toReservation(row: ReservationRow, now: number): Reservation {
    const reservation: Reservation = {
      id: row.id,
      resourceId: row.resource_id,
      holder: row.holder,
      durationMs: row.duration_ms,
      purpose: row.purpose,
      createdBy: row.created_by,
      createdAt: row.created_at,
      state: this.stateOf(row, now),
    };
    if (row.amount !== null) reservation.amount = row.amount;
    if (row.start_at !== null) reservation.start = row.start_at;
    if (row.end_at !== null) reservation.end = row.end_at;
    if (row.approved_by) reservation.approvedBy = row.approved_by;
    if (row.private) reservation.private = true;
    if (row.idle_since !== null) reservation.idleSince = row.idle_since;
    if (row.last_used_at !== null) reservation.lastUsedAt = row.last_used_at;
    if (row.ended_at !== null) reservation.endedAt = row.ended_at;
    return reservation;
  }

  private openRows(resourceId?: string): ReservationRow[] {
    return resourceId === undefined
      ? this.db.query<ReservationRow, []>("SELECT * FROM reservations WHERE ended_at IS NULL ORDER BY created_at").all()
      : this.db
          .query<ReservationRow, [string]>("SELECT * FROM reservations WHERE ended_at IS NULL AND resource_id = ?1 ORDER BY created_at")
          .all(resourceId);
  }

  private getRow(id: string): ReservationRow {
    const row = this.db.query<ReservationRow, [string]>("SELECT * FROM reservations WHERE id = ?1").get(id);
    if (!row) throw new ScheduleError(404, `Unknown reservation ${id}`);
    return row;
  }

  /** Latest observation per resource (each host's last probe report; staleness is judged by the callers). */
  private observed(): Map<string, ObservedGpu & { at: number }> {
    const out = new Map<string, ObservedGpu & { at: number }>();
    for (const row of this.db.query<{ at: number; observed_json: string }, []>("SELECT at, observed_json FROM observations").all()) {
      for (const gpu of JSON.parse(row.observed_json) as ObservedGpu[]) out.set(gpu.resourceId, { ...gpu, at: row.at });
    }
    return out;
  }

  listing(): ResourcesResponse {
    const now = this.now();
    const resources = this.resourceRows().map(toResource);
    const rows = this.db
      .query<ReservationRow, [number]>("SELECT * FROM reservations WHERE ended_at IS NULL OR ended_at >= ?1 ORDER BY COALESCE(start_at, created_at)")
      .all(now - LIST_ENDED_MS);
    const reservations = rows.map((row) => this.toReservation(row, now));
    const observed = this.observed();
    const warnings: ResourceWarning[] = [];
    const labelOf = new Map(resources.map((r) => [r.id, r.label]));
    for (const r of reservations) {
      const label = labelOf.get(r.resourceId) ?? r.resourceId;
      if (r.state === "overdue") {
        warnings.push({ kind: "overdue", resourceId: r.resourceId, reservationId: r.id, agentId: r.holder, text: `@${r.holder}'s hold on ${label} ended at ${formatUtc(r.end ?? now)} and is not released` });
      }
      if (r.state === "active" && r.idleSince !== undefined) {
        warnings.push({ kind: "idle", resourceId: r.resourceId, reservationId: r.id, agentId: r.holder, text: `@${r.holder} holds ${label} but nothing of theirs has run on it for ${hours(now - r.idleSince + this.rules.idleAfterMs)}` });
      }
    }
    for (const row of rows) {
      if (row.forced && row.ended_at === null) {
        warnings.push({ kind: "conflict", resourceId: row.resource_id, reservationId: row.id, agentId: row.holder, text: `@${row.holder}'s reservation of ${labelOf.get(row.resource_id) ?? row.resource_id} was booked over capacity` });
      }
    }
    for (const [resourceId, gpu] of observed) {
      const label = labelOf.get(resourceId) ?? resourceId;
      if (now - gpu.at > OBSERVATION_FRESH_MS) {
        warnings.push({ kind: "stale-probe", resourceId, text: `gpudash has not reported ${label} since ${formatUtc(gpu.at)}` });
        continue;
      }
      const holders = new Set(reservations.filter((r) => r.resourceId === resourceId && (r.state === "active" || r.state === "overdue")).map((r) => r.holder));
      const active = new Set(reservations.filter((r) => r.resourceId === resourceId && (r.state === "active" || r.state === "overdue")).map((r) => r.id));
      for (const p of gpu.processes) {
        if (p.memory < USE_MIN_MIB) continue;
        if (p.reservationId && active.has(p.reservationId)) continue;
        if (p.agentId && holders.has(p.agentId)) continue;
        const who = p.agentId ? `@${p.agentId}'s ` : "";
        warnings.push({
          kind: "unclaimed",
          resourceId,
          ...(p.agentId ? { agentId: p.agentId } : {}),
          text: `${who}${p.container ? `container ${p.container}` : `pid ${p.pid} (${p.command.slice(0, 60)})`} uses ${Math.round(p.memory / 1024)} GB on ${label} without a booking`,
        });
      }
    }
    return { now, resources, reservations, observed: Object.fromEntries(observed), warnings, rules: this.rules };
  }

  // ---- Capacity ----

  /** The interval a not-ended reservation occupies: overdue ones keep it until their grace runs out. */
  private occupies(row: ReservationRow, now: number): [number, number] | undefined {
    if (row.ended_at !== null || row.start_at === null || row.end_at === null) return undefined;
    const end = row.end_at <= now ? Math.max(now, row.end_at + this.rules.overdueGraceMs) : row.end_at;
    return [row.start_at, end];
  }

  /** The largest load on `resource` within [start, end) from reservations other than `except`. */
  private peakLoad(resource: Resource, start: number, end: number, except?: string): { load: number; holders: ReservationRow[] } {
    const now = this.now();
    const overlapping = this.openRows(resource.id).filter((row) => {
      if (row.id === except) return false;
      const span = this.occupies(row, now);
      return span !== undefined && span[0] < end && span[1] > start;
    });
    let peak = 0;
    const points = [start, ...overlapping.map((row) => this.occupies(row, now)?.[0] ?? start).filter((t) => t > start && t < end)];
    for (const t of points) {
      let load = 0;
      for (const row of overlapping) {
        const span = this.occupies(row, now);
        if (span && span[0] <= t && span[1] > t) load += row.amount ?? resource.capacity;
      }
      peak = Math.max(peak, load);
    }
    return { load: peak, holders: overlapping };
  }

  private fits(resource: Resource, start: number, end: number, amount: number, except?: string): boolean {
    return this.peakLoad(resource, start, end, except).load + amount <= resource.capacity;
  }

  /** The first moment from now when `amount` fits for `duration`. */
  private nextFree(resource: Resource, amount: number, duration: number): number {
    const now = this.now();
    const candidates = [now, ...this.openRows(resource.id).map((row) => this.occupies(row, now)?.[1]).filter((t): t is number => t !== undefined && t > now)].sort((a, b) => a - b);
    for (const t of candidates) if (this.fits(resource, t, t + duration, amount)) return t;
    return candidates.at(-1) ?? now;
  }

  // ---- Changing ----

  /** Registers (or updates) a service or account by hand. */
  register(input: { kind: ResourceKind; host: string; name: string; label?: string; capacity?: number; unit?: string }): Resource {
    const now = this.now();
    const host = shortHost(input.host);
    const name = input.name.trim().replace(/\s+/g, "-");
    if (!name) throw new ScheduleError(400, "name is required");
    if (input.kind === "gpu") throw new ScheduleError(400, "GPUs are registered from gpudash's observations (agent-bus serve --gpudash)");
    const id = `${host}/${input.kind}/${name}`;
    this.db
      .query(
        `INSERT INTO resources (id, kind, host, label, capacity, unit, source, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'manual', ?7, ?7)
         ON CONFLICT(id) DO UPDATE SET label = ?4, capacity = ?5, unit = ?6, updated_at = ?7`
      )
      .run(id, input.kind, host, input.label?.trim() || `${host} ${name}`, input.capacity ?? 1, input.unit ?? "slot", now);
    this.options.changed();
    return this.getResource(id) as Resource;
  }

  reserve(input: ReserveRequest, actor: Actor): Reservation {
    const now = this.now();
    const resource = this.resolve(input.resource);
    const purpose = input.purpose?.trim();
    if (!purpose) throw new ScheduleError(400, "purpose is required (one line: what it is for)");
    const amount = input.amount ?? resource.capacity;
    if (!Number.isFinite(amount) || amount <= 0 || amount > resource.capacity) {
      throw new ScheduleError(400, `amount must be more than 0 and at most ${amountText(resource.capacity, resource.unit)}`);
    }
    const queued = input.start === "next";
    const start = queued ? now : typeof input.start === "number" ? input.start : now;
    if (!queued && start < now - MIN) throw new ScheduleError(400, "start is in the past");
    const duration = input.hours !== undefined ? input.hours * HOUR : input.end !== undefined ? input.end - start : NaN;
    if (!Number.isFinite(duration) || duration <= 0) throw new ScheduleError(400, "give hours (or end)");
    if (duration > this.rules.maxHoldMs) {
      throw new ScheduleError(400, `a reservation lasts at most ${hours(this.rules.maxHoldMs)}; extend it while you use it`);
    }
    const mine = this.openRows(resource.id).filter((row) => row.holder === actor.id);
    if ((queued || start > now) && mine.some((row) => this.stateOf(row, now) === "planned" || this.stateOf(row, now) === "queued")) {
      throw new ScheduleError(409, `@${actor.id} already has a planned or queued reservation of ${resource.label}`);
    }
    const whole = input.amount === undefined;
    const fitsNow = this.fits(resource, start, start + duration, amount);
    let forced = false;
    if (!queued && !fitsNow) {
      if (input.force && actor.kind === "human") forced = true;
      else throw new ScheduleError(409, this.busyText(resource, start, duration, amount));
    }
    const id = `r_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const startAt = queued && !fitsNow ? null : start;
    this.db
      .query(
        `INSERT INTO reservations (id, resource_id, holder, amount, start_at, end_at, duration_ms, purpose, created_by, created_at, forced, private)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`
      )
      .run(id, resource.id, actor.id, whole ? null : amount, startAt, startAt === null ? null : startAt + duration, duration, purpose.slice(0, 200), actor.id, now, forced ? 1 : 0, input.private ? 1 : 0);
    this.options.changed();
    return this.toReservation(this.getRow(id), now);
  }

  /** Why a reservation does not fit: who holds the resource, until when, and when it is next free. */
  private busyText(resource: Resource, start: number, duration: number, amount: number): string {
    const now = this.now();
    const { holders } = this.peakLoad(resource, start, start + duration);
    const who = holders
      .map((row) => `@${row.holder} (${row.id}, ${row.amount === null ? "all of it" : amountText(row.amount, resource.unit)}, until ${formatUtc(row.end_at ?? now)}: ${row.purpose})`)
      .join("; ");
    return `${resource.label} is taken then by ${who}. It is next free for this at ${formatUtc(this.nextFree(resource, amount, duration))}; book that start, or use start "next" to queue.`;
  }

  release(id: string, actor: Actor): Reservation {
    const now = this.now();
    const row = this.getRow(id);
    if (row.ended_at !== null) throw new ScheduleError(409, `${id} is already over (${row.end_reason})`);
    if (row.holder !== actor.id && actor.kind !== "human") throw new ScheduleError(403, `${id} is @${row.holder}'s; only they or a human can release it`);
    const state = this.stateOf(row, now);
    const reason = state === "planned" || state === "queued" ? "cancelled" : "released";
    this.db.query("UPDATE reservations SET ended_at = ?2, end_reason = ?3 WHERE id = ?1").run(id, now, reason);
    if (row.holder !== actor.id) {
      this.options.notify(row.holder, `@${actor.id} ${reason} your reservation ${id} of ${this.getResource(row.resource_id)?.label ?? row.resource_id}.`);
    }
    this.startQueued(row.resource_id);
    this.options.changed();
    return this.toReservation(this.getRow(id), now);
  }

  /** Releases the actor's current hold on a resource (the tool's `release` with `resource`). */
  releaseOn(resourceQuery: string, actor: Actor): Reservation {
    const now = this.now();
    const resource = this.resolve(resourceQuery);
    const row = this.openRows(resource.id).find((r) => r.holder === actor.id && ["active", "overdue"].includes(this.stateOf(r, now)));
    const any = row ?? this.openRows(resource.id).find((r) => r.holder === actor.id);
    if (!any) throw new ScheduleError(404, `@${actor.id} holds nothing on ${resource.label}`);
    return this.release(any.id, actor);
  }

  /** Shared (anyone may send requests to what runs on it) or private; the holder's call, or a human's. */
  setPrivate(id: string, isPrivate: boolean, actor: Actor): Reservation {
    const row = this.getRow(id);
    if (row.ended_at !== null) throw new ScheduleError(409, `${id} is already over (${row.end_reason})`);
    if (row.holder !== actor.id && actor.kind !== "human") throw new ScheduleError(403, `${id} is @${row.holder}'s`);
    this.db.query("UPDATE reservations SET private = ?2 WHERE id = ?1").run(id, isPrivate ? 1 : 0);
    this.options.changed();
    return this.toReservation(this.getRow(id), this.now());
  }

  extend(id: string, hoursMore: number, actor: Actor): Reservation {
    const now = this.now();
    const row = this.getRow(id);
    if (row.ended_at !== null) throw new ScheduleError(409, `${id} is already over (${row.end_reason})`);
    if (row.holder !== actor.id && actor.kind !== "human") throw new ScheduleError(403, `${id} is @${row.holder}'s`);
    if (row.end_at === null || row.start_at === null) throw new ScheduleError(409, `${id} is queued; it has no end to extend yet`);
    const more = hoursMore * HOUR;
    if (!Number.isFinite(more) || more <= 0 || more > this.rules.maxHoldMs) {
      throw new ScheduleError(400, `hours must be more than 0 and at most ${this.rules.maxHoldMs / HOUR}`);
    }
    if (row.idle_since !== null && actor.kind !== "human") {
      throw new ScheduleError(409, `Nothing of yours has run on it since ${formatUtc(row.last_used_at ?? row.start_at)}; release it, or start using it before extending`);
    }
    const resource = this.getResource(row.resource_id) as Resource;
    const newEnd = Math.max(row.end_at, now) + more;
    if (newEnd - Math.max(row.start_at, now) > this.rules.maxHoldMs) {
      throw new ScheduleError(400, `that would hold it for more than ${hours(this.rules.maxHoldMs)} from now; extend later`);
    }
    if (!this.fits(resource, row.end_at, newEnd, row.amount ?? resource.capacity, id)) {
      throw new ScheduleError(409, this.busyText(resource, row.end_at, newEnd - row.end_at, row.amount ?? resource.capacity));
    }
    this.db.query("UPDATE reservations SET end_at = ?2, overdue_noticed = 0 WHERE id = ?1").run(id, newEnd);
    this.options.changed();
    return this.toReservation(this.getRow(id), now);
  }

  /** Starts queued reservations of a resource (oldest first) while they fit. */
  private startQueued(resourceId: string): void {
    const now = this.now();
    const resource = this.getResource(resourceId);
    if (!resource) return;
    for (const row of this.openRows(resourceId).filter((r) => r.start_at === null)) {
      if (!this.fits(resource, now, now + row.duration_ms, row.amount ?? resource.capacity, row.id)) continue;
      this.db.query("UPDATE reservations SET start_at = ?2, end_at = ?3 WHERE id = ?1").run(row.id, now, now + row.duration_ms);
      this.options.notify(row.holder, `${resource.label} is yours now: your queued reservation ${row.id} (${row.purpose}) runs until ${formatUtc(now + row.duration_ms)}.`);
    }
  }

  // ---- Observations ----

  /** A probe's report: registers its GPUs, attributes processes, and records who is using what. */
  observe(obs: Observation): void {
    const now = this.now();
    const host = shortHost(obs.host);
    const folders = this.options.agentFolders().filter((f) => shortHost(f.host) === host);
    const open = new Map(this.openRows().map((row) => [row.id, row]));
    const gpus: ObservedGpu[] = [];
    for (const gpu of obs.gpus) {
      const id = gpuResourceId(host, gpu.uuid);
      // GPUs that report no memory size (GB10: unified memory) are booked whole: capacity 1 "gpu".
      const sized = gpu.memoryTotal > 0;
      this.db
        .query(
          `INSERT INTO resources (id, kind, host, label, capacity, unit, source, uuid, model, created_at, updated_at)
           VALUES (?1, 'gpu', ?2, ?3, ?4, ?5, 'probe', ?6, ?7, ?8, ?8)
           ON CONFLICT(id) DO UPDATE SET label = ?3, capacity = ?4, unit = ?5, model = ?7, updated_at = ?8`
        )
        .run(id, host, `${host} GPU ${gpu.index}`, sized ? gpu.memoryTotal : 1, sized ? "MiB" : "gpu", gpu.uuid, gpu.model, now);
      const processes: ObservedProcess[] = obs.processes
        .filter((p) => p.gpuUuid === gpu.uuid)
        .map((p) => {
          // agent-bus run sets AGENT_BUS_RESERVATION to one id, or several (comma-separated) when a job holds several GPUs.
          const named = (p.reservationEnv || p.containerLabels?.["agent-bus.reservation"] || "").split(",").map((s) => s.trim()).filter(Boolean);
          const reservationId = named.find((r) => open.get(r)?.resource_id === id) ?? named[0];
          const process: ObservedProcess = { pid: p.pid, memory: p.memory, command: p.command.slice(0, 300) };
          if (p.model) process.model = p.model;
          if (p.engine) process.engine = p.engine;
          if (p.endpoints?.length) process.endpoints = p.endpoints;
          // Containers run in their own root: their folder is the compose project's, when they come from one.
          const cwd = p.cwd || p.containerLabels?.["com.docker.compose.project.working_dir"];
          if (cwd) process.cwd = cwd;
          if (p.container) process.container = p.container;
          if (reservationId) process.reservationId = reservationId;
          const byReservation = reservationId ? open.get(reservationId)?.holder : undefined;
          const byLabel = p.containerLabels?.["agent-bus.agent"];
          const byFolder = cwd ? folders.find((f) => cwd === f.path || cwd.startsWith(`${f.path}/`))?.id : undefined;
          const agentId = byReservation ?? byLabel ?? byFolder;
          if (agentId) process.agentId = agentId;
          return process;
        });
      // A GPU booked whole by exactly one holder: its unlabeled processes are presumed theirs (servers started
      // before the rule, containers without a label), so the hold is not called idle and the use not unclaimed.
      const whole = [...open.values()].filter(
        (row) => row.resource_id === id && row.amount === null && row.start_at !== null && row.start_at <= now
      );
      if (whole.length === 1) {
        for (const p of processes) {
          if (p.reservationId || p.agentId) continue;
          p.agentId = whole[0]?.holder;
          p.assumed = true;
        }
      }
      gpus.push({ resourceId: id, memoryUsed: gpu.memoryUsed, utilization: gpu.utilization, processes });
      // Who is using it: a reservation named by its processes, or a holder whose folder they run in.
      for (const row of open.values()) {
        if (row.resource_id !== id || row.start_at === null || row.start_at > now) continue;
        const used = processes.some((p) => p.memory >= USE_MIN_MIB && (p.reservationId === row.id || (!p.reservationId && p.agentId === row.holder)));
        if (used) this.db.query("UPDATE reservations SET last_used_at = ?2, idle_since = NULL, idle_noticed = 0 WHERE id = ?1").run(row.id, now);
      }
    }
    this.db
      .query("INSERT INTO observations (host, at, observed_json) VALUES (?1, ?2, ?3) ON CONFLICT(host) DO UPDATE SET at = ?2, observed_json = ?3")
      .run(host, now, JSON.stringify(gpus));
    this.options.changed();
  }

  // ---- Time-driven rules ----

  /** Applies the time rules: queue starts, overdue notices and expiry, idle flags and reclaim. Run every ~30 s. */
  tick(): void {
    const now = this.now();
    let changed = false;
    const observedAt = new Map(this.db.query<{ host: string; at: number }, []>("SELECT host, at FROM observations").all().map((o) => [o.host, o.at]));
    for (const resourceId of new Set(this.openRows().map((r) => r.resource_id))) {
      const before = this.openRows(resourceId).filter((r) => r.start_at === null).length;
      this.startQueued(resourceId);
      if (this.openRows(resourceId).filter((r) => r.start_at === null).length !== before) changed = true;
    }
    for (const row of this.openRows()) {
      const resource = this.getResource(row.resource_id);
      if (!resource || row.start_at === null || row.end_at === null) continue;
      const state = this.stateOf(row, now);
      if (state === "overdue") {
        if (now >= row.end_at + this.rules.overdueGraceMs) {
          this.end(row, "expired", now);
          this.options.notify(row.holder, `Your reservation ${row.id} of ${resource.label} expired: it ended at ${formatUtc(row.end_at)} and was not released or extended within ${hours(this.rules.overdueGraceMs)}.`);
          this.startQueued(row.resource_id);
          changed = true;
        } else if (!row.overdue_noticed) {
          this.db.query("UPDATE reservations SET overdue_noticed = 1 WHERE id = ?1").run(row.id);
          this.options.notify(row.holder, `Your reservation ${row.id} of ${resource.label} (${row.purpose}) ended at ${formatUtc(row.end_at)}. Release it when you are done, or extend it; it expires at ${formatUtc(row.end_at + this.rules.overdueGraceMs)}.`);
          changed = true;
        }
        continue;
      }
      if (state !== "active" || resource.kind !== "gpu") continue;
      const seen = observedAt.get(resource.host);
      if (seen === undefined || now - seen > OBSERVATION_FRESH_MS) continue; // not observed now: no idle verdicts
      const lastUse = Math.max(row.last_used_at ?? row.start_at, row.start_at);
      if (now - lastUse < this.rules.idleAfterMs) continue;
      if (row.idle_since === null) {
        this.db.query("UPDATE reservations SET idle_since = ?2 WHERE id = ?1").run(row.id, lastUse + this.rules.idleAfterMs);
        changed = true;
      }
      const waiting = this.openRows(row.resource_id).some((r) => r.id !== row.id && (r.start_at === null || (r.start_at > now && r.start_at - now < HOUR)));
      if (now - lastUse >= this.rules.reclaimAfterMs && waiting) {
        this.end(row, "reclaimed", now);
        this.options.notify(row.holder, `Your reservation ${row.id} of ${resource.label} was reclaimed: nothing of yours ran on it since ${formatUtc(lastUse)} and someone is waiting for it.`);
        this.startQueued(row.resource_id);
        changed = true;
      } else if (!row.idle_noticed) {
        this.db.query("UPDATE reservations SET idle_noticed = 1 WHERE id = ?1").run(row.id);
        this.options.notify(row.holder, `You hold ${resource.label} (${row.id}, ${row.purpose}) but nothing of yours has run on it since ${formatUtc(lastUse)}. Release it if you are done${waiting ? "; someone is waiting, so it will be reclaimed if it stays idle" : ""}.`);
        changed = true;
      }
    }
    if (changed) this.options.changed();
  }

  private end(row: ReservationRow, reason: "expired" | "reclaimed", now: number): void {
    this.db.query("UPDATE reservations SET ended_at = ?2, end_reason = ?3 WHERE id = ?1").run(row.id, now, reason);
  }
}
