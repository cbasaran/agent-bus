// HTTP calls and the browser-wide keys shared by the conversations page (app.ts) and the sign-in page (auth.ts).
import { isJsonObject } from "@agent-bus/protocol";

/** The human this browser writes as (picked on the conversations page, or set at passkey sign-in). */
export const PROFILE_KEY = "agent-bus.profile";
/** The passkey session (set by the sign-in page, /auth), sent with every request so writes count as verified. */
export const SESSION_KEY = "agent-bus.session";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const session = localStorage.getItem(SESSION_KEY);
  const headers = new Headers(init?.headers);
  if (session) headers.set("Authorization", `Bearer ${session}`);
  const res = await fetch(path, { ...init, headers });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    const error = isJsonObject(body) && typeof body.error === "string" ? body.error : `${res.status} ${res.statusText}`;
    throw new Error(error);
  }
  return body as T;
}

export function postJson<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
