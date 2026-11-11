// A fake model server for the harness end-to-end tests (tests/e2e/run.ts): it speaks OpenAI Chat Completions (omp,
// pi), Anthropic Messages (Claude Code) and OpenAI Responses (Codex), streaming or not, and plays a scripted agent:
// for every bus delivery in the conversation it does what the delivery's text asks ("run the shell command `…`",
// "reply … with: …"), one tool call per model request, then ends the turn. No API keys, no cost, deterministic.
//
//   bun tests/e2e/fake-model.ts [port]        (logs one line per request to stderr; FAKE_MODEL_LOG=file for bodies)
import { appendFileSync } from "node:fs";

/** One step of the conversation, normalized from any of the three APIs. */
interface Item {
  role: "user" | "assistant" | "tool";
  text: string;
  calls?: Array<{ name: string; args: Record<string, unknown> }>;
}

interface ToolSpec {
  name: string;
  params: Record<string, unknown>;
  /** Codex groups MCP tools in namespaces (`mcp__message_bus`); a call to one names its namespace. */
  namespace?: string;
}

type Call = { name: string; args: Record<string, unknown>; namespace?: string };
type Action = { text: string } | { call: Call };

const DELIVERY = /\[message-bus\] #(\d+) @[^\n]*\n([\s\S]*?)(?=\n\(Reply only if|\n\[message-bus\] #|$)/g;

interface Delivery {
  seq: number;
  reply?: string;
  shell?: string;
}

function deliveries(items: Item[]): Delivery[] {
  const found = new Map<number, Delivery>();
  for (const item of items) {
    if (item.role === "assistant") continue;
    for (const m of item.text.matchAll(DELIVERY)) {
      const seq = Number(m[1]);
      const body = m[2] ?? "";
      if (found.has(seq)) continue;
      found.set(seq, {
        seq,
        reply: /with(?: exactly)?: ([^\n]+?)\.?\s*$/m.exec(body)?.[1]?.trim(),
        shell: /run the shell command `([^`]+)`/.exec(body)?.[1],
      });
    }
  }
  return [...found.values()].sort((a, b) => a.seq - b.seq);
}

const isBusTool = (t: ToolSpec): boolean => /message[-_.]?bus/i.test(t.name) && JSON.stringify(t.params).includes('"op"');
const isShellTool = (t: ToolSpec): boolean => /^(bash|shell|shell_command|exec_command|local_shell)$/i.test(t.name);

/** The arguments a shell tool takes for `command`, from its schema. */
function shellArgs(tool: ToolSpec, command: string): Record<string, unknown> {
  const props = (tool.params.properties ?? {}) as Record<string, { type?: string }>;
  if (props.cmd) return { cmd: command };
  if (props.command?.type === "array") return { command: ["bash", "-lc", command] };
  const args: Record<string, unknown> = { command };
  if (props.description) args.description = "e2e test command";
  return args;
}

/** Codex's exec_command returns after a short wait with the command still running unless told to wait longer. */
function shellWait(tool: ToolSpec, args: Record<string, unknown>): Record<string, unknown> {
  const props = (tool.params.properties ?? {}) as Record<string, unknown>;
  return props.yield_time_ms ? { ...args, yield_time_ms: 30_000 } : args;
}

/**
 * How this harness calls the bus tool: directly (`message-bus`, `mcp__…message-bus…`), or, in omp, as a tool device
 * (`write` to `xd://message-bus` with the arguments as JSON content; the system prompt lists the device).
 */
interface BusCall {
  make(args: Record<string, unknown>): Call;
  /** The bus arguments of an earlier call, if it was a bus call. */
  read(call: { name: string; args: Record<string, unknown> }): Record<string, unknown> | undefined;
}

function busCall(items: Item[], tools: ToolSpec[]): BusCall | undefined {
  const direct = tools.find(isBusTool);
  if (direct) {
    return {
      make: (args) => ({ name: direct.name, args, ...(direct.namespace ? { namespace: direct.namespace } : {}) }),
      read: (c) => (c.name === direct.name ? c.args : undefined),
    };
  }
  const write = tools.find((t) => t.name === "write");
  if (!write || !items.some((i) => i.role !== "assistant" && i.text.includes("xd://message-bus"))) return undefined;
  return {
    make: (args) => ({ name: "write", args: { path: "xd://message-bus", content: JSON.stringify(args) } }),
    read: (c) => (c.name === "write" && c.args.path === "xd://message-bus" ? parseArgs(c.args.content) : undefined),
  };
}

/** What the scripted agent does next. */
export function decide(items: Item[], tools: ToolSpec[]): Action {
  const bus = busCall(items, tools);
  if (!bus) return loadDeferredBusTool(items, tools) ?? { text: "ok" };
  const shell = tools.find(isShellTool);
  const calls = items.filter((i) => i.role === "assistant").flatMap((i) => i.calls ?? []);
  const replied = new Set(calls.map((c) => bus.read(c)).filter((a) => a?.op === "reply").map((a) => Number(a?.message_id)));
  const ran = new Set(
    calls
      .filter((c) => shell && c.name === shell.name)
      .map((c) => JSON.stringify(c.args.cmd ?? c.args.command))
  );
  for (const d of deliveries(items)) {
    if (replied.has(d.seq) || !d.reply) continue;
    if (d.shell && shell) {
      const args = shellArgs(shell, d.shell);
      if (!ran.has(JSON.stringify(args.cmd ?? args.command))) return { call: { name: shell.name, args: shellWait(shell, args) } };
    }
    return { call: bus.make({ op: "reply", message_id: d.seq, message: d.reply }) };
  }
  return { text: "done" };
}

/**
 * Claude Code lists MCP tools by name only ("deferred") until the model fetches their schema with ToolSearch: when the
 * bus tool is listed that way and not fetched yet, fetch it.
 */
function loadDeferredBusTool(items: Item[], tools: ToolSpec[]): Action | undefined {
  if (!tools.some((t) => t.name === "ToolSearch")) return undefined;
  const name = items.map((i) => (i.role === "assistant" ? "" : /mcp__[\w.-]*message-bus[\w.-]*/.exec(i.text)?.[0])).find(Boolean);
  if (!name) return undefined;
  const query = `select:${name}`;
  const fetched = items.some((i) => i.calls?.some((c) => c.name === "ToolSearch" && c.args.query === query));
  return fetched ? undefined : { call: { name: "ToolSearch", args: { query, max_results: 1 } } };
}

// ---- Normalizing requests ----

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: Record<string, unknown>) => {
      if (typeof part.text === "string") return part.text;
      if (part.type === "tool_result") return textOf(part.content);
      return "";
    })
    .join("\n");
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") return (raw ?? {}) as Record<string, unknown>;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function chatItems(body: Record<string, any>): { items: Item[]; tools: ToolSpec[] } {
  const items: Item[] = (body.messages ?? []).map((m: any) => ({
    role: m.role === "assistant" ? "assistant" : m.role === "tool" ? "tool" : "user",
    text: textOf(m.content),
    calls: (m.tool_calls ?? []).map((c: any) => ({ name: c.function?.name, args: parseArgs(c.function?.arguments) })),
  }));
  const tools = (body.tools ?? []).map((t: any) => ({ name: t.function?.name ?? t.name, params: t.function?.parameters ?? {} }));
  return { items, tools };
}

function anthropicItems(body: Record<string, any>): { items: Item[]; tools: ToolSpec[] } {
  const items: Item[] = [];
  for (const m of body.messages ?? []) {
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content ?? []);
    items.push({
      role: m.role === "assistant" ? "assistant" : "user",
      text: textOf(blocks),
      calls: blocks.filter((b: any) => b.type === "tool_use").map((b: any) => ({ name: b.name, args: b.input ?? {} })),
    });
  }
  const tools = (body.tools ?? []).filter((t: any) => t.name).map((t: any) => ({ name: t.name, params: t.input_schema ?? {} }));
  return { items, tools };
}

function responsesItems(body: Record<string, any>): { items: Item[]; tools: ToolSpec[] } {
  const items: Item[] = [];
  const input = typeof body.input === "string" ? [{ type: "message", role: "user", content: body.input }] : (body.input ?? []);
  for (const it of input) {
    if (it.type === "function_call") items.push({ role: "assistant", text: "", calls: [{ name: it.name, args: parseArgs(it.arguments) }] });
    else if (it.type === "function_call_output") items.push({ role: "tool", text: textOf(it.output) });
    else if (it.type === "message" || it.role) {
      items.push({ role: it.role === "assistant" ? "assistant" : "user", text: textOf(it.content) });
    }
  }
  const tools: ToolSpec[] = [];
  for (const t of body.tools ?? []) {
    if (t.type === "function" && t.name) tools.push({ name: t.name, params: t.parameters ?? {} });
    if (t.type === "namespace") {
      for (const sub of t.tools ?? []) if (sub.name) tools.push({ name: sub.name, params: sub.parameters ?? {}, namespace: t.name });
    }
  }
  return { items, tools };
}

// ---- Responses ----

let counter = 0;
const id = (prefix: string): string => `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}`;
const sse = (events: Array<[string | undefined, unknown]>, done = false): Response =>
  new Response(
    events.map(([event, data]) => `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`).join("") +
      (done ? "data: [DONE]\n\n" : ""),
    { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } }
  );

function chatResponse(action: Action, body: Record<string, any>): Response {
  const base = { id: id("chatcmpl"), object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model };
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  if (!body.stream) {
    const message =
      "text" in action
        ? { role: "assistant", content: action.text }
        : { role: "assistant", content: null, tool_calls: [{ id: id("call"), type: "function", function: { name: action.call.name, arguments: JSON.stringify(action.call.args) } }] };
    return Response.json({ ...base, object: "chat.completion", choices: [{ index: 0, message, finish_reason: "text" in action ? "stop" : "tool_calls" }], usage });
  }
  const delta =
    "text" in action
      ? { role: "assistant", content: action.text }
      : { role: "assistant", tool_calls: [{ index: 0, id: id("call"), type: "function", function: { name: action.call.name, arguments: JSON.stringify(action.call.args) } }] };
  return sse(
    [
      [undefined, { ...base, choices: [{ index: 0, delta, finish_reason: null }] }],
      [undefined, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "text" in action ? "stop" : "tool_calls" }] }],
      [undefined, { ...base, choices: [], usage }],
    ],
    true
  );
}

function anthropicResponse(action: Action, body: Record<string, any>): Response {
  const msgId = id("msg");
  const block =
    "text" in action
      ? { type: "text", text: action.text }
      : { type: "tool_use", id: id("toolu"), name: action.call.name, input: action.call.args };
  const stop = "text" in action ? "end_turn" : "tool_use";
  const usage = { input_tokens: 10, output_tokens: 5 };
  if (!body.stream) {
    return Response.json({ id: msgId, type: "message", role: "assistant", model: body.model, content: [block], stop_reason: stop, stop_sequence: null, usage });
  }
  const start = "text" in block ? { type: "text", text: "" } : { ...block, input: {} };
  const delta = "text" in block ? { type: "text_delta", text: block.text } : { type: "input_json_delta", partial_json: JSON.stringify(block.input) };
  return sse([
    ["message_start", { type: "message_start", message: { id: msgId, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: start }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } }],
    ["message_stop", { type: "message_stop" }],
  ]);
}

function responsesResponse(action: Action, body: Record<string, any>): Response {
  const respId = id("resp");
  const item =
    "text" in action
      ? { id: id("msg"), type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: action.text, annotations: [] }] }
      : {
          id: id("fc"),
          type: "function_call",
          status: "completed",
          call_id: id("call"),
          name: action.call.name,
          ...(action.call.namespace ? { namespace: action.call.namespace } : {}),
          arguments: JSON.stringify(action.call.args),
        };
  const usage = { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15 };
  const response = { id: respId, object: "response", created_at: Math.floor(Date.now() / 1000), model: body.model, status: "completed", output: [item], usage };
  if (!body.stream) return Response.json(response);
  return sse([
    ["response.created", { type: "response.created", response: { ...response, status: "in_progress", output: [] } }],
    ["response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress" } }],
    ["response.output_item.done", { type: "response.output_item.done", output_index: 0, item }],
    ["response.completed", { type: "response.completed", response }],
  ]);
}

// ---- Server ----

export function startFakeModel(port = 0, log: (line: string) => void = (l) => console.error(l)): { url: string; stop(): void } {
  const bodyLog = process.env.FAKE_MODEL_LOG;
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname.endsWith("/models")) {
        return Response.json({ object: "list", data: [{ id: "fake", object: "model", created: 0, owned_by: "e2e" }] });
      }
      if (req.method !== "POST") return new Response("not found", { status: 404 });
      const body = (await req.json().catch(() => ({}))) as Record<string, any>;
      if (bodyLog) appendFileSync(bodyLog, `${JSON.stringify({ path: url.pathname, body })}\n`);
      if (url.pathname.endsWith("/count_tokens")) return Response.json({ input_tokens: 100 });
      let parsed: { items: Item[]; tools: ToolSpec[] };
      let respond: (a: Action, b: Record<string, any>) => Response;
      if (url.pathname.endsWith("/chat/completions")) [parsed, respond] = [chatItems(body), chatResponse];
      else if (url.pathname.endsWith("/messages")) [parsed, respond] = [anthropicItems(body), anthropicResponse];
      else if (url.pathname.endsWith("/responses")) [parsed, respond] = [responsesItems(body), responsesResponse];
      else return new Response("not found", { status: 404 });
      const action = decide(parsed.items, parsed.tools);
      log(`${url.pathname} ${parsed.items.length} items, ${parsed.tools.length} tools → ${"text" in action ? `text "${action.text}"` : `${action.call.name} ${JSON.stringify(action.call.args)}`}`);
      return respond(action, body);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

if (import.meta.main) {
  const fake = startFakeModel(Number(process.argv[2] ?? 0));
  console.log(`fake model on ${fake.url}`);
}
