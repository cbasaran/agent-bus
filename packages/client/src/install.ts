// Shared by the harness installers (`agent-bus install <harness>`, packages/cli/src/harnesses.ts). Runs on Bun
// (`Bun.build`, `Bun.which`); the bundled plugin code never imports it.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";

/** What `agent-bus install <harness>` passes to a harness's installer. */
export interface InstallOptions {
  /** The bus URL (`--url`). */
  url?: string;
  /** Where to install instead of the harness's default (`--dir`). */
  dir?: string;
  /** Write the plugin files without registering them with the harness (`--build-only`). */
  buildOnly?: boolean;
  /** Replace a file at the install path that agent-bus did not write (`--force`; it is moved aside). */
  force?: boolean;
}

/** One harness's install, as `agent-bus doctor` reports it. */
export interface InstallStatus {
  installed: boolean;
  /** The file or folder the install lives in. */
  where: string;
  /** The bus URL it joins (absent: not installed, or the install does not say). */
  busUrl?: string;
  /** Anything else worth knowing (not registered with the harness, installed by something else, …). */
  notes: string[];
}

export const DEFAULT_INSTALL_URL = "http://127.0.0.1:7800";

/**
 * The bus the plugin joins: --url, else the URL of the install being replaced (so installing again only updates),
 * else AGENT_BUS_URL, else local. AGENT_BUS_URL comes after the old install's URL because agent sessions export it to
 * every command they run: an update run from an agent's shell must not move the install to that agent's bus.
 */
export function installBusUrl(previousConfig: string, url?: string): string {
  return (url ?? configBusUrl(previousConfig) ?? process.env.AGENT_BUS_URL ?? DEFAULT_INSTALL_URL).replace(/\/+$/, "");
}

/** `busUrl` of an installed plugin's config.json, if there is one. */
export function configBusUrl(configFile: string): string | undefined {
  if (!existsSync(configFile)) return undefined;
  try {
    return (JSON.parse(readFileSync(configFile, "utf8")) as { busUrl?: string }).busUrl;
  } catch {
    return undefined;
  }
}

/** The JS runtime the harness should start: node if installed (absolute: a GUI app's PATH may lack it), else bun. */
export function jsRuntime(): string {
  return Bun.which("node") ?? process.execPath;
}

/** Bundles each `[entry, name]` (entry relative to `root`) into a self-contained `<outdir>/<name>.mjs` for Node. */
export async function bundleForNode(
  root: string,
  outdir: string,
  entries: ReadonlyArray<readonly [entry: string, name: string]>
): Promise<void> {
  for (const [entry, name] of entries) {
    const result = await Bun.build({
      entrypoints: [path.join(root, entry)],
      outdir,
      target: "node",
      format: "esm",
      naming: `${name}.mjs`,
    });
    if (!result.success) throw new AggregateError(result.logs, `Building ${entry} failed`);
  }
}

export function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** The `name` in a JSON manifest, if the file is there and readable. */
export function manifestName(manifest: string): string | undefined {
  if (!existsSync(manifest)) return undefined;
  try {
    return (JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }).name;
  } catch {
    return undefined;
  }
}

/**
 * Removes an earlier install at `dir`, only one agent-bus wrote: its `manifest` (a JSON file in it) names `name`.
 * Anything else stops the install.
 */
export function removeOwnedDir(dir: string, manifest: string, name: string, kind: "marketplace" | "plugin"): void {
  if (!existsSync(dir)) return;
  if (manifestName(manifest) !== name) throw new Error(`${dir} exists and is not the ${name} ${kind}; not touching it.`);
  rmSync(dir, { recursive: true });
}

/** In the first comment line of every single file agent-bus writes (extension loaders, the CLI wrapper): marks it ours. */
export const OWNED_MARK = "agent-bus install";

/**
 * Writes `file` (`mode` for executables), replacing an earlier one agent-bus wrote. Anything else there (a file or link
 * someone else put there) stops the install, unless `force`: then it is moved aside to `<file>.before-agent-bus`.
 */
export function writeOwnedFile(file: string, content: string, force = false, mode = 0o644): void {
  let present = false;
  try {
    lstatSync(file);
    present = true;
  } catch {
    // Not there yet.
  }
  if (present && !isOwnedFile(file)) {
    if (!force) throw new Error(`${file} exists and was not written by agent-bus; not touching it (--force moves it aside).`);
    renameSync(file, `${file}.before-agent-bus`);
    console.log(`Moved the existing ${file} to ${file}.before-agent-bus.`);
  }
  mkdirSync(path.dirname(file), { recursive: true });
  if (present && isOwnedFile(file)) rmSync(file);
  writeFileSync(file, content, { mode });
}

/**
 * Whether `file` is a regular file agent-bus wrote: the mark in its first line, or its second after a `#!` line.
 * A link is never ours: it points at someone else's file.
 */
export function isOwnedFile(file: string): boolean {
  try {
    if (!lstatSync(file).isFile()) return false;
    const [first = "", second = ""] = readFileSync(file, "utf8").split("\n", 2);
    return (first.startsWith("#!") ? second : first).includes(OWNED_MARK);
  } catch {
    return false;
  }
}

export interface Cli {
  /** Whether the CLI is on PATH. */
  readonly present: boolean;
  /** Runs the CLI; a failure is returned, not thrown. */
  run(...args: string[]): { ok: boolean; out: string };
  /** Runs the CLI; a failure throws with its output. */
  must(...args: string[]): void;
}

/** The harness's CLI (`claude`, `codex`); `product` names it when it is not installed. */
export function harnessCli(command: string, product: string): Cli {
  const run = (...args: string[]): { ok: boolean; out: string } => {
    const res = spawnSync(command, args, { encoding: "utf8" });
    if (res.error) throw new Error(`Could not run ${command} (${res.error.message}); is ${product} installed?`);
    return { ok: res.status === 0, out: `${res.stdout ?? ""}${res.stderr ?? ""}`.trim() };
  };
  return {
    get present() {
      return Bun.which(command) !== null;
    },
    run,
    must(...args) {
      const res = run(...args);
      if (!res.ok) throw new Error(`${command} ${args.join(" ")} failed:\n${res.out}`);
    },
  };
}

/** METADATA for a folder an installer creates (team rule: every created folder says who made it and why). */
export function writeMetadata(dir: string, harness: string, reason: string): void {
  writeFileSync(
    path.join(dir, "METADATA"),
    `created by: agent-bus install ${harness}\ncreated: ${new Date().toISOString()}\nreason: ${reason}\n` +
      `delete: with agent-bus uninstall ${harness}\n`
  );
}
