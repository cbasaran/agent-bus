// The resource schedule as the server runs it (experimental; docs/design/resources-and-auth.md part A): wired to the
// bus (notices from @resources, `resources` frames, agent folders), fed from gpudash every 30 s, and its HTTP routes.
import type { Observation, ReserveRequest } from "@agent-bus/protocol";
import type { BusContext } from "./context";
import { HttpError, json, readJsonObject } from "./http";
import { postResourcesNotice } from "./messages";
import { ResourceSchedule, type Actor } from "./resources";

export class ScheduleService {
  private readonly schedule: ResourceSchedule;
  private readonly gpudash: string | undefined;
  private observing = false;
  private readonly timer: Timer;

  constructor(
    private readonly ctx: BusContext,
    gpudash: string | undefined
  ) {
    const { db } = ctx;
    this.schedule = new ResourceSchedule(db.db, {
      notify: (holder, text) => postResourcesNotice(ctx, holder, text),
      changed: () => ctx.hub.resourcesChanged(),
      agentFolders: () =>
        db
          .listAgents()
          .filter((a) => a.host !== null && a.path !== null)
          .map((a) => ({ id: a.id, host: a.host as string, path: a.path as string })),
    });
    this.gpudash = gpudash?.replace(/\/+$/, "");
    void this.observeAndTick();
    this.timer = setInterval(() => void this.observeAndTick(), 30_000);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** Every 30 s: what gpudash sees running, then the rules (overdue, expiry, idle, reclaim, queue handover). */
  private async observeAndTick(): Promise<void> {
    if (this.observing) return;
    this.observing = true;
    try {
      if (this.gpudash) {
        try {
          const res = await fetch(`${this.gpudash}/api/observations`, { signal: AbortSignal.timeout(10_000) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          for (const observation of (await res.json()) as Observation[]) this.schedule.observe(observation);
        } catch (error) {
          // The schedule keeps its last view; it flags stale probes after a few minutes.
          console.error(`gpudash ${this.gpudash} unreachable: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      this.schedule.tick();
    } catch (error) {
      console.error("resource schedule tick failed:", error);
    } finally {
      this.observing = false;
    }
  }

  /** The writer of a schedule request. Humans who are not signed in (when auth is on) act without human powers. */
  private actorOf(req: Request, body: Record<string, unknown>): Actor {
    if (typeof body.from !== "string") throw new HttpError(400, "from must be a participant id");
    const writer = this.ctx.hub.knownParticipant(body.from.trim().toLowerCase());
    if (!writer) throw new HttpError(400, `Unknown participant "${body.from}"`);
    const verified = this.ctx.checkWriter(req, writer);
    return { id: writer.id, kind: writer.kind === "human" && verified === false ? "agent" : writer.kind };
  }

  /** /api/resources, /api/reservations… and /api/observations; undefined for any other request. */
  async handle(req: Request, url: URL): Promise<Response | undefined> {
    const { pathname } = url;
    const method = req.method;
    const schedule = this.schedule;
    if (method === "GET" && pathname === "/api/resources") return json(schedule.listing());
    if (method === "POST" && pathname === "/api/resources") {
      const body = await readJsonObject(req);
      this.actorOf(req, body);
      const { kind, host, name, label, capacity, unit } = body;
      if ((kind !== "service" && kind !== "account") || typeof host !== "string" || typeof name !== "string") {
        throw new HttpError(400, 'Give kind ("service" or "account"), host and name');
      }
      return json({
        resource: schedule.register({
          kind,
          host,
          name,
          ...(typeof label === "string" ? { label } : {}),
          ...(typeof capacity === "number" ? { capacity } : {}),
          ...(typeof unit === "string" ? { unit } : {}),
        }),
      });
    }
    if (method === "POST" && pathname === "/api/reservations") {
      const body = await readJsonObject(req);
      const actor = this.actorOf(req, body);
      const reservation = schedule.reserve(body as unknown as ReserveRequest, actor);
      return json({ reservation, resource: schedule.resolve(reservation.resourceId) });
    }
    const reservationMatch = /^\/api\/reservations\/([^/]+)\/(release|extend|mode)$/.exec(pathname);
    if (method === "POST" && reservationMatch?.[1]) {
      const body = await readJsonObject(req);
      const actor = this.actorOf(req, body);
      const id = decodeURIComponent(reservationMatch[1]);
      if (reservationMatch[2] === "release") {
        const reservation =
          id === "current" && typeof body.resource === "string" ? schedule.releaseOn(body.resource, actor) : schedule.release(id, actor);
        return json({ reservation, resource: schedule.resolve(reservation.resourceId) });
      }
      if (reservationMatch[2] === "mode") {
        if (body.mode !== "shared" && body.mode !== "private") throw new HttpError(400, 'mode must be "shared" or "private"');
        const reservation = schedule.setPrivate(id, body.mode === "private", actor);
        return json({ reservation, resource: schedule.resolve(reservation.resourceId) });
      }
      if (typeof body.hours !== "number") throw new HttpError(400, "hours must be a number");
      const reservation = schedule.extend(id, body.hours, actor);
      return json({ reservation, resource: schedule.resolve(reservation.resourceId) });
    }
    if (method === "POST" && pathname === "/api/observations") {
      const body = await readJsonObject(req);
      if (typeof body.host !== "string" || !Array.isArray(body.gpus) || !Array.isArray(body.processes)) {
        throw new HttpError(400, "Give host, gpus and processes (an agent-bus probe report)");
      }
      schedule.observe(body as unknown as Observation);
      return json({ ok: true });
    }
    return undefined;
  }
}
