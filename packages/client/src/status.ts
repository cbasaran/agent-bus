// What an agent is doing, for the bus (website, GET /api/state): idle or busy and since when, the running tool (the
// oldest when several run) and its latest activity line. A WebSocket frame only: no model turn, nothing injected.
// Each harness binding decides which of its events mean busy, idle and a tool starting or ending.
import type { AgentStatus } from "../../protocol/src/types";
import type { BusConnection } from "./connection";

/** Status reports are coalesced into one per this window (a batch of tool calls sends one report). */
const STATUS_COALESCE_MS = 250;

export class StatusTracker {
  private busyNow = false;
  private since = Date.now();
  private readonly runningTools = new Map<string, { name: string; since: number }>();
  private activity: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private conn: Pick<BusConnection, "reportStatus"> | undefined;

  constructor(private readonly log: (line: string) => void) {}

  get busy(): boolean {
    return this.busyNow;
  }

  /** Reports to `conn` from now on, starting with the current status (stored by the connection, sent after every join). */
  attach(conn: Pick<BusConnection, "reportStatus">): void {
    this.conn = conn;
    this.publish();
  }

  /** Stops reporting (the session ended); changes until the next `attach` only update the state. */
  detach(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.conn = undefined;
  }

  setBusy(): void {
    if (this.busyNow) return;
    this.busyNow = true;
    this.since = Date.now();
    this.changed();
  }

  /** The turn ended: idle, no running tool, no activity. */
  setIdle(): void {
    this.busyNow = false;
    this.since = Date.now();
    this.runningTools.clear();
    this.activity = undefined;
    this.changed();
  }

  /** `activity` (what the agent says it is doing) replaces the activity line when it is a non-empty string. */
  toolStarted(id: string, name: string, activity?: unknown): void {
    this.runningTools.set(id, { name, since: Date.now() });
    if (typeof activity === "string" && activity.trim()) this.activity = activity.trim();
    this.changed();
  }

  toolEnded(id: string): void {
    this.runningTools.delete(id);
    this.changed();
  }

  /** Coalesces bursts (a batch of tool calls) into one report a moment later. */
  private changed(): void {
    if (!this.conn || this.timer) return;
    this.timer = setTimeout(() => this.publish(), STATUS_COALESCE_MS);
  }

  private publish(): void {
    this.timer = undefined;
    const conn = this.conn;
    if (!conn) return;
    const status: AgentStatus = { state: this.busyNow ? "busy" : "idle", since: this.since };
    const oldest = [...this.runningTools.values()].sort((a, b) => a.since - b.since)[0];
    if (this.busyNow && oldest) {
      status.tool = oldest.name;
      status.toolSince = oldest.since;
    }
    if (this.busyNow && this.activity) status.activity = this.activity;
    try {
      conn.reportStatus(status);
    } catch (err) {
      this.log(`status report failed: ${(err as Error).message}`);
    }
  }
}
