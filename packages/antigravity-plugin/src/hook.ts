// Entry point bundled to dist/hook.mjs: every hook in hooks.json runs `node ./dist/hook.mjs <Event>`. It passes the
// event and Antigravity's payload to the daemon over its local socket and prints the answer. Hooks must never hold
// Antigravity up: when the daemon is not running, does not answer quickly or anything fails, the hook prints the
// answer of a plugin that has nothing to add.
import * as path from "node:path";
import { relayHook } from "../../client/src/hook-socket";
import { daemonSocketPath, hookDefault } from "./antigravity";

/** The daemon's socket for the app that runs this hook: its data dir is the parent of `brain/` in the transcript path. */
function socketFor(payload: { transcriptPath?: unknown }): string {
  const transcript = typeof payload.transcriptPath === "string" ? payload.transcriptPath : "";
  const brain = transcript.lastIndexOf(`${path.sep}brain${path.sep}`);
  return brain > 0 ? daemonSocketPath(transcript.slice(0, brain)) : daemonSocketPath();
}

const event = process.argv[2] ?? "";
void relayHook(JSON.stringify(hookDefault(event)), (input) => {
  const payload = JSON.parse(input || "{}") as Record<string, unknown>;
  return { socketPath: socketFor(payload), body: JSON.stringify({ event, payload }) };
});
