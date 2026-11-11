// The website's files: built `public/<asset>` when at least as new as its `ui/` source, else the source (scripts
// bundled on the fly), so an edited `ui/` file shows without `bun run build`.
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { json } from "./http";

const packageRoot = path.resolve(import.meta.dir, "..");
const uiDir = path.join(packageRoot, "ui");
const publicDir = path.join(packageRoot, "public");

const UI_ASSETS: Record<string, { source: string; type: string }> = {
  "index.html": { source: "index.html", type: "text/html; charset=utf-8" },
  "styles.css": { source: "styles.css", type: "text/css; charset=utf-8" },
  "app.js": { source: "app.ts", type: "application/javascript; charset=utf-8" },
  "auth.html": { source: "auth.html", type: "text/html; charset=utf-8" },
  "auth.js": { source: "auth.ts", type: "application/javascript; charset=utf-8" },
};

function mtime(file: string): number {
  return existsSync(file) ? statSync(file).mtimeMs : -1;
}

/**
 * When a source last changed; -1 if it is missing. A script counts as changed when any `ui/*.ts` did, since its
 * bundle includes the modules it imports.
 */
function sourceMtime(source: string): number {
  const own = mtime(path.join(uiDir, source));
  if (own < 0 || !source.endsWith(".ts")) return own;
  const scripts = readdirSync(uiDir).filter((name) => name.endsWith(".ts"));
  return Math.max(own, ...scripts.map((name) => mtime(path.join(uiDir, name))));
}

export class Website {
  /** Scripts bundled from `ui/`, by asset, with the source time they were bundled at. */
  private readonly bundled = new Map<string, { mtime: number; code: string }>();

  /** The response to GET `pathname` when it is a page or one of its files; undefined otherwise. */
  serve(pathname: string): Promise<Response> | undefined {
    if (pathname === "/" || pathname === "/index.html") return this.asset("index.html");
    if (pathname === "/auth") return this.asset("auth.html");
    if (/^\/[a-z]+\.(js|css|html)$/.test(pathname)) return this.asset(pathname.slice(1));
    return undefined;
  }

  private async asset(asset: string): Promise<Response> {
    const spec = UI_ASSETS[asset];
    if (!spec) return new Response("Not found", { status: 404 });
    const sourcePath = path.join(uiDir, spec.source);
    const builtPath = path.join(publicDir, asset);
    const changed = sourceMtime(spec.source);
    const headers = { "Content-Type": spec.type, "Cache-Control": "no-cache" };
    if (existsSync(builtPath) && statSync(builtPath).mtimeMs >= changed) {
      return new Response(Bun.file(builtPath), { headers });
    }
    if (changed < 0) return json({ error: `Website asset ${asset} not found` }, 404);
    if (!spec.source.endsWith(".ts")) return new Response(Bun.file(sourcePath), { headers });
    let cached = this.bundled.get(asset);
    if (!cached || cached.mtime !== changed) {
      const result = await Bun.build({ entrypoints: [sourcePath], target: "browser", format: "esm" });
      const output = result.outputs[0];
      if (!result.success || !output) {
        const detail = result.logs.map((log) => log.message).join("; ");
        return json({ error: `Failed to bundle the website: ${detail}` }, 500);
      }
      cached = { mtime: changed, code: await output.text() };
      this.bundled.set(asset, cached);
    }
    return new Response(cached.code, { headers });
  }
}
