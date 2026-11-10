// Resource schedule (experimental): who holds a shared resource (a GPU, a service, an account) now and who has
// booked it next, beside what probes observe actually running. See docs/design/resources-and-auth.md, part A.

/** The built-in participant that writes the schedule's notices (overdue, idle, handoff) to holders. */
export const RESOURCES_AGENT_ID = "resources";

export type ResourceKind = "gpu" | "service" | "account";

/** Something that can be held. GPUs are registered by probes, services and accounts by hand. */
export interface Resource {
  /** "<host>/<kind>/<name>", e.g. "bariton/gpu/GPU-bee4b5d4" (GPUs by UUID prefix: indexes change on reboot). */
  id: string;
  kind: ResourceKind;
  host: string;
  /** For people, e.g. "bariton GPU 2" (the current index). */
  label: string;
  /** How much there is: GPU memory in MiB; services: concurrent slots; accounts: 1. */
  capacity: number;
  unit: string;
  source: "probe" | "manual";
  /** GPUs: the full UUID (for CUDA_VISIBLE_DEVICES and docker --gpus). */
  uuid?: string;
  /** GPUs: the model name. */
  model?: string;
}

/**
 * planned: starts later. queued: starts as soon as there is room. active: holding now. overdue: past its end, not
 * released (grace). released / expired (grace passed) / reclaimed (idle while someone waited) / cancelled: over.
 */
export type ReservationState = "planned" | "queued" | "active" | "overdue" | "released" | "expired" | "reclaimed" | "cancelled";

export interface Reservation {
  id: string;
  resourceId: string;
  /** Agent or human id. */
  holder: string;
  /** In the resource's unit; absent = the whole resource. */
  amount?: number;
  /** Absent while queued. */
  start?: number;
  /** Absent while queued (then `durationMs` applies from the start). */
  end?: number;
  durationMs: number;
  purpose: string;
  createdBy: string;
  createdAt: number;
  approvedBy?: string;
  state: ReservationState;
  /** Active and no process of the holder seen on the resource for a while (only for observed resources). */
  idleSince?: number;
  /** Last time a probe saw the holder's process on the resource. */
  lastUsedAt?: number;
  endedAt?: number;
}

/** A process a probe saw on a GPU, and whom it is attributed to. */
export interface ObservedProcess {
  pid: number;
  /** GPU memory in MiB. */
  memory: number;
  command: string;
  cwd?: string;
  container?: string;
  /** From AGENT_BUS_RESERVATION or the container label agent-bus.reservation. */
  reservationId?: string;
  /** The agent whose project folder the process runs in (or the reservation's holder). */
  agentId?: string;
  /** agentId is presumed: the process carries no label, and its GPU is booked whole by that one holder. */
  assumed?: boolean;
}

export interface ObservedGpu {
  resourceId: string;
  /** MiB. */
  memoryUsed: number;
  /** Percent. */
  utilization: number;
  processes: ObservedProcess[];
}

/** A probe's report for one host (POST /api/observations). */
export interface Observation {
  host: string;
  at: number;
  gpus: Array<{
    uuid: string;
    index: number;
    model: string;
    memoryTotal: number;
    memoryUsed: number;
    utilization: number;
  }>;
  processes: Array<{
    gpuUuid: string;
    pid: number;
    memory: number;
    command: string;
    cwd?: string;
    container?: string;
    containerLabels?: Record<string, string>;
    reservationEnv?: string;
  }>;
}

/** Something the website should point out. */
export interface ResourceWarning {
  kind: "unclaimed" | "idle" | "overdue" | "conflict" | "stale-probe";
  resourceId: string;
  text: string;
  reservationId?: string;
  agentId?: string;
}

/** GET /api/resources */
export interface ResourcesResponse {
  now: number;
  resources: Resource[];
  /** Not over, plus those that ended in the last 24 h. */
  reservations: Reservation[];
  /** Latest observation per resource (GPUs on hosts with a probe). */
  observed: Record<string, ObservedGpu & { at: number }>;
  warnings: ResourceWarning[];
  rules: ScheduleRules;
}

/** The anti-greed rules in force (all in ms). */
export interface ScheduleRules {
  maxHoldMs: number;
  maxAheadMs: number;
  overdueGraceMs: number;
  idleAfterMs: number;
  reclaimAfterMs: number;
}

/** POST /api/reservations */
export interface ReserveRequest {
  from: string;
  resource: string;
  /** Hours from the start (or give `end`). */
  hours?: number;
  end?: number;
  /** A time (ms), or "next" to queue for the first free moment; default now. */
  start?: number | "next";
  amount?: number;
  purpose: string;
  /** Humans: book even when it does not fit (recorded as a conflict). */
  force?: boolean;
}

export interface ReservationResponse {
  reservation: Reservation;
  resource: Resource;
}
