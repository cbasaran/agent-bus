import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(scriptsDir, "..");
const srcDir = resolve(pkgRoot, "src");
const distDir = resolve(pkgRoot, "dist");

async function assertBuildSuccess(label: string, output: Bun.BuildOutput): Promise<void> {
  if (output.success) {
    return;
  }
  const details = output.logs.map((log) => log.message || String(log)).join("\n");
  throw new Error(`Failed building ${label}:\n${details}`);
}

async function buildExtension(): Promise<void> {
  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });

  const [bgBuild, panelBuild, contentBuild] = await Promise.all([
    Bun.build({
      entrypoints: [resolve(srcDir, "background.ts")],
      outdir: distDir,
      target: "browser",
      format: "esm",
      splitting: false,
      naming: "background.js",
    }),
    Bun.build({
      entrypoints: [resolve(srcDir, "panel.ts")],
      outdir: distDir,
      target: "browser",
      format: "esm",
      splitting: false,
      naming: "panel.js",
    }),
    Bun.build({
      entrypoints: [resolve(srcDir, "content.ts")],
      outdir: distDir,
      target: "browser",
      format: "iife",
      splitting: false,
      naming: "content.js",
    }),
  ]);

  await assertBuildSuccess("background.ts", bgBuild);
  await assertBuildSuccess("panel.ts", panelBuild);
  await assertBuildSuccess("content.ts", contentBuild);

  await Promise.all([
    copyFile(resolve(pkgRoot, "manifest.json"), resolve(distDir, "manifest.json")),
    copyFile(resolve(srcDir, "panel.html"), resolve(distDir, "panel.html")),
    copyFile(resolve(srcDir, "panel.css"), resolve(distDir, "panel.css")),
  ]);
}

await buildExtension();
