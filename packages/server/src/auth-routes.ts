// Human authentication routes, /api/auth/* (experimental; docs/design/resources-and-auth.md part B). The passkey
// ceremonies and sessions are in auth.ts.
import type { HumanAuth } from "./auth";
import { HttpError, json, readJsonObject } from "./http";

/** A short label for a session or passkey: the browser's user agent, as the human sees it in the list. */
function deviceLabel(req: Request): string {
  const ua = req.headers.get("user-agent") ?? "";
  const os = /iPhone|iPad|Mac OS X|Android|Windows|Linux/.exec(ua)?.[0]?.replace("Mac OS X", "Mac") ?? "device";
  const browser = /Edg|Firefox|Chrome|Safari/.exec(ua)?.[0]?.replace("Edg", "Edge") ?? "browser";
  return `${browser} on ${os}`;
}

/** Answers a request under /api/auth/; `site` is what the website needs to know to offer passkeys. */
export async function handleAuth(
  auth: HumanAuth,
  site: { rpId: string; httpsPort: number | undefined },
  req: Request,
  url: URL
): Promise<Response> {
  const { pathname } = url;
  const method = req.method;
  if (method === "GET" && pathname === "/api/auth/state") {
    const me = auth.mode === "off" ? null : (auth.humanOf(req) ?? null);
    return json({ mode: auth.mode, rpId: site.rpId, httpsPort: site.httpsPort ?? null, me, enrolled: auth.enrolled() });
  }
  if (auth.mode === "off") throw new HttpError(404, "Authentication is off on this bus (agent-bus serve --auth optional)");
  if (method !== "POST" && method !== "GET") throw new HttpError(405, "Method not allowed");
  if (method === "POST" && pathname === "/api/auth/register/options") {
    const body = await readJsonObject(req);
    return json(auth.registerOptions(String(body.invite ?? "")));
  }
  if (method === "POST" && pathname === "/api/auth/register/verify") {
    const result = auth.registerVerify(await readJsonObject(req), deviceLabel(req));
    return json({ human: result.human, session: result.token });
  }
  if (method === "POST" && pathname === "/api/auth/login/options") {
    const body = await readJsonObject(req);
    return json(auth.loginOptions(typeof body.human === "string" ? body.human.trim().toLowerCase() : undefined));
  }
  if (method === "POST" && pathname === "/api/auth/login/verify") {
    const result = auth.loginVerify(await readJsonObject(req), deviceLabel(req));
    return json({ human: result.human, session: result.token });
  }
  if (method === "POST" && pathname === "/api/auth/logout") {
    auth.logout(req);
    return json({ ok: true });
  }
  const me = auth.humanOf(req);
  if (!me) throw new HttpError(401, "Sign in first");
  if (method === "GET" && pathname === "/api/auth/credentials") return json({ human: me, credentials: auth.credentials(me) });
  const remove = /^\/api\/auth\/credentials\/([^/]+)\/remove$/.exec(pathname);
  if (method === "POST" && remove?.[1]) {
    auth.checkWriter(req, me, "human");
    auth.removeCredential(me, decodeURIComponent(remove[1]));
    return json({ ok: true });
  }
  throw new HttpError(404, `No route for ${method} ${pathname}`);
}
