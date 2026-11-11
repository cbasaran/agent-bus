// The local socket between a plugin's hook processes and its long-running server (the Antigravity daemon, the Claude
// Code MCP server): the hook POSTs its event and the harness's input, the server answers with what the hook prints.
// Runs on Node (the plugins are bundled for it): `node:*` only.
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import * as path from "node:path";

/** A hook waits this long for the server, then prints its neutral answer. */
const HOOK_TIMEOUT_MS = 3000;

export interface HookSocket {
  /** Stops listening and removes the socket file. */
  close(): void;
}

/** Listens on `socketPath`; `answer` gets each request body and returns the hook's answer (it handles its own errors). */
export function serveHookSocket(socketPath: string, answer: (body: string) => Promise<unknown>): HookSocket {
  mkdirSync(path.dirname(socketPath), { recursive: true });
  // Left by a server that did not shut down cleanly (Claude Code's sockets are named after pids, which are reused).
  if (existsSync(socketPath)) unlinkSync(socketPath);
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      void answer(body).then((result) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      });
    });
  });
  server.listen(socketPath);
  return {
    close() {
      server.close();
      try {
        unlinkSync(socketPath);
      } catch {
        // Already gone.
      }
    },
  };
}

function ask(socketPath: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath, path: "/hook", method: "POST", headers: { "Content-Type": "application/json" }, timeout: HOOK_TIMEOUT_MS },
      (res) => {
        let out = "";
        res.on("data", (chunk) => (out += chunk));
        res.on("end", () => resolve(out));
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

/**
 * The body of a hook process: reads the harness's input from stdin, sends what `toServer` makes of it, and prints the
 * server's answer. Hooks must never hold the session up: when the server is not there, slow, answers something that
 * is not JSON or anything fails, it prints `fallback` (the answer of a plugin that has nothing to add).
 */
export async function relayHook(
  fallback: string,
  toServer: (input: string) => { socketPath: string; body: string }
): Promise<void> {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  let answer: string;
  try {
    const { socketPath, body } = toServer(input);
    answer = await ask(socketPath, body);
    JSON.parse(answer);
  } catch {
    answer = fallback;
  }
  process.stdout.write(`${answer}\n`);
}
