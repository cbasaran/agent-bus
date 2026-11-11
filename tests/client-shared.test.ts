// The client modules the plugins share whose behaviour their own tests do not pin down: the held-message budget, the
// plugin bus URL and the hook socket between hook processes and their server.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HeldQueue, UnseenSeqs } from "../packages/client/src/held";
import { serveHookSocket } from "../packages/client/src/hook-socket";
import { pluginBusUrl, realFolder } from "../packages/client/src/runtime";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "mb-client-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("held texts go out oldest first within the budget, each delivery seen once; a long one is cut", () => {
  const seen: number[] = [];
  const unseen = new UnseenSeqs((seq) => seen.push(seq));
  const held = new HeldQueue(unseen);
  expect(held.take()).toBeUndefined();
  for (const seq of [1, 2, 3]) unseen.add(seq);
  held.push({ text: "a".repeat(5000), seq: 1, wake: true });
  held.push({ text: "b".repeat(5000), seq: 2, wake: false });
  held.push({ text: "receipt notice", wake: false });
  held.unshift({ text: "c".repeat(20_000), seq: 3, wake: true });

  const first = held.take() ?? "";
  expect(first).toStartWith("ccc");
  expect(first).toContain("(cut here; message-bus op=show message_id 3 for all of it)");
  expect(first.length).toBeLessThanOrEqual(9_500);
  expect(seen).toEqual([3]);
  expect(held.take()).toBe("a".repeat(5000)); // a and b together are over the budget
  expect(held.take()).toBe(`${"b".repeat(5000)}\n\nreceipt notice`);
  expect(held.take()).toBeUndefined();
  expect(seen).toEqual([3, 1, 2]);
  expect(unseen.seen(1)).toBe(false);
});

test("held wake deliveries can be taken alone; quiet ones and notices stay", () => {
  const unseen = new UnseenSeqs(() => {});
  const held = new HeldQueue(unseen);
  held.push({ text: "quiet", seq: 1, wake: false });
  held.push({ text: "wake", seq: 2, wake: true });
  held.push({ text: "notice", wake: false });
  expect(held.hasWake()).toBe(true);
  expect(held.takeWake().map((item) => item.text)).toEqual(["wake"]);
  expect(held.hasWake()).toBe(false);
  expect(held.takeWake()).toEqual([]);
  expect(held.take()).toBe("quiet\n\nnotice");
});

test("a plugin's bus URL: AGENT_BUS_URL, else its config.json, else the local bus; folders resolve symlinks", () => {
  const saved = process.env.AGENT_BUS_URL;
  delete process.env.AGENT_BUS_URL;
  try {
    expect(pluginBusUrl(dir)).toBe("http://127.0.0.1:7800");
    writeFileSync(path.join(dir, "config.json"), JSON.stringify({ busUrl: " http://bus:7800// " }));
    expect(pluginBusUrl(dir)).toBe("http://bus:7800");
    process.env.AGENT_BUS_URL = "http://env:7800/";
    expect(pluginBusUrl(dir)).toBe("http://env:7800");
  } finally {
    if (saved === undefined) delete process.env.AGENT_BUS_URL;
    else process.env.AGENT_BUS_URL = saved;
  }
  mkdirSync(path.join(dir, "real"));
  symlinkSync(path.join(dir, "real"), path.join(dir, "link"));
  expect(realFolder(path.join(dir, "link"))).toBe(realFolder(path.join(dir, "real")));
  expect(realFolder(path.join(dir, "missing"))).toBe(path.join(dir, "missing"));
});

/** Runs a hook process that relays its stdin to `socketPath` as is; returns what it prints. */
async function runHook(socketPath: string, input: string): Promise<string> {
  const module = path.join(import.meta.dir, "..", "packages", "client", "src", "hook-socket.ts");
  const code =
    `import { relayHook } from ${JSON.stringify(module)};\n` +
    `await relayHook('{"fallback":true}', (input) => ({ socketPath: ${JSON.stringify(socketPath)}, body: input }));\n`;
  const proc = Bun.spawn([process.execPath, "-e", code], { stdin: new TextEncoder().encode(input), stdout: "pipe" });
  return (await new Response(proc.stdout).text()).trim();
}

test("a hook relays its input to the server's socket and prints the answer; without the server, its fallback", async () => {
  const socketPath = path.join(dir, "hooks", "server.sock");
  expect(await runHook(socketPath, '{"event":"Stop"}')).toBe('{"fallback":true}');

  // A socket file left by a server that did not shut down cleanly is replaced.
  mkdirSync(path.dirname(socketPath));
  writeFileSync(socketPath, "");
  expect(await runHook(socketPath, '{"event":"Stop"}')).toBe('{"fallback":true}');

  const bodies: string[] = [];
  const hooks = serveHookSocket(socketPath, async (body) => {
    bodies.push(body);
    return { answer: JSON.parse(body).event };
  });
  try {
    expect(await runHook(socketPath, '{"event":"Stop"}')).toBe('{"answer":"Stop"}');
    expect(bodies).toEqual(['{"event":"Stop"}']);
  } finally {
    hooks.close();
  }
  expect(existsSync(socketPath)).toBe(false);
});
