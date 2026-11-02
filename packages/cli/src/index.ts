import { createBusServer, type BusServerOptions } from "@agent-bus/server";

const USAGE = `Usage: agent-bus serve [--host 0.0.0.0] [--port 7800] [--data-dir DIR] [--humans can,umit]
                       [--https-port 7843 --tls-cert FILE --tls-key FILE]

  --host        Interface to bind (default 0.0.0.0)
  --port        Port to listen on (default 7800; 0 picks a free port)
  --data-dir    Data directory (default $AGENT_BUS_DATA_DIR or ~/.agent-bus)
  --humans      Comma-separated human ids (default $BUS_HUMANS or can,umit)
  --https-port  Also serve over TLS on this port (for browsers; agents keep the plain port)
  --tls-cert    PEM certificate for --https-port
  --tls-key     PEM private key for --https-port`;

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
      case "--data-dir":
        options.dataDir = value;
        break;
      case "--humans":
        options.humans = value.split(",");
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
