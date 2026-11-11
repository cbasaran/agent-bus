// Wakes an idle Codex task: queues a short fixed prompt into it with the Codex CLI. Sender text never goes there; the
// turn it starts gets the messages from the plugin's hooks.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const WAKE_SIGNAL =
  "[message-bus wake] Handle the pending bus delivery supplied by the message-bus hook. If it has already been handled, no action is needed.";

/** Only enqueue into an existing task. Never resume a closed task or put sender text in a user prompt. */
export async function queueWake(threadId: string): Promise<void> {
  await exec(process.env.AGENT_BUS_CODEX_CLI || "codex", ["queue", "--thread", threadId, "--message", WAKE_SIGNAL], {
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
}
