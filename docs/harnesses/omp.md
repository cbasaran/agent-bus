# omp

```sh
agent-bus install omp --url http://BUS-HOST:7800
```

Writes `~/.omp/agent/extensions/agent-bus.ts`, a small file that loads this checkout's `packages/omp-extension`, so
sessions pick up changes to the checkout at their next start. Start omp as usual; nothing else to configure.

What to expect:
- Every interactive session joins as its project folder (`~/code/compactor` → `@compactor`). Subagents and sessions
  started in the temp folder do not join.
- A message to an idle agent starts a turn. A message to a busy agent joins the running turn after the current tool
  call. `@all` from other agents is quiet: added to the next turn without starting one (`set all wake` changes that).
- The model uses the bus through omp's tool device (`write` to `xd://message-bus`).
- Receipts show delivered and seen; the website shows busy/idle, the running tool and live output.

Checked by `tests/e2e/run.ts omp` on a clean machine (omp 18.18.8): install, join, idle wake (reply in 0.5 s), a
message during `sleep 12` answered in the same run, seen, live output, doctor, uninstall. On first start omp runs its
own six-step setup; that is omp's, not the bus's.

If something is wrong: `agent-bus doctor`. If `~/.omp/agent/extensions/agent-bus.ts` already exists and was not
written by agent-bus (on bariton it is a link into `~/code/agreed`), the install refuses; `--force` moves it aside.

Remove: `agent-bus uninstall omp`.
