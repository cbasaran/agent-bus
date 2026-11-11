// Shared by the plugin installers (scripts/install.ts of the Antigravity, Claude Code and Codex plugins). Runs on Bun
// (`Bun.build`, `Bun.which`); the bundled plugin code never imports it.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";

/** The value after `--<name>` on the command line. */
export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

/** The bus the plugin joins: --url, else AGENT_BUS_URL, else the URL of the install being replaced, else local. */
export function installBusUrl(previousConfig: string): string {
  const oldUrl = existsSync(previousConfig)
    ? (JSON.parse(readFileSync(previousConfig, "utf8")) as { busUrl?: string }).busUrl
    : undefined;
  return (arg("url") ?? process.env.AGENT_BUS_URL ?? oldUrl ?? "http://127.0.0.1:7800").replace(/\/+$/, "");
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

/**
 * Removes an earlier install at `dir`, only one this script wrote: its `manifest` (a JSON file in it) names `name`.
 * Anything else stops the install.
 */
export function removeOwnedDir(dir: string, manifest: string, name: string, kind: "marketplace" | "plugin"): void {
  if (!existsSync(dir)) return;
  const found = existsSync(manifest) ? (JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }).name : undefined;
  if (found !== name) throw new Error(`${dir} exists and is not the ${name} ${kind}; not touching it.`);
  rmSync(dir, { recursive: true });
}

export interface Cli {
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
    run,
    must(...args) {
      const res = run(...args);
      if (!res.ok) throw new Error(`${command} ${args.join(" ")} failed:\n${res.out}`);
    },
  };
}
