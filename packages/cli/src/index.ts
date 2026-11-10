import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { createBusServer, createInvite, type BusServerOptions } from "@agent-bus/server";
import { DEFAULT_BUS_PORT } from "@agent-bus/protocol";
import { runTicketed } from "./run";

const USAGE = `Usage: agent-bus serve [--host 0.0.0.0] [--port 7800] [--data-dir DIR] [--humans can,umit]
                       [--https-port 7843 --tls-cert FILE --tls-key FILE] [--gpudash URL] [--forget-offline-days 15]
                       [--auth off|optional|required --rp-id HOST [--origin URL]…]
       agent-bus invite HUMAN [--data-dir DIR] [--url https://HOST:7843]
       agent-bus run [--bus URL] RESERVATION[,RESERVATION…] -- COMMAND [ARGS…]

serve:
  --host        Interface to bind (default 0.0.0.0)
  --port        Port to listen on (default 7800; 0 picks a free port)
  --data-dir    Data directory (default $AGENT_BUS_DATA_DIR or ~/.agent-bus)
  --humans      Comma-separated human ids (default $BUS_HUMANS or can,umit)
  --https-port  Also serve over TLS on this port (for browsers; agents keep the plain port)
  --tls-cert    PEM certificate for --https-port
  --tls-key     PEM private key for --https-port
  --gpudash     gpudash's URL (e.g. http://127.0.0.1:3420): the resource schedule reads what runs on each GPU
  --forget-offline-days  Forget agents offline this many days (default 15; 0 keeps them forever)
  --auth        Passkeys for humans (experimental): off (default), optional (sign-in marks messages verified),
                required (writing as a human needs a session)
  --rp-id       The host name humans open the website at (passkeys are bound to it); default localhost
  --origin      A website origin passkeys may be used from (repeat); default https://<rp-id>:<https port>
                and http://localhost:<port>

invite: a one-time link (10 min) for HUMAN to create a passkey; needs the bus's database, so only bariton's shell can.

run: start COMMAND on the GPUs of active reservations only (CUDA_VISIBLE_DEVICES), marked as theirs.
  --bus defaults to $AGENT_BUS_URL or http://127.0.0.1:${DEFAULT_BUS_PORT}.`;

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid port "${value}"`);
  return port;
}

function parseServeArgs(args: string[]): BusServerOptions {
  const options: BusServerOptions = {};
  const tls: { port?: number; certFile?: string; keyFile?: string } = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    const eq = arg.indexOf("=");
    const flag = eq >= 0 ? arg.slice(0, eq) : arg;
    const value = eq >= 0 ? arg.slice(eq + 1) : args[++i];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    switch (flag) {
      case "--host":
        options.host = value;
        break;
      case "--port":
        options.port = parsePort(value);
        break;
      case "--https-port":
        tls.port = parsePort(value);
        break;
      case "--tls-cert":
        tls.certFile = value;
        break;
      case "--tls-key":
        tls.keyFile = value;
        break;
      case "--gpudash":
        options.gpudash = value;
        break;
      case "--forget-offline-days": {
        const days = Number(value);
        if (!Number.isFinite(days) || days < 0) throw new Error("--forget-offline-days is a number of days, 0 to keep agents forever");
        options.forgetOfflineDays = days;
        break;
      }
      case "--data-dir":
        options.dataDir = value;
        break;
      case "--humans":
        options.humans = value.split(",");
        break;
      case "--auth":
        if (value !== "off" && value !== "optional" && value !== "required") throw new Error("--auth is off, optional or required");
        options.auth = { ...options.auth, mode: value };
        break;
      case "--rp-id":
        options.auth = { mode: "off", ...options.auth, rpId: value };
        break;
      case "--origin":
        options.auth = { mode: "off", ...options.auth, origins: [...(options.auth?.origins ?? []), value.replace(/\/+$/, "")] };
        break;
      default:
        throw new Error(`Unknown option "${flag}"`);
    }
  }
  const tlsGiven = [tls.port, tls.certFile, tls.keyFile].filter((v) => v !== undefined).length;
  if (tlsGiven > 0) {
    if (tls.port === undefined || tls.certFile === undefined || tls.keyFile === undefined) {
      throw new Error("--https-port, --tls-cert and --tls-key go together");
    }
    options.https = { port: tls.port, certFile: tls.certFile, keyFile: tls.keyFile };
  }
  return options;
}

/** Runs the CLI; resolves with the exit code, or never resolves while `serve` runs. */
export async function runCli(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return command === undefined ? 1 : 0;
  }
  if (command === "invite") {
    try {
      return runInvite(rest);
    } catch (error) {
      console.error(`agent-bus invite: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  if (command === "run") {
    try {
      return await runTool(command, rest);
    } catch (error) {
      console.error(`agent-bus ${command}: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  if (command !== "serve") {
    console.error(`Unknown command "${command}"\n\n${USAGE}`);
    return 1;
  }
  let options: BusServerOptions;
  try {
    options = parseServeArgs(rest);
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 1;
  }

  const bus = createBusServer(options);
  console.log(`agent-bus listening on ${bus.url}`);
  for (const lanUrl of bus.lanUrls) console.log(`  LAN: ${lanUrl}`);
  for (const httpsUrl of bus.httpsLanUrls ?? []) console.log(`  HTTPS: ${httpsUrl}`);
  console.log(`  data: ${bus.dataDir}`);

  const { promise, resolve } = Promise.withResolvers<number>();
  const shutdown = (): void => {
    void bus.stop().then(() => resolve(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return promise;
}

function runInvite(args: string[]): number {
  let dataDir = process.env.AGENT_BUS_DATA_DIR || path.join(homedir(), ".agent-bus");
  let url = `https://${hostname().split(".")[0]}:7843`;
  let human: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--data-dir") dataDir = args[++i] ?? "";
    else if (arg === "--url") url = (args[++i] ?? "").replace(/\/+$/, "");
    else if (arg.startsWith("--")) throw new Error(`Unknown option "${arg}"`);
    else human = arg.replace(/^@/, "").toLowerCase();
  }
  if (!human) throw new Error("Give the human's id, e.g. agent-bus invite can");
  const dbPath = path.join(dataDir, "message-bus.sqlite");
  if (!existsSync(dbPath)) throw new Error(`No bus database at ${dbPath}`);
  const db = new Database(dbPath, { strict: true });
  db.exec("PRAGMA busy_timeout = 5000;");
  const token = createInvite(db, human);
  db.close();
  console.log(`Open within 10 minutes, on the device that should hold ${human}'s passkey (works once):\n${url}/auth#invite=${token}`);
  return 0;
}

async function runTool(command: "run", args: string[]): Promise<number> {
  let bus = (process.env.AGENT_BUS_URL?.trim() || `http://127.0.0.1:${DEFAULT_BUS_PORT}`).replace(/\/+$/, "");
  const positional: string[] = [];
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--") {
      i++;
      break;
    }
    if (arg === "--bus") bus = (args[++i] ?? "").replace(/\/+$/, "");
    else if (arg.startsWith("--")) throw new Error(`Unknown option "${arg}"`);
    else positional.push(arg);
  }
  if (!bus) throw new Error(`--bus needs a URL (${command})`);
  const ids = positional.flatMap((p) => p.split(",")).map((s) => s.trim()).filter(Boolean);
  return runTicketed(bus, ids, args.slice(i));
}
