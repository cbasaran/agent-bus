// Where a session's MCP server listens for that session's hooks: named after the `claude` process, the parent of both.
import * as os from "node:os";
import * as path from "node:path";

export function hookSocketPath(claudePid: number): string {
  const dir = process.env.AGENT_BUS_CLAUDE_SOCKET_DIR || path.join(os.homedir(), ".agent-bus", "claude");
  return path.join(dir, `${claudePid}.sock`);
}
