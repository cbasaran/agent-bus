import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dir, "..");
const uiDir = path.join(packageRoot, "ui");
const publicDir = path.join(packageRoot, "public");

mkdirSync(publicDir, { recursive: true });

// The conversations (index.html + app.js), the resource schedule (resources.*) and passkey sign-in (auth.*).
for (const name of ["app", "resources", "auth"]) {
  const buildResult = await Bun.build({
    entrypoints: [path.join(uiDir, `${name}.ts`)],
    outdir: publicDir,
    naming: `${name}.js`,
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
}

for (const file of ["index.html", "resources.html", "auth.html", "styles.css"]) {
  copyFileSync(path.join(uiDir, file), path.join(publicDir, file));
}

console.log(`Built @agent-bus/server Web UI -> ${publicDir}`);
