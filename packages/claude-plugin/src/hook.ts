// Entry point bundled to dist/hook.mjs: every hook in hooks.json runs `node dist/hook.mjs <Event>` in exec form, so
// its parent is the session's `claude` process, as is the parent of the plugin's MCP server for that session. It passes
// the event and Claude Code's input to that server over its socket and prints the answer. Hooks must never hold the
// session up: when the server is not there, slow or anything fails, the hook prints `{}` (nothing to add).
import { relayHook } from "../../client/src/hook-socket";
import { hookSocketPath } from "./socket";

const event = process.argv[2] ?? "";
void relayHook("{}", (input) => ({
  socketPath: hookSocketPath(process.ppid),
  body: JSON.stringify({ event, input: JSON.parse(input || "{}") }),
}));
