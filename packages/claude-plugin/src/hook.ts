// Entry point bundled to dist/hook.mjs: every hook in hooks.json runs `node dist/hook.mjs <Event>` in exec form, so
// its parent is the session's `claude` process, as is the parent of the plugin's MCP server for that session. It passes
// the event and Claude Code's input to that server over its socket and prints the answer. Hooks must never hold the
// session up: when the server is not there, slow or anything fails, the hook prints `{}` (nothing to add).
import { request } from "node:http";
import { hookSocketPath } from "./socket";

const TIMEOUT_MS = 3000;

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
  try {
    const answer = await ask(hookSocketPath(process.ppid), JSON.stringify({ event, input: JSON.parse(input || "{}") }));
    JSON.parse(answer);
    return answer;
  } catch {
    return "{}";
  }
}

void run().then((answer) => process.stdout.write(`${answer}\n`));
