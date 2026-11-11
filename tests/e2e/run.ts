// End-to-end test of `agent-bus install <harness>` on a clean machine, for the harnesses that run on Linux.
//
//   bun tests/e2e/run.ts [omp] [pi] [claude] [codex]     (default: all four; needs Docker and the harnesses on PATH)
//
// Per harness: a container from tests/e2e/Dockerfile with an empty HOME, this checkout, Bun and the host's harness
// binaries mounted read-only; a scratch bus and the fake model (tests/e2e/fake-model.ts) on the host. In the container:
// `agent-bus install cli`, then `agent-bus install <harness> --url <scratch bus>`, a model config pointing at the fake
// model, the harness started interactively in tmux in a project folder. Then, over the bus's HTTP API:
//   join      the session joins as its folder (`<harness>-e2e`, harness name right)
//   idle      a message to the idle agent starts a turn; the reply comes back through the bus tool
//   busy      a message sent while it runs `sleep 12` is answered in the same run, after the command
//   seen      receipts of both messages are seen
//   live      a website viewer watching it gets live-output entries
//   doctor    `agent-bus doctor` in the container lists the install and the agent
//   uninstall `agent-bus uninstall <harness>` removes it
// Prompts the harness asks on first use (trust this folder, hooks, tool approval) are answered from tmux.
// Exit code 1 if any check fails. Leaves nothing behind (containers, temp folders), except with E2E_KEEP=1.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ActivityEvent, Participant } from "@agent-bus/protocol";
import { createBusServer } from "@agent-bus/server";
import { startFakeModel } from "./fake-model";

const REPO = path.resolve(import.meta.dir, "..", "..");
const IMAGE = "agent-bus-e2e:1";
const HOME = "/home/e2e";
const SCRATCH_ROOT = path.join(homedir(), ".cache", "agent-bus-e2e");
mkdirSync(SCRATCH_ROOT, { recursive: true });
if (!existsSync(path.join(SCRATCH_ROOT, "METADATA"))) {
  writeFileSync(
    path.join(SCRATCH_ROOT, "METADATA"),
    `created by: message-bus tests/e2e/run.ts\ncreated: ${new Date().toISOString()}\nreason: per-run scratch folders (HOME of the test container, scratch bus); each run deletes its own\ndelete: any time no e2e run is going\n`
  );
}

interface HarnessSpec {
  /** Host files to mount read-only: [host path, container path]. */
  mounts(): Array<[string, string]>;
  /** Shell run in the container before `agent-bus install` (the harness's command on PATH, config the install edits). */
  preInstall?: (fakeUrl: string, project: string) => string;
  /** Shell run in the container (as the test user, HOME set) after `agent-bus install`: model config, trust. */
  setup(fakeUrl: string, project: string): string;
  /** The interactive command started in tmux in the project folder. */
  command: string;
  /** Prompts to answer as they appear: [pattern on screen, tmux keys]. */
  prompts: Array<[RegExp, string[]]>;
  /** Some harnesses join on their first turn only (Codex): a prompt typed once after the start. */
  kickoff?: string;
  /**
   * When an idle agent may not be able to start a turn by itself here, a prompt typed after a message so the held
   * message reaches the model with it, and why the wake path may be unavailable (reported as skipped, not failed).
   */
  nudge?: { prompt: string; why: string };
}

const which = (cmd: string): string => {
  const found = Bun.which(cmd);
  if (!found) throw new Error(`${cmd} is not on PATH`);
  return realpathSync(found);
};

const SPECS: Record<string, HarnessSpec> = {
  omp: {
    mounts: () => [[which("omp"), "/usr/local/bin/omp"]],
    setup: (fake) =>
      `mkdir -p ~/.omp/agent && cat > ~/.omp/agent/models.yml <<'EOF'
providers:
  fake:
    baseUrl: "${fake}/v1"
    api: openai-completions
    apiKey: fake
    models:
      - id: fake
        name: Fake
        contextWindow: 128000
        maxTokens: 4096
EOF`,
    command: "omp --model fake/fake",
    // First start: a six-step setup wizard (sign-in, model, glyphs, layout, theme, updates); Escape skips each step.
    prompts: [[/Setup step \d+ of \d+/, ["Escape"]]],
  },
  pi: {
    mounts: () => [
      [path.join(homedir(), ".pi", "agent", "install"), `${HOME}/.pi/agent/install`],
      [path.join(homedir(), ".pi", "agent", "bin"), `${HOME}/.pi/agent/bin`],
    ],
    setup: (fake) =>
      `mkdir -p ~/.pi/agent && cat > ~/.pi/agent/models.json <<'EOF'
{ "providers": { "fake": { "baseUrl": "${fake}/v1", "api": "openai-completions", "apiKey": "fake",
  "models": [{ "id": "fake", "name": "Fake", "contextWindow": 128000, "maxTokens": 4096 }] } } }
EOF`,
    command: `${HOME}/.pi/agent/bin/pi --model fake/fake`,
    prompts: [],
  },
  claude: {
    mounts: () => [[which("claude"), "/usr/local/bin/claude"]],
    setup: (fake, project) =>
      `cat > ~/.claude.json <<EOF
{ "hasCompletedOnboarding": true, "bypassPermissionsModeAccepted": true,
  "customApiKeyResponses": { "approved": ["e2e-fake-key-000000"], "rejected": [] },
  "projects": { "${project}": { "hasTrustDialogAccepted": true, "hasCompletedProjectOnboarding": true } } }
EOF
echo 'export ANTHROPIC_BASE_URL=${fake} ANTHROPIC_API_KEY=sk-ant-e2e-fake-key-000000 DISABLE_AUTOUPDATER=1' > ~/.e2e-env`,
    command: "claude --dangerously-load-development-channels plugin:message-bus@agent-bus --dangerously-skip-permissions",
    // Claude Code 2.1.312 with an API key (the fake model) says "Channels are not currently available" and ignores the
    // channel flag, so bus messages cannot start a turn by themselves; with a claude.ai login they can.
    nudge: { prompt: "Check the message bus.", why: "channels are unavailable in API-key sessions (Claude Code: \"Channels are not currently available\")" },
    prompts: [
      [/I am using this for local development/, ["Enter"]],
      [/Yes, I accept/, ["Down", "Enter"]],
      [/Do you want to use this API key/, ["Up", "Enter"]],
      [/Do you trust the files in this folder|Yes, proceed/, ["Enter"]],
    ],
  },
  codex: {
    mounts: () => [[path.dirname(path.dirname(which("codex"))), "/opt/codex"]],
    // Before the install: `agent-bus install codex` registers the plugin in config.toml, which this must not overwrite.
    preInstall: (fake, project) =>
      `ln -sf /opt/codex/bin/codex.js ~/.local/bin/codex && mkdir -p ~/.codex && cat > ~/.codex/config.toml <<'EOF'
model = "fake"
model_provider = "fake"
approval_policy = "never"
sandbox_mode = "danger-full-access"
check_for_update_on_startup = false

[model_providers.fake]
name = "fake"
base_url = "${fake}/v1"
wire_api = "responses"
env_key = "FAKE_MODEL_KEY"

[projects."${project}"]
trust_level = "trusted"
EOF`,
    setup: () => "echo 'export FAKE_MODEL_KEY=fake' > ~/.e2e-env",
    command: "codex",
    prompts: [
      [/Trust this folder\?/, ["Enter"]],
      [/Hooks need review/, ["2", "Enter"]],
      [/Allow the message-bus MCP server/, ["3", "Enter"]],
      [/Run without daemon this time/, ["1", "Enter"]],
      [/Update available/, ["2", "Enter"]],
    ],
    kickoff: "Reply with just: ready",
  },
};

// ---- Plumbing ----

function sh(cmd: string[], input?: string): { ok: boolean; out: string } {
  const res = spawnSync(cmd[0] as string, cmd.slice(1), { encoding: "utf8", input });
  return { ok: res.status === 0, out: `${res.stdout ?? ""}${res.stderr ?? ""}`.trim() };
}

/** Runs a command without blocking: the scratch bus and the fake model live in this process's event loop. */
async function shAsync(cmd: string[]): Promise<{ ok: boolean; out: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { ok: code === 0, out: `${out}${err}`.trim() };
}

class Box {
  constructor(readonly name: string) {}
  /** Runs `script` in the container as the test user, with ~/.e2e-env sourced. */
  run(script: string): Promise<{ ok: boolean; out: string }> {
    return shAsync(["docker", "exec", "-i", this.name, "bash", "-lc", `[ -f ~/.e2e-env ] && . ~/.e2e-env; export PATH=$HOME/.local/bin:$PATH; ${script}`]);
  }
  async screen(): Promise<string> {
    return (await shAsync(["docker", "exec", this.name, "tmux", "capture-pane", "-p", "-t", "h"])).out;
  }
  async keys(...keys: string[]): Promise<void> {
    await shAsync(["docker", "exec", this.name, "tmux", "send-keys", "-t", "h", ...keys]);
  }
}

const sleep = (ms: number) => Bun.sleep(ms);

async function until<T>(what: string, timeoutMs: number, probe: () => Promise<T | undefined> | T | undefined): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    await sleep(500);
  }
  throw new Error(`timed out (${Math.round(timeoutMs / 1000)} s) waiting for ${what}`);
}

// ---- One harness ----

interface Check {
  name: string;
  ok: boolean;
  /** Not run (the harness cannot do it in this setup); does not count as a failure. */
  skipped?: boolean;
  detail: string;
}

async function runHarness(name: string): Promise<Check[]> {
  const spec = SPECS[name];
  if (!spec) throw new Error(`No e2e spec for ${name}. Known: ${Object.keys(SPECS).join(", ")}`);
  const checks: Check[] = [];
  const check = (n: string, ok: boolean, detail: string) => {
    checks.push({ name: n, ok, detail });
    console.log(`  ${ok ? "✓" : "✗"} ${n}: ${detail}`);
  };
  const skip = (n: string, why: string) => {
    checks.push({ name: n, ok: true, skipped: true, detail: why });
    console.log(`  – ${n}: skipped: ${why}`);
  };

  // Not under /tmp: the Docker daemon runs with its own /tmp and would mount an empty folder.
  const scratch = mkdtempSync(path.join(SCRATCH_ROOT, `${name}-`));
  const home = path.join(scratch, "home");
  mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
  // Mount points inside HOME exist before the container starts, so Docker does not create them (and their parents)
  // as root, which would leave HOME's folders unwritable for the test user and the scratch folder undeletable.
  for (const [, to] of spec.mounts()) {
    if (to.startsWith(`${HOME}/`)) mkdirSync(path.join(home, to.slice(HOME.length + 1)), { recursive: true });
  }
  const bus = createBusServer({ host: "127.0.0.1", port: 0, dataDir: path.join(scratch, "bus"), humans: ["tester"] });
  const fake = startFakeModel(0, (line) => process.env.E2E_VERBOSE && console.log(`    model ${line}`));
  const box = new Box(`mb-e2e-${name}-${process.pid}`);
  const project = `${HOME}/work/${name}-e2e`;
  const agentId = `${name}-e2e`;
  const uid = `${process.getuid?.()}:${process.getgid?.()}`;
  let answering = true;

  try {
    const mounts = [
      [REPO, REPO],
      [realpathSync(process.execPath), "/usr/local/bin/bun"],
      ...spec.mounts(),
    ].flatMap(([from, to]) => ["-v", `${from}:${to}:ro`]);
    const started = sh(["docker", "run", "-d", "--rm", "--name", box.name, "--network", "host", "--user", uid, "-e", `HOME=${HOME}`, "-v", `${home}:${HOME}`, ...mounts, IMAGE, "sleep", "infinity"]);
    if (!started.ok) throw new Error(`docker run: ${started.out}`);

    // Install: the CLI wrapper first, then the harness through it, as a user would.
    if (spec.preInstall) {
      const pre = await box.run(`mkdir -p ${project} && ${spec.preInstall(fake.url, project)}`);
      if (!pre.ok) throw new Error(`preInstall: ${pre.out}`);
    }
    const cli = await box.run(`bun ${REPO}/packages/cli/src/bin.ts install cli`);
    const install = await box.run(`agent-bus install ${name} --url ${bus.url}`);
    check("install", cli.ok && install.ok, (install.out || cli.out).split("\n").slice(-1)[0] ?? "");
    if (!install.ok) {
      console.log(install.out);
      return checks;
    }
    const setup = await box.run(`mkdir -p ${project} && ${spec.setup(fake.url, project)}`);
    if (!setup.ok) throw new Error(`setup: ${setup.out}`);
    await box.run(`cd ${project} && tmux new-session -d -s h -x 200 -y 50 "bash -lc '[ -f ~/.e2e-env ] && . ~/.e2e-env; export PATH=\\$HOME/.local/bin:\\$PATH; ${spec.command}'"`);

    // Answer first-use prompts for as long as the test runs.
    void (async () => {
      while (answering) {
        const screen = await box.screen();
        for (const [pattern, keys] of spec.prompts) {
          if (pattern.test(screen)) {
            await box.keys(...keys);
            await sleep(800);
            break;
          }
        }
        await sleep(700);
      }
    })();

    const participant = async (): Promise<Participant | undefined> =>
      ((await (await fetch(`${bus.url}/api/state`)).json()) as { participants: Participant[] }).participants.find((p) => p.id === agentId);
    const typePrompt = async (text: string) => {
      await box.keys("-l", text);
      await sleep(300);
      await box.keys("Enter");
    };
    if (spec.kickoff) {
      await sleep(8000);
      await typePrompt(spec.kickoff);
    }
    try {
      const joined = await until("the agent to join", 90_000, async () => {
        const p = await participant();
        return p?.online ? p : undefined;
      });
      check("join", joined.harness === name, `@${joined.id}, harness ${joined.harness}, ${joined.path}`);
    } catch (error) {
      check("join", false, `${(error as Error).message}\n${await box.screen()}`);
      return checks;
    }
    await until("the agent to be idle", 60_000, async () => ((await participant())?.status?.state === "busy" ? undefined : true)).catch(() => true);

    const post = async (body: Record<string, unknown>) => {
      const res = await fetch(`${bus.url}/api/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return (await res.json()) as { message: { seq: number }; conversation: { id: string } };
    };
    const replyTo = (conversation: string, seq: number, timeoutMs: number) =>
      until(`a reply to #${seq}`, timeoutMs, async () => {
        const page = (await (await fetch(`${bus.url}/api/conversations/${conversation}/messages`)).json()) as {
          messages: Array<{ from: string; text: string; quote?: { seq: number }; createdAt: number }>;
        };
        return page.messages.find((m) => m.from === agentId && m.quote?.seq === seq);
      });

    // Idle: a message starts a turn. Harnesses whose own wake path may be unavailable here (spec.nudge) get a typed
    // prompt after a while instead; the message must then reach the model with that prompt.
    const a = await post({ from: "tester", to: `@${agentId}`, text: "Test A: reply to this message with the message-bus tool (op reply) with exactly: pong A" });
    const t0 = Date.now();
    try {
      const reply = await replyTo(a.conversation.id, a.message.seq, spec.nudge ? 50_000 : 90_000);
      check("idle", reply.text === "pong A", `"${reply.text}" after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    } catch (error) {
      if (!spec.nudge) {
        check("idle", false, `${(error as Error).message}\n${await box.screen()}`);
      } else {
        skip("idle", spec.nudge.why);
        await typePrompt(spec.nudge.prompt);
        try {
          const reply = await replyTo(a.conversation.id, a.message.seq, 60_000);
          check("next prompt", reply.text === "pong A", `held, then handed over with a typed prompt: "${reply.text}"`);
        } catch (err) {
          check("next prompt", false, `${(err as Error).message}\n${await box.screen()}`);
        }
      }
    }

    // Busy: a message sent while the agent runs a command joins that run.
    await until("the agent to be idle", 30_000, async () => ((await participant())?.status?.state === "busy" ? undefined : true)).catch(() => true);
    const b = await post({ from: "tester", conversationId: a.conversation.id, text: "Test B: run the shell command `sleep 12 && echo slept` now, then reply to this message (op reply) with: done B" });
    if (spec.nudge) {
      await sleep(3000);
      if ((await participant())?.status?.state !== "busy") await typePrompt(spec.nudge.prompt);
    }
    let busyTool = "";
    try {
      busyTool = await until("the agent to run a tool", 60_000, async () => {
        const s = (await participant())?.status;
        return s?.state === "busy" && s.tool ? s.tool : undefined;
      });
    } catch {
      busyTool = "(no tool seen)";
    }
    const c = await post({ from: "tester", conversationId: a.conversation.id, text: "Test C (sent while you are busy): reply to this message (op reply) with exactly: pong C" });
    const sentC = Date.now();
    try {
      const [rb, rc] = await Promise.all([replyTo(a.conversation.id, b.message.seq, 120_000), replyTo(a.conversation.id, c.message.seq, 120_000)]);
      check("busy", rb.text === "done B" && rc.text === "pong C", `status busy with ${busyTool}; C sent then, answered after ${((rc.createdAt - sentC) / 1000).toFixed(1)} s ("${rc.text}"), B "${rb.text}"`);
    } catch (error) {
      check("busy", false, `${(error as Error).message}\n${await box.screen()}`);
    }

    // Seen receipts.
    const receipts = await Promise.all(
      [a, c].map(async (m) => {
        const got = (await (await fetch(`${bus.url}/api/messages/${m.message.seq}?waitMs=5000&until=seen`)).json()) as {
          message: { receipts: Array<{ to: string; deliveredAt: number | null; seenAt: number | null }> };
        };
        return got.message.receipts.find((r) => r.to === agentId);
      })
    );
    check("seen", receipts.every((r) => r?.seenAt), receipts.map((r, i) => `#${[a, c][i]?.message.seq} ${r?.seenAt ? "seen" : r?.deliveredAt ? "delivered only" : "not delivered"}`).join(", "));

    // Live output: a viewer watching the agent gets entries (replayed recent steps at least).
    const events = await new Promise<ActivityEvent[]>((resolve) => {
      const got: ActivityEvent[] = [];
      const ws = new WebSocket(`${bus.url.replace(/^http/, "ws")}/ws/viewer`);
      ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "watch", agentId })));
      ws.addEventListener("message", (e) => {
        const frame = JSON.parse(String(e.data)) as { type: string; events?: ActivityEvent[] };
        if (frame.type === "activity") got.push(...(frame.events ?? []));
      });
      setTimeout(() => {
        ws.close();
        resolve(got);
      }, 4000);
    });
    const kinds = [...new Set(events.map((e) => e.kind))].join(", ");
    check("live", events.length > 0, events.length > 0 ? `${events.length} entries (${kinds})` : "no live-output entries");

    const doctor = await box.run("agent-bus doctor");
    const doctorOk = doctor.out.includes(`✓ ${name}:`) && doctor.out.includes(`@${agentId}`);
    const doctorLines = doctor.out.split("\n").filter((l) => l.includes(`${name}:`) || l.includes(`@${agentId}`));
    check("doctor", doctorOk, doctorOk ? doctorLines.map((l) => l.trim()).join(" | ") : doctor.out);

    answering = false;
    await box.keys("C-c");
    await sleep(300);
    await box.keys("C-c");
    const removed = await box.run(`agent-bus uninstall ${name} && agent-bus doctor | grep -- '- ${name}: not installed'`);
    check("uninstall", removed.ok, removed.out.split("\n")[0] ?? "");
  } finally {
    answering = false;
    if (!process.env.E2E_KEEP) {
      sh(["docker", "rm", "-f", box.name]);
      // Files the container wrote belong to this user (--user), so the scratch folder can go.
      rmSync(scratch, { recursive: true, force: true });
    } else {
      console.log(`  kept: container ${box.name}, folder ${scratch}`);
    }
    fake.stop();
    await bus.stop();
  }
  return checks;
}

// ---- Main ----

const names = process.argv.slice(2).length > 0 ? process.argv.slice(2) : Object.keys(SPECS);
if (!sh(["docker", "image", "inspect", IMAGE]).ok) {
  console.log(`Building ${IMAGE} …`);
  const built = sh(["docker", "build", "-q", "-t", IMAGE, import.meta.dir]);
  if (!built.ok) throw new Error(built.out);
}
const summary: Array<[string, Check[]]> = [];
for (const name of names) {
  console.log(`${name}:`);
  try {
    summary.push([name, await runHarness(name)]);
  } catch (error) {
    console.log(`  ✗ ${(error as Error).message}`);
    summary.push([name, [{ name: "run", ok: false, detail: (error as Error).message }]]);
  }
}
const failed = summary.filter(([, checks]) => checks.some((c) => !c.ok)).map(([n]) => n);
console.log(failed.length === 0 ? `All passed: ${names.join(", ")}` : `Failed: ${failed.join(", ")}`);
process.exit(failed.length === 0 ? 0 : 1);
