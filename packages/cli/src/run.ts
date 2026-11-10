// agent-bus run: the cooperative gate (design doc A.7, level G1). It starts a command only on the GPUs of reservations
// that are active now, with CUDA_VISIBLE_DEVICES set to exactly those GPUs and AGENT_BUS_RESERVATION set so the probe
// attributes the command's processes to its reservations. A reservation id is the ticket. It cannot stop anyone who
// starts a job without it; such jobs show up on the Resources page as unclaimed use.
import { spawn } from "node:child_process";
import { constants } from "node:os";
import type { Reservation, Resource, ResourcesResponse } from "@agent-bus/protocol";

export interface Ticket {
  reservation: Reservation;
  resource: Resource;
}

/** The tickets for `ids`, or why they cannot be used now. */
export function checkTickets(schedule: ResourcesResponse, ids: string[]): Ticket[] {
  if (ids.length === 0) throw new Error("Give at least one reservation id (from the reserve op or the Resources page)");
  const byId = new Map(schedule.reservations.map((r) => [r.id, r]));
  const resources = new Map(schedule.resources.map((r) => [r.id, r]));
  return ids.map((id) => {
    const reservation = byId.get(id);
    if (!reservation) throw new Error(`Unknown reservation ${id}`);
    const resource = resources.get(reservation.resourceId);
    if (!resource) throw new Error(`${id}: its resource ${reservation.resourceId} is gone`);
    if (reservation.state === "planned") throw new Error(`${id} starts at ${new Date(reservation.start ?? 0).toISOString()}, not yet`);
    if (reservation.state === "queued") throw new Error(`${id} is still queued for ${resource.label}`);
    if (reservation.state !== "active" && reservation.state !== "overdue") throw new Error(`${id} is over (${reservation.state})`);
    if (reservation.state === "overdue") console.error(`agent-bus run: ${id} is past its end; extend or release it`);
    if (resource.kind === "gpu" && !resource.uuid) throw new Error(`${id}: ${resource.label} has no GPU uuid`);
    return { reservation, resource };
  });
}

/** The environment a ticketed command runs with. */
export function ticketEnv(tickets: Ticket[], base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const gpus = tickets.filter((t) => t.resource.kind === "gpu").map((t) => t.resource.uuid as string);
  const env: NodeJS.ProcessEnv = { ...base, AGENT_BUS_RESERVATION: tickets.map((t) => t.reservation.id).join(",") };
  // Only the reserved GPUs are visible to CUDA; with no GPU ticket, none are.
  env.CUDA_VISIBLE_DEVICES = gpus.join(",");
  env.NVIDIA_VISIBLE_DEVICES = gpus.length > 0 ? gpus.join(",") : "void";
  return env;
}

export async function runTicketed(busUrl: string, ids: string[], command: string[]): Promise<number> {
  if (command.length === 0) throw new Error("Give the command after --");
  const res = await fetch(`${busUrl}/api/resources`);
  if (!res.ok) throw new Error(`bus answered HTTP ${res.status}`);
  const tickets = checkTickets((await res.json()) as ResourcesResponse, ids);
  for (const t of tickets) {
    console.error(`agent-bus run: ${t.reservation.id} → ${t.resource.label}${t.resource.uuid ? ` (${t.resource.uuid})` : ""}, until ${new Date(t.reservation.end ?? 0).toISOString()}`);
  }
  const [cmd, ...args] = command;
  const child = spawn(cmd as string, args, { stdio: "inherit", env: ticketEnv(tickets, process.env) });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => child.kill(signal));
  return new Promise((resolve) => {
    child.on("error", (err) => {
      console.error(`agent-bus run: ${err.message}`);
      resolve(127);
    });
    child.on("exit", (code, signal) => resolve(code ?? 128 + (signal ? constants.signals[signal] : 0)));
  });
}
