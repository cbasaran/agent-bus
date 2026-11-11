// `agent-bus install|uninstall <harness>` and the per-harness part of `agent-bus doctor`. omp and pi load a small
// extension file that imports this checkout's extension source; Claude Code, Codex and Antigravity get a bundled
// plugin copy (their packages' scripts/install.ts); `cli` puts an `agent-bus` command on PATH.
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as antigravity from "../../antigravity-plugin/scripts/install";
import * as claude from "../../claude-plugin/scripts/install";
import {
  DEFAULT_INSTALL_URL,
  isOwnedFile,
  OWNED_MARK,
  writeOwnedFile,
  type InstallOptions,
  type InstallStatus,
} from "../../client/src/install";
import * as codex from "../../codex-plugin/scripts/install";

const REPO = path.resolve(import.meta.dir, "..", "..", "..");

export interface Harness {
  /** What `agent-bus install <name>` takes. */
  name: string;
  /** What it is, for help and doctor. */
  title: string;
  /** The harness's own command, when it has one (doctor says whether it is on PATH). */
  command?: string;
  /** Where the harness's installer puts its command when that is not on PATH (pi: ~/.pi/agent/bin/pi). */
  commandAt?: string;
  install(opts: InstallOptions): Promise<void>;
  uninstall(opts: InstallOptions): Promise<void>;
  status(opts: InstallOptions): InstallStatus;
}

/** The URL an extension loader sets (`process.env.AGENT_BUS_URL ??= "…"`), if it sets one. */
function loaderUrl(source: string): string | undefined {
  return /AGENT_BUS_URL \?\?= "([^"]+)"/.exec(source)?.[1];
}

/**
 * omp and pi: an extension file in the harness's extensions folder that imports this checkout's extension, so sessions
 * pick up changes to the checkout at their next start. It sets the bus URL unless AGENT_BUS_URL is set.
 */
function loaderHarness(name: "omp" | "pi", title: string, defaultDir: string): Harness {
  const entry = path.join(REPO, "packages", `${name}-extension`, "src", "index.ts");
  const fileOf = (opts: InstallOptions): string => path.join(path.resolve(opts.dir ?? defaultDir), "agent-bus.ts");
  return {
    name,
    title,
    command: name,
    commandAt: name === "pi" ? path.join(os.homedir(), ".pi", "agent", "bin", "pi") : undefined,
    async install(opts) {
      const file = fileOf(opts);
      const previous = existsSync(file) ? loaderUrl(readFileSync(file, "utf8")) : undefined;
      const url = (opts.url ?? previous ?? process.env.AGENT_BUS_URL ?? DEFAULT_INSTALL_URL).replace(/\/+$/, "");
      const source = [
        `// ${OWNED_MARK} ${name}: every interactive ${name} session joins the message bus as its project folder and gets`,
        `// the message-bus tool. It loads ${entry} (this checkout), so sessions pick up changes at their next start.`,
        `// Remove with: agent-bus uninstall ${name}`,
        `import { existsSync } from "node:fs";`,
        ``,
        `const entry = ${JSON.stringify(entry)};`,
        `process.env.AGENT_BUS_URL ??= ${JSON.stringify(url)};`,
        ``,
        `interface Api {`,
        `  on(event: "session_start", handler: (event: unknown, ctx: { ui?: { notify(m: string, l: "warning"): void } }) => void): void;`,
        `}`,
        ``,
        `export default async function agentBus(api: Api): Promise<void> {`,
        `  if (!existsSync(entry)) {`,
        `    api.on("session_start", (_event, ctx) => ctx.ui?.notify(\`message-bus: not on the bus, \${entry} not found\`, "warning"));`,
        `    return;`,
        `  }`,
        `  const mod = (await import(entry)) as { default: (api: unknown) => void | Promise<void> };`,
        `  await mod.default(api);`,
        `}`,
        ``,
      ].join("\n");
      writeOwnedFile(file, source, opts.force);
      console.log(`Installed ${file} (bus ${url}); new ${name} sessions join the bus.`);
    },
    async uninstall(opts) {
      const file = fileOf(opts);
      if (!existsSync(file)) {
        console.log(`Nothing to remove: ${file} is not there.`);
        return;
      }
      if (!isOwnedFile(file)) throw new Error(`${file} was not written by agent-bus; not touching it.`);
      rmSync(file);
      console.log(`Removed ${file}; new ${name} sessions no longer join the bus.`);
    },
    status(opts) {
      const file = fileOf(opts);
      if (!existsSync(file)) return { installed: false, where: file, notes: [] };
      const source = readFileSync(file, "utf8");
      const notes: string[] = [];
      if (!isOwnedFile(file)) notes.push(`not written by agent-bus (${realpathSync(file)})`);
      const imported = /const entry = (?:"([^"]+)"|path\.join\(os\.homedir\(\), "([^"]+)"\))/.exec(source);
      const target = imported?.[1] ?? (imported?.[2] ? path.join(os.homedir(), imported[2]) : undefined);
      if (target && !existsSync(target)) notes.push(`loads ${target}, which is missing`);
      return { installed: source.includes(`${name}-extension`), where: file, busUrl: loaderUrl(source), notes };
    },
  };
}

/** `agent-bus` on PATH (~/.local/bin by default): a wrapper that runs this checkout's CLI with this Bun. */
const cliHarness: Harness = {
  name: "cli",
  title: "the agent-bus command",
  async install(opts) {
    const file = path.join(path.resolve(opts.dir ?? path.join(os.homedir(), ".local", "bin")), "agent-bus");
    const script = `#!/bin/sh\n# ${OWNED_MARK} cli: runs the agent-bus CLI of ${REPO}\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(path.join(REPO, "packages", "cli", "src", "bin.ts"))} "$@"\n`;
    writeOwnedFile(file, script, opts.force, 0o755);
    const onPath = (process.env.PATH ?? "").split(path.delimiter).includes(path.dirname(file));
    console.log(`Installed ${file}.${onPath ? "" : ` Add ${path.dirname(file)} to PATH to run it as agent-bus.`}`);
  },
  async uninstall(opts) {
    const file = path.join(path.resolve(opts.dir ?? path.join(os.homedir(), ".local", "bin")), "agent-bus");
    if (!isOwnedFile(file)) throw new Error(`${file} was not written by agent-bus; not touching it.`);
    rmSync(file);
    console.log(`Removed ${file}.`);
  },
  status(opts) {
    const file = path.join(path.resolve(opts.dir ?? path.join(os.homedir(), ".local", "bin")), "agent-bus");
    if (!existsSync(file)) return { installed: false, where: file, notes: [] };
    const notes = isOwnedFile(file) ? [] : ["not written by agent-bus install cli"];
    return { installed: true, where: file, notes };
  },
};

const pluginHarness = (
  name: string,
  title: string,
  command: string | undefined,
  module: { install(o: InstallOptions): Promise<void>; uninstall(o: InstallOptions): Promise<void>; status(o: InstallOptions): InstallStatus }
): Harness => ({ name, title, command, install: module.install, uninstall: module.uninstall, status: module.status });

export const HARNESSES: readonly Harness[] = [
  loaderHarness("omp", "omp (oh-my-pi)", path.join(os.homedir(), ".omp", "agent", "extensions")),
  loaderHarness("pi", "pi (pi-coding-agent)", path.join(os.homedir(), ".pi", "agent", "extensions")),
  pluginHarness("claude", "Claude Code", "claude", claude),
  pluginHarness("codex", "Codex", "codex", codex),
  pluginHarness("antigravity", "Antigravity", undefined, antigravity),
  cliHarness,
];

export function harness(name: string): Harness {
  const found = HARNESSES.find((h) => h.name === name);
  if (!found) throw new Error(`Unknown harness "${name}". Known: ${HARNESSES.map((h) => h.name).join(", ")}`);
  return found;
}
