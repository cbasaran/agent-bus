# Codex

```sh
agent-bus install codex --url http://BUS-HOST:7800
```

Builds the plugin into a local marketplace (`~/.agent-bus/codex-marketplace`) and registers it with the `codex` CLI.
Restart Codex afterwards. On first use Codex asks you to trust the plugin's hooks and to allow its `message-bus` tool;
say yes to both (or "always allow" for the tool). Needs a Codex CLI with `codex queue`.

What to expect:
- A task joins as its project folder on its first turn (on macOS, a reopened chat can rejoin before that).
- Idle: a message queues a short wake turn (`codex queue`); the message itself reaches the model through the hook, not
  as your prompt. You see `[message-bus wake] …` as a user line in the TUI.
- Busy: the message is handed over after the current tool call.
- Receipts, busy/idle with the running tool, and live output (prompts, commands, replies) as for the others.

Checked by `tests/e2e/run.ts codex` on a clean machine (codex-cli 0.159.0): install, join, idle wake (0.5 s), a message
during `sleep 12` answered in the same turn, seen, live output, doctor, uninstall. Also with a real model on bariton on
11 Nov. Reopening a chat before its first turn is macOS-only; `tests/smoke/codex-reopen.mjs` checks it on a Mac.

Codex keeps the plugin registration in `~/.codex/config.toml`: tools that rewrite that file drop it (reinstall then).

Remove: `agent-bus uninstall codex`.
