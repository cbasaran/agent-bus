import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  ALL_CONVERSATION_ID,
  DEFAULT_BUS_PORT,
  PROTOCOL_VERSION,
  slugifyId,
  type HealthResponse,
  type StateResponse,
} from "@agent-bus/protocol";
import { forgetOfflineAgents, postSetting, socketHandlers } from "./agents";
import { HumanAuth, type AuthMode } from "./auth";
import { handleAuth } from "./auth-routes";
import { BusContext } from "./context";
import { BusDatabase } from "./db";
import { getFile, MAX_FILE_BYTES, postFile } from "./files";
import { CORS_HEADERS, errorResponse, json, nonEmptyParam } from "./http";
import type { SocketData } from "./hub";
import { resolveLanAddresses } from "./lan";
import { getMessageReceipts, getMessages, MAX_RECEIPT_WAIT_MS, postMessage } from "./messages";
import { getHistory, getInbox, getSearch } from "./reading";
import { ScheduleService } from "./schedule-routes";
import { Website } from "./website";

export interface BusServerOptions {
  host?: string;
  /** 0 picks a free port. */
  port?: number;
  dataDir?: string;
  humans?: string[];
  /**
   * Also serve everything over TLS on a second port (browsers need https for notifications). Agents keep
   * using the plain port. The files are read at startup; a renewed certificate takes effect on restart.
   */
  https?: { port: number; certFile: string; keyFile: string };
  /**
   * gpudash's base URL (e.g. http://127.0.0.1:3420): every 30 s the resource schedule reads its
   * GET /api/observations to see what runs on each GPU (and so registers the GPUs). Without it the schedule
   * still books, but cannot see use: no idle flags, no unclaimed-use warnings, and no GPUs until registered.
   */
  gpudash?: string;
  /** Agents offline for this many days are forgotten (participant record and their pending receipts). 0: never. Default 15. */
  forgetOfflineDays?: number;
  /**
   * Human authentication with passkeys (experimental). `off` (default): `from` is trusted as today. `optional`:
   * humans can sign in; their messages carry `verified`. `required`: writing as a human needs a session.
   * `rpId` is the host name the website is opened at (passkeys are bound to it); `origins` defaults to
   * https://<rpId>:<https port> and http://localhost:<port>.
   */
  auth?: { mode: AuthMode; rpId?: string; origins?: string[] };
}

export interface BusServerHandle {
  url: string;
  port: number;
  lanUrls: string[];
  /** Set when `https` was given. */
  httpsPort?: number;
  httpsLanUrls?: string[];
  dataDir: string;
  dbPath: string;
  stop(): Promise<void>;
}

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_HUMANS = ["can", "umit"];

function resolveHumans(option: string[] | undefined): string[] {
  const raw = option ?? process.env.BUS_HUMANS?.split(",") ?? DEFAULT_HUMANS;
  const out: string[] = [];
  for (const entry of raw) {
    const id = slugifyId(entry);
    if (id && id !== ALL_CONVERSATION_ID && !out.includes(id)) out.push(id);
  }
  if (out.length === 0) throw new Error(`No valid human ids in ${JSON.stringify(raw)}`);
  return out;
}

export function createBusServer(options: BusServerOptions = {}): BusServerHandle {
  const host = options.host ?? DEFAULT_HOST;
  const dataDir = path.resolve(
    options.dataDir ?? process.env.AGENT_BUS_DATA_DIR ?? path.join(homedir(), ".agent-bus")
  );
  const filesDir = path.join(dataDir, "files");
  mkdirSync(filesDir, { recursive: true });
  const dbPath = path.join(dataDir, "message-bus.sqlite");
  const humans = resolveHumans(options.humans);
  const db = new BusDatabase(dbPath, humans);
  // The ports are known once the servers listen; the passkey origins follow them.
  let boundPort = 0;
  let boundHttpsPort: number | undefined;
  const rpId = options.auth?.rpId ?? "localhost";
  const auth = new HumanAuth(db.db, {
    mode: options.auth?.mode ?? "off",
    rpId,
    humans,
    origins: () =>
      options.auth?.origins ?? [...(boundHttpsPort ? [`https://${rpId}:${boundHttpsPort}`] : []), `http://localhost:${boundPort}`],
  });
  const ctx = new BusContext(db, humans, auth, filesDir);
  // Nobody is connected yet: apply the logoff rule to everyone (also cleans up after a crash).
  for (const agent of db.listAgents()) db.removeIfIdle(agent.id);
  const startedAt = Date.now();

  /** Agents offline for `forgetOfflineDays` days are forgotten (0: never). Checked at start and every hour. */
  const forgetOfflineDays = options.forgetOfflineDays ?? 15;
  forgetOfflineAgents(ctx, forgetOfflineDays);
  const forgetTimer = setInterval(() => forgetOfflineAgents(ctx, forgetOfflineDays), 3600_000);

  const schedule = new ScheduleService(ctx, options.gpudash);
  const website = new Website();
  const websocket = socketHandlers(ctx);
  let lanUrls: string[] = [];

  const handleApi = async (req: Request, url: URL): Promise<Response> => {
    const { pathname } = url;
    const method = req.method;
    if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (method === "GET" && pathname === "/api/health") {
      const health: HealthResponse = {
        ok: true,
        version: PROTOCOL_VERSION,
        uptimeMs: Date.now() - startedAt,
        lanUrls,
      };
      return json(health);
    }
    if (method === "GET" && pathname === "/api/state") {
      const state: StateResponse = { participants: ctx.hub.listParticipants(), conversations: db.listConversations(), humans };
      return json(state);
    }
    if (method === "GET" && pathname === "/api/inbox") return json(getInbox(ctx, url));
    if (method === "GET" && pathname === "/api/history") return json(getHistory(ctx, url));
    if (method === "GET" && pathname === "/api/search") return json(getSearch(ctx, url));
    const messagesMatch = /^\/api\/conversations\/([^/]+)\/messages$/.exec(pathname);
    if (method === "GET" && messagesMatch?.[1]) {
      return json(getMessages(ctx, decodeURIComponent(messagesMatch[1]), url));
    }
    if (method === "POST" && pathname === "/api/messages") return json(await postMessage(ctx, req));
    const messageMatch = /^\/api\/messages\/(\d+)$/.exec(pathname);
    if (method === "GET" && messageMatch?.[1]) return json(await getMessageReceipts(ctx, Number(messageMatch[1]), url));
    if (method === "POST" && pathname === "/api/files") return json(await postFile(ctx, req, url));
    const fileMatch = /^\/api\/files\/([^/]+)$/.exec(pathname);
    if (method === "GET" && fileMatch?.[1]) return getFile(ctx, decodeURIComponent(fileMatch[1]));
    if (method === "POST" && pathname === "/api/settings") return json(await postSetting(ctx, req));
    if (pathname.startsWith("/api/auth/")) return handleAuth(auth, { rpId, httpsPort: boundHttpsPort }, req, url);
    return (await schedule.handle(req, url)) ?? json({ error: `No route for ${method} ${pathname}` }, 404);
  };

  const listen = (listenPort: number, tls?: { cert: Bun.BunFile; key: Bun.BunFile }): Bun.Server<SocketData> =>
    Bun.serve<SocketData>({
      hostname: host,
      port: listenPort,
      tls,
      // Uploads are streamed and capped at MAX_FILE_BYTES in postFile; leave headroom for the cap check.
      maxRequestBodySize: MAX_FILE_BYTES + 1024 * 1024,
      // Bun closes requests idle for 10 s by default, which would cut GET /api/messages/:seq?waitMs= short.
      idleTimeout: MAX_RECEIPT_WAIT_MS / 1000 + 10,
      async fetch(req, srv) {
        const url = new URL(req.url);
        const { pathname } = url;
        if (pathname === "/ws/agent") {
          const data: SocketData = {
            kind: "agent",
            host: nonEmptyParam(url, "host"),
            path: nonEmptyParam(url, "path"),
            name: nonEmptyParam(url, "name"),
            harness: nonEmptyParam(url, "harness"),
            token: nonEmptyParam(url, "token"),
            id: "",
          };
          if (srv.upgrade(req, { data })) return undefined;
          return json({ error: "Expected a WebSocket upgrade" }, 400);
        }
        if (pathname === "/ws/viewer") {
          if (srv.upgrade(req, { data: { kind: "viewer" } })) return undefined;
          return json({ error: "Expected a WebSocket upgrade" }, 400);
        }
        if (pathname.startsWith("/api/")) {
          try {
            return await handleApi(req, url);
          } catch (error) {
            return errorResponse(error);
          }
        }
        const page = req.method === "GET" ? website.serve(pathname) : undefined;
        return page ?? new Response("Not found", { status: 404 });
      },
      websocket,
    });

  const server = listen(options.port ?? DEFAULT_BUS_PORT);
  const port = server.port;
  if (port === undefined) throw new Error("Server did not bind a port");
  boundPort = port;
  const lan = resolveLanAddresses(port, host);
  lanUrls = lan.lanUrls;

  let secure: Bun.Server<SocketData> | undefined;
  if (options.https) {
    const { certFile, keyFile } = options.https;
    for (const file of [certFile, keyFile]) {
      if (!existsSync(file)) throw new Error(`TLS file not found: ${file}`);
    }
    secure = listen(options.https.port, { cert: Bun.file(certFile), key: Bun.file(keyFile) });
  }
  const httpsPort = secure?.port;
  boundHttpsPort = httpsPort;

  let stopped = false;
  return {
    url: lan.localUrl,
    port,
    lanUrls,
    httpsPort,
    httpsLanUrls:
      httpsPort === undefined
        ? undefined
        : resolveLanAddresses(httpsPort, host).lanUrls.map((u) => u.replace(/^http:/, "https:")),
    dataDir,
    dbPath,
    async stop() {
      if (stopped) return;
      stopped = true;
      ctx.hub.stop();
      schedule.stop();
      clearInterval(forgetTimer);
      await Promise.all([server.stop(true), secure?.stop(true)]);
      ctx.hub.dropSockets();
      db.close();
    },
  };
}
