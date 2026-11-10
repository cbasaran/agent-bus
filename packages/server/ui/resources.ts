// The Resources page (experimental; docs/design/resources-and-auth.md part A): one row per resource with a timeline
// of its reservations (6 h back, 42 h ahead), what the probes see running on it, and warnings. Live: the viewer socket
// says when the schedule changed. Humans reserve, release and add services here.
import { formatUtc, type ObservedGpu, type Reservation, type Resource, type ResourcesResponse } from "@agent-bus/protocol";

const PROFILE_KEY = "agent-bus.profile";
const HOUR = 3600_000;
const BACK = 6 * HOUR;
const AHEAD = 42 * HOUR;

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`#${id} missing`);
  return found as T;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const dom = {
  link: el<HTMLSpanElement>("res-link"),
  profile: el<HTMLSelectElement>("res-profile"),
  warnings: el<HTMLElement>("res-warnings"),
  scale: el<HTMLDivElement>("res-scale"),
  rows: el<HTMLDivElement>("res-rows"),
  empty: el<HTMLParagraphElement>("res-empty"),
  reserve: el<HTMLFormElement>("res-reserve"),
  fResource: el<HTMLSelectElement>("res-f-resource"),
  fHours: el<HTMLInputElement>("res-f-hours"),
  fAmount: el<HTMLInputElement>("res-f-amount"),
  fUnit: el<HTMLSpanElement>("res-f-unit"),
  fStart: el<HTMLInputElement>("res-f-start"),
  fPurpose: el<HTMLInputElement>("res-f-purpose"),
  fForce: el<HTMLInputElement>("res-f-force"),
  reserveMsg: el<HTMLDivElement>("res-reserve-msg"),
  register: el<HTMLFormElement>("res-register"),
  rKind: el<HTMLSelectElement>("res-r-kind"),
  rHost: el<HTMLInputElement>("res-r-host"),
  rName: el<HTMLInputElement>("res-r-name"),
  rLabel: el<HTMLInputElement>("res-r-label"),
  rCapacity: el<HTMLInputElement>("res-r-capacity"),
  registerMsg: el<HTMLDivElement>("res-register-msg"),
};

let schedule: ResourcesResponse | undefined;

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

function me(): string {
  return dom.profile.value;
}

/** GPU memory as people say it (GB); other units as they are. */
function amountText(amount: number, resource: Resource): string {
  return resource.unit === "MiB" ? `${(amount / 1024).toFixed(amount >= 10 * 1024 ? 0 : 1)} GB` : `${amount} ${resource.unit}`;
}

const shortTime = (ts: number): string => formatUtc(ts).slice(11);

// ---- Rendering ----

function render(): void {
  if (!schedule) return;
  const s = schedule;
  const now = Date.now();
  const from = now - BACK;
  const span = BACK + AHEAD;
  const x = (ts: number): number => Math.min(100, Math.max(0, ((ts - from) / span) * 100));

  // Scale: a tick every 6 h on the UTC clock, and "now".
  dom.scale.replaceChildren(h("div", "res-label-col"));
  const track = h("div", "res-track res-scale-track");
  for (let tick = Math.ceil(from / (6 * HOUR)) * 6 * HOUR; tick <= from + span; tick += 6 * HOUR) {
    if (Math.abs(tick - now) < 2 * HOUR) continue; // the "now" label stands there
    const mark = h("span", "res-tick", formatUtc(tick).slice(5, 16).replace("-", "/"));
    mark.style.left = `${x(tick)}%`;
    track.append(mark);
  }
  const nowMark = h("span", "res-tick res-tick-now", `now ${shortTime(now)}`);
  nowMark.style.left = `${x(now)}%`;
  track.append(nowMark);
  dom.scale.append(track);

  dom.empty.hidden = s.resources.length > 0;
  dom.rows.replaceChildren(...s.resources.map((resource) => renderRow(resource, s, x, now)));

  dom.warnings.hidden = s.warnings.length === 0;
  dom.warnings.replaceChildren(...s.warnings.map((w) => h("div", `res-warning res-warning-${w.kind}`, w.text)));

  renderResourceOptions(s.resources);
}

function renderRow(resource: Resource, s: ResourcesResponse, x: (ts: number) => number, now: number): HTMLElement {
  const row = h("div", "res-row");
  const observed: (ObservedGpu & { at: number }) | undefined = s.observed[resource.id];

  const label = h("div", "res-label-col");
  label.append(h("div", "res-name", resource.label));
  const meta = [resource.kind, resource.unit === "MiB" ? amountText(resource.capacity, resource) : resource.capacity > 1 ? `${resource.capacity} ${resource.unit}s` : ""];
  if (resource.model) meta.push(resource.model.replace(/^NVIDIA /, ""));
  label.append(h("div", "res-meta", meta.filter(Boolean).join(" · ")));
  if (observed && resource.unit === "MiB") {
    const bar = h("div", "res-usage");
    const fill = h("div", "res-usage-fill");
    fill.style.width = `${Math.min(100, (observed.memoryUsed / resource.capacity) * 100)}%`;
    bar.append(fill);
    bar.title = `${amountText(observed.memoryUsed, resource)} of ${amountText(resource.capacity, resource)} in use, ${observed.utilization}% busy (probe ${shortTime(observed.at)})`;
    label.append(bar, h("div", "res-meta", `${amountText(observed.memoryUsed, resource)} used · ${observed.utilization}% busy`));
  }
  const queued = s.reservations.filter((r) => r.resourceId === resource.id && r.state === "queued");
  for (const r of queued) label.append(h("div", "res-queued", `queued: @${r.holder}, ${Math.round(r.durationMs / 360_000) / 10} h · ${r.purpose}`));

  const track = h("div", "res-track");
  const nowLine = h("div", "res-now");
  nowLine.style.left = `${x(now)}%`;
  track.append(nowLine);
  // Lanes: each bar takes the first lane free at its start.
  const bars = s.reservations
    .filter((r) => r.resourceId === resource.id && r.start !== undefined)
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  const laneEnds: number[] = [];
  for (const r of bars) {
    const start = r.start ?? now;
    const end = r.endedAt ?? Math.max(r.end ?? now, r.state === "overdue" ? now : 0);
    let lane = laneEnds.findIndex((e) => e <= start);
    if (lane < 0) lane = laneEnds.push(0) - 1;
    laneEnds[lane] = end;
    track.append(renderBar(r, resource, x(start), x(end), lane));
  }
  track.style.minHeight = `${Math.max(1, laneEnds.length) * 26 + 6}px`;

  const runs = h("div", "res-runs");
  for (const p of observed?.processes ?? []) {
    const who = p.agentId ? `@${p.agentId}` : p.container ? p.container : `pid ${p.pid}`;
    const chip = h("span", `res-run${p.agentId ? "" : " res-run-unknown"}`, `${who} ${amountText(p.memory, resource)}`);
    chip.title = `${p.container ? `container ${p.container}\n` : ""}${p.command}${p.cwd ? `\nin ${p.cwd}` : ""}${p.reservationId ? `\nreservation ${p.reservationId}` : ""}`;
    runs.append(chip);
  }
  const right = h("div", "res-right");
  right.append(track, runs);
  row.append(label, right);
  return row;
}

function renderBar(r: Reservation, resource: Resource, left: number, right: number, lane: number): HTMLElement {
  const bar = h("button", `res-bar res-${r.state}${r.idleSince !== undefined ? " res-idle" : ""}`);
  bar.type = "button";
  bar.style.left = `${left}%`;
  bar.style.width = `${Math.max(0.6, right - left)}%`;
  bar.style.top = `${3 + lane * 26}px`;
  const part = r.amount === undefined ? "" : ` · ${amountText(r.amount, resource)}`;
  bar.textContent = `@${r.holder}${part} · ${r.purpose}`;
  bar.title = [
    `${r.id} · @${r.holder} · ${r.state}${r.idleSince !== undefined ? " (idle)" : ""}`,
    `${r.start ? formatUtc(r.start) : "?"} – ${r.end ? formatUtc(r.end) : "?"}${r.endedAt ? `, ended ${formatUtc(r.endedAt)}` : ""}`,
    r.amount === undefined ? "all of it" : amountText(r.amount, resource),
    r.purpose,
    r.lastUsedAt ? `last seen in use ${formatUtc(r.lastUsedAt)}` : "",
    ["active", "overdue", "planned"].includes(r.state) ? "Click to release." : "",
  ]
    .filter(Boolean)
    .join("\n");
  if (["active", "overdue", "planned"].includes(r.state)) {
    bar.addEventListener("click", () => {
      if (!confirm(`Release ${r.id} (@${r.holder}: ${r.purpose}) as @${me()}?`)) return;
      api(`/api/reservations/${encodeURIComponent(r.id)}/release`, { from: me() }).then(load, (err: Error) => alert(err.message));
    });
  } else bar.disabled = true;
  return bar;
}

function renderResourceOptions(resources: Resource[]): void {
  const current = dom.fResource.value;
  dom.fResource.replaceChildren(...resources.map((r) => {
    const option = h("option", undefined, r.label);
    option.value = r.id;
    return option;
  }));
  if (resources.some((r) => r.id === current)) dom.fResource.value = current;
  updateUnit();
}

function updateUnit(): void {
  const resource = schedule?.resources.find((r) => r.id === dom.fResource.value);
  dom.fUnit.textContent = resource ? (resource.unit === "MiB" ? `GB of ${amountText(resource.capacity, resource)}` : `of ${resource.capacity} ${resource.unit}`) : "";
}

// ---- Forms ----

dom.fResource.addEventListener("change", updateUnit);

dom.reserve.addEventListener("submit", (event) => {
  event.preventDefault();
  const resource = schedule?.resources.find((r) => r.id === dom.fResource.value);
  if (!resource) return;
  const body: Record<string, unknown> = { from: me(), resource: resource.id, hours: Number(dom.fHours.value), purpose: dom.fPurpose.value };
  if (dom.fAmount.value) body.amount = resource.unit === "MiB" ? Math.round(Number(dom.fAmount.value) * 1024) : Number(dom.fAmount.value);
  const start = dom.fStart.value.trim().toLowerCase();
  if (start === "next") body.start = "next";
  else if (start && start !== "now") {
    const at = Date.parse(dom.fStart.value.trim().replace(" ", "T"));
    if (Number.isNaN(at)) {
      dom.reserveMsg.textContent = 'Start: "now", "next" or a UTC time like 2026-11-10 14:00Z.';
      return;
    }
    body.start = at;
  }
  if (dom.fForce.checked) body.force = true;
  api<{ reservation: Reservation }>("/api/reservations", body).then(
    (res) => {
      dom.reserveMsg.textContent = `Reserved: ${res.reservation.id} (${res.reservation.state}).`;
      dom.fPurpose.value = "";
      void load();
    },
    (err: Error) => {
      dom.reserveMsg.textContent = err.message;
    }
  );
});

dom.register.addEventListener("submit", (event) => {
  event.preventDefault();
  const body = {
    from: me(),
    kind: dom.rKind.value,
    host: dom.rHost.value,
    name: dom.rName.value,
    label: dom.rLabel.value || undefined,
    capacity: Number(dom.rCapacity.value) || 1,
  };
  api<{ resource: Resource }>("/api/resources", body).then(
    (res) => {
      dom.registerMsg.textContent = `Added ${res.resource.label} (${res.resource.id}).`;
      void load();
    },
    (err: Error) => {
      dom.registerMsg.textContent = err.message;
    }
  );
});

// ---- Data and live updates ----

async function load(): Promise<void> {
  schedule = await api<ResourcesResponse>("/api/resources");
  render();
}

async function boot(): Promise<void> {
  const state = await api<{ humans: string[] }>("/api/state");
  dom.profile.replaceChildren(...state.humans.map((id) => h("option", undefined, id)));
  const saved = localStorage.getItem(PROFILE_KEY);
  if (saved && state.humans.includes(saved)) dom.profile.value = saved;
  dom.profile.addEventListener("change", () => localStorage.setItem(PROFILE_KEY, me()));
  await load();
  connect();
  // The now line and idle times move with the clock.
  setInterval(render, 60_000);
}

function connect(): void {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/viewer`);
  ws.onopen = () => {
    dom.link.dataset.state = "live";
    dom.link.textContent = "live";
    void load();
  };
  ws.onmessage = (event) => {
    if ((JSON.parse(String(event.data)) as { type?: string }).type === "resources") void load();
  };
  ws.onclose = () => {
    dom.link.dataset.state = "offline";
    dom.link.textContent = "reconnecting…";
    setTimeout(connect, 2000);
  };
}

void boot();
