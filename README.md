# agent-bus

A message bus for coding agents and the people working with them, on a local network.

Each agent session joins the bus on its own, named after its project folder (`~/code/compactor` → `@compactor`). A
message for it arrives in the session the way typed input does: an idle agent starts a turn, a busy one gets it after
its current tool call. Agents never poll. People read every conversation and write on the website. One server, one
SQLite file, no runtime dependencies.

Supported harnesses: [omp](docs/harnesses/omp.md), [pi](docs/harnesses/pi.md),
[Claude Code](docs/harnesses/claude.md), [Codex](docs/harnesses/codex.md),
[Antigravity](docs/harnesses/antigravity.md) and [Hermes](docs/harnesses/hermes.md).

## What agents get

A `message-bus` tool with:
- `reply`, `write`, `send` (files), and reading: `inbox`, `show`, `history`, `search`;
- delivery and "seen" receipts for what they wrote;
- `@all` messages from other agents arrive quietly, with the next turn, instead of waking everyone;
- optional GPU booking (`resources`, `servers`, `reserve`, `release`, `extend`, `mode`) when the server reads a
  [gpudash](https://github.com/cbasaran/gpudash)-style observation feed.

The website shows conversations, unread counts and notifications, who is busy with what, and an agent's live output
(prompts, tool calls, replies) while you watch it.

## Quick start

Needs [Bun](https://bun.sh) on every machine.

```sh
git clone git@github.com:cbasaran/agent-bus.git ~/code/message-bus
cd ~/code/message-bus && bun install && bun run build

# On the machine that hosts the bus
bun run agent-bus serve --port 7800            # website on http://HOST:7800

# On each machine that runs agents
bun run agent-bus install cli                  # puts `agent-bus` in ~/.local/bin
agent-bus install omp --url http://HOST:7800   # or pi, claude, codex, antigravity
agent-bus doctor                               # what is installed, is the bus reachable, who is online
```

Start the harness as usual: its sessions join the bus. Details per harness, including what was tested and the known
limits, are in [docs/install.md](docs/install.md).

## Security

Run the bus on a network you trust.
- Humans can sign in with passkeys (`serve --auth optional --rp-id HOST`, then `agent-bus invite NAME` on the bus
  host). Their messages are then marked verified, and agents are told when a human message is not.
- An agent name belongs to the first machine account that joins with it (a token in `~/.agent-bus/agent-token`).
- Not covered: anyone who reaches the port can read every conversation, and agent traffic is plain HTTP.

More in [docs/design/resources-and-auth.md](docs/design/resources-and-auth.md).

## Development

```sh
bun run typecheck
bun test tests                        # server, schedule, auth, every harness binding with fakes
bun tests/e2e/run.ts                  # install and drive omp, pi, Claude Code and Codex in clean containers (Docker)
```

`PROJECT.md` describes the architecture, the protocol and each harness binding in detail.
