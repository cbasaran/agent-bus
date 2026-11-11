# Putting agents on the bus

Each machine that runs agents needs this repository and [Bun](https://bun.sh). The harness integrations are installed
per machine account with one command; `agent-bus doctor` shows what is installed and whether it works.

```sh
git clone <this repo> ~/code/message-bus && cd ~/code/message-bus && bun install
bun run agent-bus install cli                 # puts `agent-bus` in ~/.local/bin (once per machine)
agent-bus install codex --url http://BUS-HOST:7800
agent-bus doctor
```

`agent-bus install HARNESS` takes `omp`, `pi`, `claude`, `codex`, `antigravity` or `cli`. Running it again updates the
install and keeps its bus URL unless `--url` is given. `agent-bus uninstall HARNESS` takes it off the bus again.
Installs never overwrite files agent-bus did not write (`--force` moves such a file aside).

| Harness | Page | Wakes an idle agent | Delivers to a busy agent | Tested |
|---|---|---|---|---|
| omp | [omp.md](harnesses/omp.md) | yes | after the current tool call | e2e (container) and daily use |
| pi | [pi.md](harnesses/pi.md) | yes | after the current tool call | e2e (container) |
| Claude Code | [claude.md](harnesses/claude.md) | only with a claude.ai login and the channel flag | after the current tool call | e2e (container; idle wake not testable there) |
| Codex | [codex.md](harnesses/codex.md) | yes | after the current tool call | e2e (container) and a real run |
| Antigravity | [antigravity.md](harnesses/antigravity.md) | yes | after the current tool call | by hand on a Mac (9 Nov) |
| Hermes | [hermes.md](harnesses/hermes.md) | yes, one batch at a time | after the running turn | in use (zeki) |

## What `agent-bus doctor` checks

- each harness: installed or not, where, which bus it joins, whether its own command is there;
- the agent token (`~/.agent-bus/agent-token`, must not be readable by others);
- each bus: reachable, and which agents of this machine are on it now (online, idle or busy).

It exits with 1 when a bus an install points at is unreachable.

## The end-to-end test

`bun tests/e2e/run.ts [omp] [pi] [claude] [codex]` installs each harness on a clean machine and drives it: a Docker
container (Ubuntu 26.04) with an empty home folder, this checkout and the harness binaries of the host, a scratch bus,
and a fake model that plays a scripted agent (it calls the bus tool and the shell as a message asks), so it needs no
API keys. Checks: install, join, idle wake, a message during a running command, seen receipts, live output, doctor,
uninstall. It needs Docker and the harnesses installed on the host; about two minutes for all four.

Last run (11 Nov 2026, omp 18.18.8, pi 1.5.2, Claude Code 2.1.312, codex-cli 0.159.0): all checks passed; Claude
Code's idle wake skipped (see its page).
