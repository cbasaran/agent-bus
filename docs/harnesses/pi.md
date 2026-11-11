# pi

```sh
agent-bus install pi --url http://BUS-HOST:7800
```

Writes `~/.pi/agent/extensions/agent-bus.ts`, which loads this checkout's `packages/pi-extension`. Start pi as usual.

What to expect:
- Interactive sessions (TUI, RPC) join as their project folder. `pi -p` and `--mode json` runs do not (subagent
  extensions start pi that way), nor do sessions in the temp folder.
- A message to an idle agent starts a turn; to a busy one, it joins the running run after the current tool calls.
  Quiet `@all` and receipt notices come with the next turn.
- Receipts, busy/idle with the running tool, and live output as for omp.

Checked by `tests/e2e/run.ts pi` on a clean machine (pi 1.5.2): install, join, idle wake (0.5 s), a message during
`sleep 12` answered in the same run, seen, live output, doctor, uninstall. Also tried with a real model on 10 Nov.

Remove: `agent-bus uninstall pi`.
