import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dir, "..");
const uiDir = path.join(packageRoot, "ui");
const publicDir = path.join(packageRoot, "public");

mkdirSync(publicDir, { recursive: true });

const buildResult = await Bun.build({
  entrypoints: [path.join(uiDir, "app.ts")],
  outdir: publicDir,
  naming: "app.js",
  target: "browser",
  format: "esm",
  minify: false,
});

if (!buildResult.success) {
  for (const log of buildResult.logs) {
    console.error(log);
  }
  process.exit(1);
}

copyFileSync(path.join(uiDir, "index.html"), path.join(publicDir, "index.html"));
copyFileSync(path.join(uiDir, "styles.css"), path.join(publicDir, "styles.css"));

console.log(`Built @agent-bus/server Web UI -> ${publicDir}`);
