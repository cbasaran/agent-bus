// Entry point bundled to dist/server.mjs: Codex runs it as the plugin's MCP server (.mcp.json), and it runs itself
// again as a chat's presence worker (reopen.ts).
import { main } from "./server";

main();
