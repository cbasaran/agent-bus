// HTTP helpers shared by the route modules: JSON responses with CORS headers, errors that carry their status, and
// request bodies and query parameters.
import { isJsonObject } from "@agent-bus/protocol";
import { AuthError } from "./auth";
import { ScheduleError } from "./resources";

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: CORS_HEADERS });
}

/** An /api/ request's failure as its response: `{error}` with the status of a known error, else 500 (logged). */
export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError || error instanceof ScheduleError || error instanceof AuthError) {
    return json({ error: error.message }, error.status);
  }
  console.error(error);
  return json({ error: error instanceof Error ? error.message : String(error) }, 500);
}

export async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "Body must be JSON");
  }
  if (!isJsonObject(body)) throw new HttpError(400, "Body must be a JSON object");
  return body;
}

export function nonEmptyParam(url: URL, key: string): string | null {
  const value = url.searchParams.get(key)?.trim();
  return value ? value : null;
}
