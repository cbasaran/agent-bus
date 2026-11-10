import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isJsonObject } from "@agent-bus/protocol";
import type {
  AgentServerFrame,
  Conversation,
  FileRef,
  Message,
  MessagesResponse,
  Participant,
  PostMessageResponse,
  StateResponse,
  ViewerServerFrame,
} from "@agent-bus/protocol";
import { createBusServer, groupConversationId, type BusServerHandle } from "@agent-bus/server";

type Frame = AgentServerFrame | ViewerServerFrame;
type DeliverFrame = Extract<AgentServerFrame, { type: "deliver" }>;

/** A real WebSocket client that queues frames so tests can await them in order. */
class Client {
  private readonly queue: Frame[] = [];
  private waiter: { type: Frame["type"]; resolve: (frame: Frame) => void } | null = null;
  private readonly closed = Promise.withResolvers<void>();

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as Frame;
      if (this.waiter && this.waiter.type === frame.type) {
        const { resolve } = this.waiter;
        this.waiter = null;
        resolve(frame);
        return;
      }
      this.queue.push(frame);
    });
    ws.addEventListener("close", () => this.closed.resolve());
  }

  static async connect(url: string): Promise<Client> {
    const ws = new WebSocket(url);
    const client = new Client(ws);
    const opened = Promise.withResolvers<void>();
    ws.addEventListener("open", () => opened.resolve(), { once: true });
    ws.addEventListener("error", () => opened.reject(new Error(`WebSocket ${url} failed`)), { once: true });
    await opened.promise;
    return client;
  }

  /** Removes and returns the first frame of `type`, waiting for it if none is queued. */
  take<T extends Frame["type"]>(type: T): Promise<Extract<Frame, { type: T }>> {
    const index = this.queue.findIndex((frame) => frame.type === type);
    if (index >= 0) {
      const [frame] = this.queue.splice(index, 1);
      return Promise.resolve(frame as Extract<Frame, { type: T }>);
    }
    const { promise, resolve } = Promise.withResolvers<Frame>();
    this.waiter = { type, resolve };
    return promise as Promise<Extract<Frame, { type: T }>>;
  }

  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }

  get closedPromise(): Promise<void> {
    return this.closed.promise;
  }

  async close(): Promise<void> {
    this.ws.close();
    await this.closed.promise;
  }
}

let dataDir = "";
let bus: BusServerHandle;
const clients: Client[] = [];

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "mb-server-test-"));
  bus = createBusServer({ host: "127.0.0.1", port: 0, dataDir, humans: ["can", "umit"] });
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await bus.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

const wsUrl = (route: string): string => `${bus.url.replace(/^http/, "ws")}${route}`;

async function joinAgent(query: Record<string, string>): Promise<{ client: Client; id: string }> {
  const client = await Client.connect(wsUrl(`/ws/agent?${new URLSearchParams(query)}`));
  clients.push(client);
  const joined = await client.take("joined");
  return { client, id: joined.id };
}

const joinPath = (projectPath: string, host = "h1") => joinAgent({ host, harness: "omp", path: projectPath });

async function leave(client: Client): Promise<void> {
  clients.splice(clients.indexOf(client), 1);
  await client.close();
}

async function post(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${bus.url}/api/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function send(body: Record<string, unknown>): Promise<PostMessageResponse> {
  const res = await post(body);
  if (!res.ok) throw new Error(`POST /api/messages ${res.status}: ${await res.text()}`);
  return (await res.json()) as PostMessageResponse;
}

async function setSetting(from: string, key: string, value: unknown): Promise<Response> {
  return fetch(`${bus.url}/api/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, key, value }),
  });
}

async function state(): Promise<StateResponse> {
  return (await (await fetch(`${bus.url}/api/state`)).json()) as StateResponse;
}

async function errorOf(res: Response): Promise<string> {
  const body: unknown = await res.json();
  if (!isJsonObject(body) || typeof body.error !== "string") throw new Error(`No error in ${JSON.stringify(body)}`);
  return body.error;
}

describe("agent ids", () => {
  test("id comes from the folder and is stable for the same host+path", async () => {
    const first = await joinPath("/tmp/x/alpha");
    expect(first.id).toBe("alpha");
    await leave(first.client);
    const again = await joinPath("/tmp/x/alpha");
    expect(again.id).toBe("alpha");
  });

  test("an id already held is qualified by the first part of the address that differs", async () => {
    const a = await joinPath("/tmp/a/proj");
    const b = await joinPath("/tmp/b/proj");
    expect(a.id).toBe("proj");
    expect(b.id).toBe("proj@b");
    const mac = await joinPath("/Users/cbasaran/code/proj", "macbook-pro-2.home");
    expect(mac.id).toBe("proj@macbook-pro-2");
    // Same qualifier again (a third tree under /tmp/b): numeric suffix.
    const deeper = await joinPath("/tmp/b/x/proj");
    expect(deeper.id).toBe("proj@b-2");
    // The qualified id is an address like any other.
    const sent = await send({ from: "can", to: "@{proj@macbook-pro-2,proj}", text: "both of you" });
    expect(sent.conversation.addressed).toEqual(["can", "proj", "proj@macbook-pro-2"]);
    expect((await mac.client.take("deliver")).replyTo).toBe("@{can,proj}");
  });

  test("human ids are never taken by agents", async () => {
    const agent = await joinPath("/home/someone/can");
    expect(agent.id).toBe("can@h1");
    const participants = (await state()).participants;
    expect(participants.find((p) => p.id === "can")?.kind).toBe("human");
  });

  test("name joins are stable per host and coexist with path joins", async () => {
    const zeki = await joinAgent({ host: "omarchy", harness: "hermes", name: "zeki" });
    expect(zeki.id).toBe("zeki");
    const folder = await joinPath("/srv/zeki", "omarchy");
    expect(folder.id).toBe("zeki@srv");
    const otherHost = await joinAgent({ host: "h2", harness: "hermes", name: "zeki" });
    expect(otherHost.id).toBe("zeki@h2");
    await leave(zeki.client);
    const again = await joinAgent({ host: "omarchy", harness: "hermes", name: "zeki" });
    expect(again.id).toBe("zeki");

    const participant = (await state()).participants.find((p) => p.id === "zeki");
    expect(participant?.harness).toBe("hermes");
    expect(participant?.host).toBe("omarchy");
    expect(participant?.path).toBeUndefined();
    expect(participant?.online).toBe(true);
  });

  test("a join without exactly one of path/name gets an error frame and is closed", async () => {
    const both = await Client.connect(wsUrl("/ws/agent?host=h1&path=/tmp/x/a&name=a"));
    expect((await both.take("error")).error).toContain("exactly one");
    await both.closedPromise;
    const neither = await Client.connect(wsUrl("/ws/agent?host=h1"));
    expect((await neither.take("error")).error).toContain("exactly one");
    await neither.closedPromise;
  });
});

describe("delivery", () => {
  test("every live socket of an id receives; @all from a human wakes", async () => {
    const one = await joinPath("/tmp/x/alpha");
    const two = await joinPath("/tmp/x/alpha");
    expect(two.id).toBe(one.id);
    const participant = (await state()).participants.find((p) => p.id === "alpha");
    expect(participant?.connections).toBe(2);

    const { message } = await send({ from: "can", to: "@all", text: "hello" });
    for (const client of [one.client, two.client]) {
      const frame = await client.take("deliver");
      expect(frame.message.id).toBe(message.id);
      expect(frame.conversation.id).toBe("all");
      expect(frame.replyTo).toBe("@all");
      expect(frame.wake).toBe(true);
    }
  });

  test("@all from an agent is quiet by default and wakes after the setting", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const beta = await joinPath("/tmp/x/beta");

    await send({ from: beta.id, to: "@all", text: "quiet one" });
    expect((await alpha.client.take("deliver")).wake).toBe(false);

    const res = await setSetting(alpha.id, "all", "wake");
    expect(res.status).toBe(200);
    const { participant } = (await res.json()) as { participant: Participant };
    expect(participant.settings.all).toBe("wake");

    await send({ from: beta.id, to: "@all", text: "loud one" });
    expect((await alpha.client.take("deliver")).wake).toBe(true);
  });

  test("invalid settings name the valid ones", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const badKey = await setSetting(alpha.id, "volume", "wake");
    expect(badKey.status).toBe(400);
    expect(await errorOf(badKey)).toContain("all");
    const badValue = await setSetting(alpha.id, "all", "loud");
    expect(badValue.status).toBe(400);
    const error = await errorOf(badValue);
    expect(error).toContain("wake");
    expect(error).toContain("quiet");
  });

  test("the writer never receives its own message", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const beta = await joinPath("/tmp/x/beta");
    await send({ from: alpha.id, to: "@all", text: "mine" });
    await send({ from: alpha.id, to: `@${beta.id}`, text: "mine too" });
    const sentinel = await send({ from: "can", to: "@all", text: "sentinel" });
    expect((await alpha.client.take("deliver")).message.id).toBe(sentinel.message.id);
  });

  test("groups are reused for the same set regardless of order", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const beta = await joinPath("/tmp/x/beta");
    const first = await send({ from: "can", to: "@{beta,alpha}", text: "one" });
    const second = await send({ from: "can", to: "@{alpha, beta}", text: "two" });
    expect(first.conversation.id).toBe(second.conversation.id);
    expect(first.conversation.kind).toBe("group");
    expect(first.conversation.addressed).toEqual(["alpha", "beta", "can"]);
    expect(first.conversation.id).toBe(groupConversationId(["alpha", "beta"]));

    const toAlpha = await alpha.client.take("deliver");
    expect(toAlpha.replyTo).toBe("@{beta,can}");
    expect(toAlpha.wake).toBe(true);
    const toBeta = await beta.client.take("deliver");
    expect(toBeta.replyTo).toBe("@{alpha,can}");

    // The same agents without the human: still that thread.
    const direct = await send({ from: alpha.id, to: "@beta", text: "direct" });
    expect(direct.conversation.id).toBe(first.conversation.id);
    expect((await beta.client.take("deliver")).message.id).toBe(second.message.id);
    expect((await beta.client.take("deliver")).replyTo).toBe("@{alpha,can}");
  });

  test("one thread per set of agents: humans never split it, and a human an agent writes to joins it", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const beta = await joinPath("/tmp/x/beta");
    const fromCan = await send({ from: "can", to: "@alpha", text: "can here" });
    const fromUmit = await send({ from: "umit", to: "@alpha", text: "umit here" });
    const fromAlpha = await send({ from: alpha.id, to: "@{can,umit}", text: "to both" });
    expect(fromUmit.conversation.id).toBe(fromCan.conversation.id);
    expect(fromAlpha.conversation.id).toBe(fromCan.conversation.id);
    expect(fromAlpha.conversation.members).toEqual(["alpha", "can", "umit"]);

    // A different set of agents is a different thread; so is a humans-only one.
    expect((await send({ from: "can", to: "@{alpha,beta}", text: "x" })).conversation.id).not.toBe(fromCan.conversation.id);
    expect((await send({ from: beta.id, to: "@can", text: "x" })).conversation.id).not.toBe(fromCan.conversation.id);
    const humans = await send({ from: "can", to: "@umit", text: "just us" });
    expect(humans.conversation.members).toEqual(["can", "umit"]);
    expect((await send({ from: "umit", to: "@can", text: "yes" })).conversation.id).toBe(humans.conversation.id);
  });

  test("threads that share their agents are merged at startup; the merged id stays a working alias", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const kept = await send({ from: "can", to: "@alpha", text: "kept thread" });
    await leave(alpha.client);
    await bus.stop();
    // A thread from before the rule: same agent (alpha), other human, older and smaller.
    const raw = new Database(path.join(dataDir, "message-bus.sqlite"));
    raw.exec("DROP INDEX conversations_thread_key");
    raw.query("INSERT INTO conversations (id, kind, addressed_json, created_at, last_message_at) VALUES ('g_old', 'group', '[\"alpha\",\"umit\"]', 1, 1)").run();
    raw.query("INSERT INTO conversation_members VALUES ('g_old', 'alpha'), ('g_old', 'umit')").run();
    raw.query("INSERT INTO messages (id, conversation_id, from_id, from_kind, text, files_json, created_at) VALUES ('m_old', 'g_old', 'umit', 'human', 'old thread', '[]', 1)").run();
    raw.close();

    bus = createBusServer({ host: "127.0.0.1", port: 0, dataDir, humans: ["can", "umit"] });
    const groups = (await state()).conversations.filter((c) => c.kind === "group");
    expect(groups.map((c) => c.id)).toEqual([kept.conversation.id]);
    expect(groups[0]?.members).toEqual(["alpha", "can", "umit"]);
    const page = (await (await fetch(`${bus.url}/api/conversations/g_old/messages`)).json()) as MessagesResponse;
    expect(page.messages.map((m) => m.text)).toEqual(["kept thread", "old thread"]);
    await joinPath("/tmp/x/alpha"); // only online agents get messages
    const byOldId = await send({ from: "umit", conversationId: "g_old", text: "still works" });
    expect(byOldId.conversation.id).toBe(kept.conversation.id);
  });

  test("a human who joins an agents' group by writing is in every reply address, and replies stay in that group", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const beta = await joinPath("/tmp/x/beta");
    const gamma = await joinPath("/tmp/x/gamma");
    const started = await send({ from: alpha.id, to: `@${beta.id}`, text: "hi beta" });
    expect(started.conversation.members).toEqual(["alpha", "beta"]);
    expect((await beta.client.take("deliver")).replyTo).toBe("@alpha");

    const joined = await send({ from: "umit", conversationId: started.conversation.id, text: "did you read this?" });
    expect(joined.conversation.addressed).toEqual(["alpha", "beta"]);
    expect(joined.conversation.members).toEqual(["alpha", "beta", "umit"]);
    const toAlpha = await alpha.client.take("deliver");
    expect(toAlpha.message.from).toBe("umit");
    expect(toAlpha.replyTo).toBe("@{beta,umit}");

    // The agent replies to the address it was given: same conversation, and the human's page gets it.
    const answer = await send({ from: alpha.id, to: toAlpha.replyTo, text: "yes, read" });
    expect(answer.conversation.id).toBe(started.conversation.id);
    // So does an agent that writes to the members in another order, or a member writing by id.
    expect((await send({ from: beta.id, to: "@{umit,alpha}", text: "me too" })).conversation.id).toBe(started.conversation.id);
    expect((await send({ from: alpha.id, conversationId: started.conversation.id, text: "by id" })).conversation.id).toBe(
      started.conversation.id
    );
    // The original address still means this conversation: the human stays in it once she has joined.
    const original = await send({ from: alpha.id, to: "@beta", text: "original address" });
    expect(original.conversation.id).toBe(started.conversation.id);

    const outsider = await post({ from: gamma.id, conversationId: started.conversation.id, text: "let me in" });
    expect(outsider.status).toBe(403);
  });

  test("unknown targets and self-only addresses are rejected", async () => {
    await joinPath("/tmp/x/alpha");
    const unknown = await post({ from: "can", to: "@{alpha,nobody}", text: "hi" });
    expect(unknown.status).toBe(400);
    const error = await errorOf(unknown);
    expect(error).toContain("nobody");
    expect(error).toContain("alpha");
    expect(error).toContain("can");

    expect((await post({ from: "alpha", to: "@alpha", text: "me" })).status).toBe(400);
    expect((await post({ from: "can", to: "@all", conversationId: "all", text: "x" })).status).toBe(400);
    expect((await post({ from: "stranger", to: "@all", text: "x" })).status).toBe(400);
    expect((await post({ from: "can", to: "@all", text: "  " })).status).toBe(400);
  });
});

describe("backlog", () => {
  test("only online agents get messages: @all skips an offline agent, a message to it is refused; unacked ones come back on rejoin", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    await joinPath("/tmp/x/beta");
    await send({ from: "alpha", to: "@can", text: "taking part" }); // agents that never took part are forgotten on logoff

    const acked = await send({ from: "can", to: "@all", text: "seen" });
    const seen = await alpha.client.take("deliver");
    expect(seen.message.id).toBe(acked.message.id);
    alpha.client.send({ type: "ack", seq: seen.message.seq });
    // Delivered but not acknowledged when the connection drops: it comes again on rejoin.
    const unacked = await send({ from: "umit", to: "@alpha", text: "not acked" });
    expect((await alpha.client.take("deliver")).message.id).toBe(unacked.message.id);
    await leave(alpha.client);

    const whileAway = await send({ from: "umit", to: "@all", text: "while away" });
    expect(whileAway.message.receipts.map((r) => r.to)).toEqual(["beta"]);
    const refused = await post({ from: "beta", to: "@alpha", text: "dm while away" });
    expect(refused.status).toBe(409);
    expect(await errorOf(refused)).toContain("@alpha is offline");
    expect((await post({ from: "umit", conversationId: unacked.conversation.id, text: "reply while away" })).status).toBe(409);

    const back = await joinPath("/tmp/x/alpha");
    expect((await back.client.take("deliver")).message.id).toBe(unacked.message.id);
    const sentinel = await send({ from: "can", to: "@all", text: "live again" });
    expect((await back.client.take("deliver")).message.id).toBe(sentinel.message.id);
  });

  test("a brand-new agent gets no history", async () => {
    await joinPath("/tmp/x/beta");
    await send({ from: "can", to: "@all", text: "before you came" });
    const fresh = await joinPath("/tmp/x/fresh");
    const sentinel = await send({ from: "can", to: "@all", text: "welcome" });
    expect((await fresh.client.take("deliver")).message.id).toBe(sentinel.message.id);
  });
});

describe("http", () => {
  test("files round-trip and are attached to delivered messages", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const bytes = new Uint8Array(300_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) % 256;
    const upload = await fetch(`${bus.url}/api/files?from=can&name=${encodeURIComponent("report ü.bin")}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-test" },
      body: bytes,
    });
    expect(upload.status).toBe(200);
    const { file } = (await upload.json()) as { file: FileRef };
    expect(file.size).toBe(bytes.length);
    expect(file.sha256).toBe(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
    expect(file.mimeType).toBe("application/x-test");
    expect(file.name).toBe("report ü.bin");

    const download = await fetch(`${bus.url}/api/files/${file.id}`);
    expect(download.headers.get("content-type")).toBe("application/x-test");
    expect(download.headers.get("content-disposition")).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent("report ü.bin")}`
    );
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);

    const sent = await send({ from: "can", to: "@alpha", text: "", fileIds: [file.id] });
    expect(sent.message.files).toEqual([file]);
    const frame = await alpha.client.take("deliver");
    expect(frame.message.files).toEqual([file]);

    expect((await post({ from: "can", to: "@alpha", text: "x", fileIds: ["f_missing"] })).status).toBe(400);
    expect((await fetch(`${bus.url}/api/files/f_missing`)).status).toBe(404);
  });

  test("viewers get participants and message frames", async () => {
    const viewer = await Client.connect(wsUrl("/ws/viewer"));
    clients.push(viewer);
    const initial = await viewer.take("participants");
    expect(initial.participants.map((p) => p.id)).toEqual(["can", "umit"]);

    const alpha = await joinPath("/tmp/x/alpha");
    const joined = await viewer.take("participants");
    expect(joined.participants[0]).toMatchObject({ id: "alpha", online: true, connections: 1 });

    const { message } = await send({ from: "can", to: "@all", text: "for the website" });
    const frame = await viewer.take("message");
    expect(frame.message.id).toBe(message.id);
    expect(frame.conversation.id).toBe("all");

    await send({ from: "alpha", to: "@can", text: "taking part" });
    await leave(alpha.client);
    const left = await viewer.take("participants");
    expect(left.participants.find((p) => p.id === "alpha")).toMatchObject({ online: false, connections: 0 });
  });

  test("state, paging and health", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const sent: Message[] = [];
    for (let i = 0; i < 5; i++) sent.push((await send({ from: "can", to: "@all", text: `m${i}` })).message);
    const group = await send({ from: "umit", to: "@alpha", text: "dm" });
    await alpha.client.take("deliver");

    const snapshot = await state();
    expect(snapshot.humans).toEqual(["can", "umit"]);
    expect(snapshot.participants[0]?.id).toBe("alpha");
    expect(snapshot.conversations.map((c: Conversation) => c.id)).toEqual(["all", group.conversation.id]);

    const page = (await (
      await fetch(`${bus.url}/api/conversations/all/messages?beforeSeq=${sent[4]?.seq}&limit=2`)
    ).json()) as MessagesResponse;
    expect(page.messages.map((m) => m.text)).toEqual(["m2", "m3"]);
    expect((await fetch(`${bus.url}/api/conversations/g_nope/messages`)).status).toBe(404);

    const health = await fetch(`${bus.url}/api/health`);
    expect(health.headers.get("access-control-allow-origin")).toBe("*");
    expect(await health.json()).toMatchObject({ ok: true, version: "2.0.0" });
  });
});

describe("delivery receipts", () => {
  const getMessage = async (seq: number, waitMs = 0) =>
    ((await (await fetch(`${bus.url}/api/messages/${seq}?waitMs=${waitMs}`)).json()) as { message: Message }).message;

  test("each recipient's ack marks only that message delivered; viewers and the writer agent get receipt frames", async () => {
    const viewer = await Client.connect(wsUrl("/ws/viewer"));
    clients.push(viewer);
    const alpha = await joinPath("/tmp/x/alpha");
    const beta = await joinPath("/tmp/x/beta");

    const { message } = await send({ from: "alpha", to: "@{beta,can}", text: "first" });
    expect(message.receipts).toEqual([{ to: "beta", deliveredAt: null, seenAt: null }]);
    const second = (await send({ from: "alpha", to: "@{beta,can}", text: "second" })).message;
    expect((await beta.client.take("deliver")).message.seq).toBe(message.seq);
    expect((await beta.client.take("deliver")).message.seq).toBe(second.seq);

    // Acking the second message does not mark the first one.
    beta.client.send({ type: "ack", seq: second.seq });
    const toWriter = await alpha.client.take("receipt");
    expect(toWriter).toMatchObject({ seq: second.seq, to: "beta", conversationId: message.conversationId, seenAt: null });
    expect(await viewer.take("receipt")).toMatchObject({ seq: second.seq, to: "beta" });
    expect((await getMessage(message.seq)).receipts[0]?.deliveredAt).toBeNull();
    expect((await getMessage(second.seq)).receipts[0]?.deliveredAt).toBeNumber();

    // The unacked first message comes back on rejoin although a later seq was acked.
    await leave(beta.client);
    const betaAgain = await joinPath("/tmp/x/beta");
    expect((await betaAgain.client.take("deliver")).message.seq).toBe(message.seq);
  });

  test("seen marks the receipt seen (and delivered); repeats change nothing", async () => {
    const viewer = await Client.connect(wsUrl("/ws/viewer"));
    clients.push(viewer);
    const beta = await joinPath("/tmp/x/beta");
    const { message } = await send({ from: "can", to: "@beta", text: "look at this" });
    await beta.client.take("deliver");

    beta.client.send({ type: "ack", seq: message.seq });
    const delivered = await viewer.take("receipt");
    expect(delivered).toMatchObject({ seq: message.seq, to: "beta", seenAt: null });

    beta.client.send({ type: "seen", seq: message.seq });
    const seen = await viewer.take("receipt");
    expect(seen.seenAt).toBeNumber();
    expect(seen.deliveredAt).toBe(delivered.deliveredAt);

    // A seen without a prior ack also counts as delivered; a repeated seen sends no frame.
    const { message: second } = await send({ from: "can", to: "@beta", text: "and this" });
    await beta.client.take("deliver");
    beta.client.send({ type: "seen", seq: second.seq });
    beta.client.send({ type: "seen", seq: second.seq });
    const onlyOnce = await viewer.take("receipt");
    expect(onlyOnce.seq).toBe(second.seq);
    expect(onlyOnce.deliveredAt).toBe(onlyOnce.seenAt!);
    const { message: third } = await send({ from: "can", to: "@beta", text: "third" });
    await beta.client.take("deliver");
    beta.client.send({ type: "ack", seq: third.seq });
    expect((await viewer.take("receipt")).seq).toBe(third.seq); // the repeated seen produced nothing in between
  });

  test("@all receipts list every online agent but the writer; waitMs returns once all are delivered", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const beta = await joinPath("/tmp/x/beta");
    const gone = await joinPath("/tmp/x/gone");
    await send({ from: "gone", to: "@can", text: "taking part" });
    await leave(gone.client);

    const { message } = await send({ from: "can", to: "@all", text: "hello all" });
    expect(message.receipts.map((r) => r.to)).toEqual(["alpha", "beta"]);
    alpha.client.send({ type: "ack", seq: (await alpha.client.take("deliver")).message.seq });

    // Not everyone has it yet: the wait times out and reports beta pending.
    const partial = await getMessage(message.seq, 50);
    expect(partial.receipts.map((r) => [r.to, r.deliveredAt !== null])).toEqual([["alpha", true], ["beta", false]]);

    const waiting = getMessage(message.seq, 10_000);
    beta.client.send({ type: "ack", seq: (await beta.client.take("deliver")).message.seq });
    expect((await waiting).receipts.every((r) => r.deliveredAt !== null)).toBe(true);

    expect((await fetch(`${bus.url}/api/messages/999`)).status).toBe(404);
  });

  test("conversation pages carry receipts", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const { message } = await send({ from: "umit", to: "@alpha", text: "dm" });
    alpha.client.send({ type: "ack", seq: (await alpha.client.take("deliver")).message.seq });
    await getMessage(message.seq, 10_000);
    const page = (await (await fetch(`${bus.url}/api/conversations/${message.conversationId}/messages`)).json()) as MessagesResponse;
    expect(page.messages[0]?.receipts[0]).toMatchObject({ to: "alpha" });
    expect(page.messages[0]?.receipts[0]?.deliveredAt).toBeNumber();
  });
});

describe("agents that never took part", () => {
  test("are forgotten when their last connection logs off; agents that wrote or are in a group stay", async () => {
    const scratch = await joinPath("/tmp/x/scratch");
    const twice = await joinPath("/tmp/x/twice");
    const twiceAgain = await joinPath("/tmp/x/twice");
    const writer = await joinPath("/tmp/x/writer");
    const addressed = await joinPath("/tmp/x/addressed");

    const all = await send({ from: "can", to: "@all", text: "hello" });
    expect(all.message.receipts.map((r) => r.to)).toEqual(["addressed", "scratch", "twice", "writer"]);
    await send({ from: "writer", to: "@can", text: "I wrote" });
    await send({ from: "umit", to: "@addressed", text: "you are in a group now" });

    const ids = async () => (await state()).participants.filter((p) => p.kind === "agent").map((p) => p.id);
    await leave(scratch.client);
    await leave(twice.client);
    await leave(writer.client);
    await leave(addressed.client);
    // twice still has a connection; scratch is gone, with its receipt.
    expect(await ids()).toEqual(["twice", "addressed", "writer"]);
    const after = (await (await fetch(`${bus.url}/api/messages/${all.message.seq}`)).json()) as { message: Message };
    expect(after.message.receipts.map((r) => r.to)).toEqual(["addressed", "twice", "writer"]);

    await leave(twiceAgain.client);
    expect(await ids()).toEqual(["addressed", "writer"]);
    const unknown = await post({ from: "can", to: "@scratch", text: "still there?" });
    expect(unknown.status).toBe(400);

    // A returning folder simply joins again under the same id.
    expect((await joinPath("/tmp/x/scratch")).id).toBe("scratch");
  });

  test("are swept at server start (nobody is connected then)", async () => {
    const idle = await joinPath("/tmp/x/idle");
    const active = await joinPath("/tmp/x/active");
    await send({ from: "active", to: "@can", text: "hi" });
    // Stop without a clean logoff for idle: the server stops with both connected.
    clients.splice(clients.indexOf(idle.client), 1);
    clients.splice(clients.indexOf(active.client), 1);
    await bus.stop();
    bus = createBusServer({ host: "127.0.0.1", port: 0, dataDir, humans: ["can", "umit"] });
    expect((await state()).participants.filter((p) => p.kind === "agent").map((p) => p.id)).toEqual(["active"]);
  });
});

describe("reply quotes", () => {
  test("a replyToSeq message carries a quote of the original, in pages, deliveries and after restart", async () => {
    const alpha = await joinPath("/tmp/x/alpha");
    const long = "x".repeat(400);
    const original = (await send({ from: "can", to: "@alpha", text: `please check run 7 ${long}` })).message;
    await alpha.client.take("deliver");

    const reply = await send({ from: "alpha", replyToSeq: original.seq, text: "run 7 is fine" });
    expect(reply.message.quote?.seq).toBe(original.seq);
    expect(reply.message.quote?.from).toBe("can");
    expect(reply.message.quote?.text.length).toBe(280);
    expect(reply.message.quote?.text.endsWith("…")).toBe(true);
    expect(reply.message.quote?.files).toBe(0);

    // Agents receive the quote with the delivery.
    const human = await send({ from: "can", replyToSeq: reply.message.seq, text: "thanks" });
    const delivered = await alpha.client.take("deliver");
    expect(delivered.message.seq).toBe(human.message.seq);
    expect(delivered.message.quote).toEqual({ seq: reply.message.seq, from: "alpha", text: "run 7 is fine", files: 0 });

    // Ordinary messages have no quote; pages carry quotes.
    const plain = await send({ from: "can", to: "@alpha", text: "no quote" });
    expect(plain.message.quote).toBeUndefined();
    const page = (await (await fetch(`${bus.url}/api/conversations/${original.conversationId}/messages`)).json()) as MessagesResponse;
    expect(page.messages.map((m) => m.quote?.seq ?? null)).toEqual([null, original.seq, reply.message.seq, null]);

    // The quote survives a restart (it is stored as the replied-to number and resolved on read).
    clients.splice(clients.indexOf(alpha.client), 1);
    await bus.stop();
    bus = createBusServer({ host: "127.0.0.1", port: 0, dataDir, humans: ["can", "umit"] });
    const after = (await (await fetch(`${bus.url}/api/messages/${human.message.seq}`)).json()) as { message: Message };
    expect(after.message.quote?.seq).toBe(reply.message.seq);
  });
});
