// Entry point bundled to dist/hook.js: every hook in hooks.json runs `node ./dist/hook.js <Event>`. It passes the
// event and Antigravity's payload to the daemon over its local socket and prints the answer. Hooks must never hold
// Antigravity up: when the daemon is not running, does not answer quickly or anything fails, the hook prints the
// answer of a plugin that has nothing to add.
import { request } from "node:http";
import * as path from "node:path";
import { daemonSocketPath, hookDefault } from "./antigravity";

const TIMEOUT_MS = 3000;

/** The daemon's socket for the app that runs this hook: its data dir is the parent of `brain/` in the transcript path. */
function socketFor(payload: { transcriptPath?: unknown }): string {
  const transcript = typeof payload.transcriptPath === "string" ? payload.transcriptPath : "";
  const brain = transcript.lastIndexOf(`${path.sep}brain${path.sep}`);
  return brain > 0 ? daemonSocketPath(transcript.slice(0, brain)) : daemonSocketPath();
}

function ask(socketPath: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath, path: "/hook", method: "POST", headers: { "Content-Type": "application/json" }, timeout: TIMEOUT_MS },
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

async function run(): Promise<string> {
  const event = process.argv[2] ?? "";
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const fallback = JSON.stringify(hookDefault(event));
  try {
    const payload = JSON.parse(input || "{}") as Record<string, unknown>;
    const answer = await ask(socketFor(payload), JSON.stringify({ event, payload }));
    JSON.parse(answer);
    return answer;
  } catch {
    return fallback;
  }
}

void run().then((answer) => process.stdout.write(`${answer}\n`));
