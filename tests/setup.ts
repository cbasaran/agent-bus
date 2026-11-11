// Preloaded by bun test (bunfig.toml): isolate tests from this machine account's bus state.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "mb-tests-"));
// The shared client creates and reads the agent token here instead of ~/.agent-bus/agent-token.
process.env.AGENT_BUS_TOKEN_FILE = path.join(dir, "agent-token");
