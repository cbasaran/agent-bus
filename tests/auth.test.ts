// Passkeys end to end against a real bus, with a software authenticator standing in for Face ID / Touch ID.
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Message } from "@agent-bus/protocol";
import { createBusServer, createInvite, type AuthMode, type BusServerHandle } from "@agent-bus/server";
import { formatDelivery } from "../packages/client/src/tool";

// ---- A minimal CBOR encoder (what authenticators emit) ----

type C = number | string | Uint8Array | Map<C, C>;
function head(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 256) return [(major << 5) | 24, n];
  if (n < 65536) return [(major << 5) | 25, n >> 8, n & 255];
  return [(major << 5) | 26, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function cbor(v: C): Uint8Array {
  if (typeof v === "number") return new Uint8Array(v >= 0 ? head(0, v) : head(1, -1 - v));
  if (typeof v === "string") {
    const b = new TextEncoder().encode(v);
    return new Uint8Array([...head(3, b.length), ...b]);
  }
  if (v instanceof Uint8Array) return new Uint8Array([...head(2, v.length), ...v]);
  const parts: number[] = [...head(5, v.size)];
  for (const [k, val] of v) parts.push(...cbor(k), ...cbor(val));
  return new Uint8Array(parts);
}

const b64u = (b: Uint8Array): string => Buffer.from(b).toString("base64url");
const unb64u = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64url"));
const sha = (b: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(b).digest());

class SoftAuthenticator {
  readonly credentialId = new Uint8Array(crypto.getRandomValues(new Uint8Array(16)));
  private readonly privateKey: KeyObject;
  private readonly cose: Map<C, C>;
  counter = 0;
  userHandle = "";

  constructor(
    private readonly origin: string,
    private readonly alg: "ES256" | "EdDSA" | "RS256" = "ES256",
    private readonly synced = false
  ) {
    if (alg === "ES256") {
      const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
      const jwk = publicKey.export({ format: "jwk" });
      this.privateKey = privateKey;
      this.cose = new Map<C, C>([[1, 2], [3, -7], [-1, 1], [-2, unb64u(jwk.x ?? "")], [-3, unb64u(jwk.y ?? "")]]);
    } else if (alg === "EdDSA") {
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      this.privateKey = privateKey;
      this.cose = new Map<C, C>([[1, 1], [3, -8], [-1, 6], [-2, unb64u(publicKey.export({ format: "jwk" }).x ?? "")]]);
    } else {
      const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const jwk = publicKey.export({ format: "jwk" });
      this.privateKey = privateKey;
      this.cose = new Map<C, C>([[1, 3], [3, -257], [-1, unb64u(jwk.n ?? "")], [-2, unb64u(jwk.e ?? "")]]);
    }
  }

  private authData(rpId: string, attested: boolean): Uint8Array {
    if (!this.synced) this.counter++;
    const count = this.counter;
    const base = [...sha(new TextEncoder().encode(rpId)), attested ? 0x45 : 0x05, (count >>> 24) & 255, (count >> 16) & 255, (count >> 8) & 255, count & 255];
    if (!attested) return new Uint8Array(base);
    const id = this.credentialId;
    return new Uint8Array([...base, ...new Uint8Array(16), id.length >> 8, id.length & 255, ...id, ...cbor(this.cose)]);
  }

  private clientData(type: string, challenge: string, origin = this.origin): Uint8Array {
    return new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  create(options: { challenge: string; rp: { id: string }; user: { id: string } }, overrides: { origin?: string; rpId?: string } = {}) {
    this.userHandle = options.user.id;
    const attestationObject = cbor(new Map<C, C>([["fmt", "none"], ["attStmt", new Map()], ["authData", this.authData(overrides.rpId ?? options.rp.id, true)]]));
    return {
      id: b64u(this.credentialId),
      type: "public-key",
      response: { clientDataJSON: b64u(this.clientData("webauthn.create", options.challenge, overrides.origin)), attestationObject: b64u(attestationObject) },
    };
  }

  get(options: { challenge: string; rpId: string }, overrides: { counter?: number } = {}) {
    if (overrides.counter !== undefined) this.counter = overrides.counter - 1;
    const authenticatorData = this.authData(options.rpId, false);
    const clientDataJSON = this.clientData("webauthn.get", options.challenge);
    const data = new Uint8Array([...authenticatorData, ...sha(clientDataJSON)]);
    const signature = sign(this.alg === "EdDSA" ? null : "sha256", data, this.privateKey);
    return {
      id: b64u(this.credentialId),
      type: "public-key",
      response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authenticatorData), signature: b64u(signature), userHandle: this.userHandle },
    };
  }
}

// ---- A bus with passkeys on ----

let bus: BusServerHandle | undefined;
let dataDir = "";

afterEach(async () => {
  await bus?.stop();
  bus = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

function start(mode: AuthMode) {
  dataDir = mkdtempSync(path.join(tmpdir(), "mb-auth-test-"));
  bus = createBusServer({ host: "127.0.0.1", port: 0, dataDir, humans: ["can", "umit"], auth: { mode, rpId: "localhost" } });
  const origin = `http://localhost:${bus.port}`;
  const base = bus.url;
  const invite = (human: string): string => {
    const db = new Database(path.join(dataDir, "message-bus.sqlite"), { strict: true });
    try {
      return createInvite(db, human);
    } finally {
      db.close();
    }
  };
  const call = async (p: string, body?: unknown, cookie?: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${p}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const setCookie = res.headers.get("set-cookie") ?? "";
    return { status: res.status, body: (await res.json()) as Record<string, unknown>, cookie: setCookie.split(";")[0] ?? "" };
  };
  const enroll = async (human: string, authenticator = new SoftAuthenticator(origin)) => {
    const token = invite(human);
    const options = await call("/api/auth/register/options", { invite: token });
    expect(options.status).toBe(200);
    const done = await call("/api/auth/register/verify", { invite: token, credential: authenticator.create(options.body as never) });
    expect(done.status).toBe(200);
    expect(done.cookie).toMatch(/^bus_session=/);
    return { authenticator, cookie: done.cookie, token };
  };
  const login = async (authenticator: SoftAuthenticator, overrides: { counter?: number } = {}) => {
    const options = await call("/api/auth/login/options", {});
    return call("/api/auth/login/verify", { credential: authenticator.get(options.body as never, overrides) });
  };
  return { origin, invite, call, enroll, login };
}

test("enroll with an invite, then messages from the session are verified; other ids and no session are not", async () => {
  const { call, enroll } = start("optional");
  const { cookie } = await enroll("can");
  expect((await call("/api/auth/state", undefined, cookie)).body).toMatchObject({ mode: "optional", me: "can", enrolled: ["can"] });

  const signed = await call("/api/messages", { from: "can", to: "@umit", text: "really me" }, cookie);
  expect((signed.body.message as Message).verified).toBe(true);
  const anon = await call("/api/messages", { from: "can", to: "@umit", text: "anyone" });
  expect((anon.body.message as Message).verified).toBe(false);
  const other = await call("/api/messages", { from: "umit", to: "@can", text: "as umit" }, cookie);
  expect(other.status).toBe(403);
  expect(String(other.body.error)).toContain("signed in as can");
  // A page elsewhere cannot use the session (Origin), even if a browser sent the cookie.
  const foreign = await call("/api/messages", { from: "can", to: "@umit", text: "x" }, cookie, { Origin: "https://evil.example" });
  expect(foreign.status).toBe(403);
  // Another human without a session: allowed while auth is optional, and marked as not verified.
  const agent = await call("/api/messages", { from: "umit", to: "@can", text: "hi" });
  expect((agent.body.message as Message).verified).toBe(false);
});

test("agents see who is verified in the delivery header, and seen-detection still finds it", () => {
  const conversation = { id: "g_1", kind: "group", addressed: ["alpha", "can"], members: ["alpha", "can"] } as never;
  const message = (verified?: boolean): Message => ({ seq: 7, id: "m", conversationId: "g_1", from: "can", fromKind: "human", text: "stop the run", files: [], createdAt: 0, receipts: [], ...(verified === undefined ? {} : { verified }) });
  const text = (verified?: boolean) => formatDelivery({ type: "deliver", message: message(verified), conversation, replyTo: "@can", wake: true } as never, []).split("\n")[0];
  expect(text(true)).toBe("[message-bus] #7 @can (verified) → @{alpha,can} · 1970-01-01 00:00Z");
  expect(text(false)).toContain("@can (NOT verified: anyone on the LAN could have written this) →");
  expect(text(undefined)).toBe("[message-bus] #7 @can → @{alpha,can} · 1970-01-01 00:00Z");
  expect(/\[message-bus\] #(\d+) @/.exec(text(false) ?? "")?.[1]).toBe("7");
});

test("an invite works once and only from the bus's own origin and site", async () => {
  const { call, invite, origin } = start("optional");
  const token = invite("umit");
  const authenticator = new SoftAuthenticator(origin);
  const options = await call("/api/auth/register/options", { invite: token });
  expect((options.body.user as { name: string }).name).toBe("umit");
  const wrongOrigin = authenticator.create(options.body as never, { origin: "https://phish.example" });
  expect((await call("/api/auth/register/verify", { invite: token, credential: wrongOrigin })).status).toBe(400);
  // The challenge was used up by that attempt: a replay fails, a fresh one with the wrong site fails, a right one works.
  expect((await call("/api/auth/register/verify", { invite: token, credential: wrongOrigin })).status).toBe(400);
  const again = await call("/api/auth/register/options", { invite: token });
  const wrongSite = authenticator.create(again.body as never, { rpId: "evil.example" });
  expect(String((await call("/api/auth/register/verify", { invite: token, credential: wrongSite })).body.error)).toContain("another site");
  const third = await call("/api/auth/register/options", { invite: token });
  expect((await call("/api/auth/register/verify", { invite: token, credential: authenticator.create(third.body as never) })).status).toBe(200);
  expect((await call("/api/auth/register/options", { invite: token })).status).toBe(403);
  expect((await call("/api/auth/register/options", { invite: "made-up" })).status).toBe(403);
});

test("sign-in with a discoverable passkey; a counter going backwards (a cloned key) is refused; synced passkeys (always 0) work", async () => {
  const { call, enroll, login, origin } = start("optional");
  const { authenticator } = await enroll("can");
  const first = await login(authenticator);
  expect(first.status).toBe(200);
  expect(first.body.human).toBe("can");
  expect((await call("/api/auth/state", undefined, first.cookie)).body.me).toBe("can");
  expect((await login(authenticator, { counter: 1 })).status).toBe(403);

  const synced = await enroll("umit", new SoftAuthenticator(origin, "ES256", true));
  expect((await login(synced.authenticator)).status).toBe(200);
  expect((await login(synced.authenticator)).status).toBe(200);
});

test("EdDSA and RS256 passkeys work too", async () => {
  const { enroll, login, origin } = start("optional");
  for (const alg of ["EdDSA", "RS256"] as const) {
    const { authenticator } = await enroll(alg === "EdDSA" ? "can" : "umit", new SoftAuthenticator(origin, alg));
    expect((await login(authenticator)).status).toBe(200);
  }
});

test("required: writing as a human needs a session; removing a passkey signs out everywhere", async () => {
  const { call, enroll, login } = start("required");
  expect((await call("/api/messages", { from: "can", to: "@umit", text: "x" })).status).toBe(401);
  const { authenticator, cookie } = await enroll("can");
  expect((await call("/api/messages", { from: "can", to: "@umit", text: "x" }, cookie)).status).toBe(200);
  const second = await login(authenticator);
  const listed = await call("/api/auth/credentials", undefined, cookie);
  const [credential] = listed.body.credentials as Array<{ id: string }>;
  expect((await call(`/api/auth/credentials/${credential?.id}/remove`, {}, cookie)).status).toBe(200);
  expect((await call("/api/auth/state", undefined, second.cookie)).body.me).toBeNull();
  expect((await login(authenticator)).status).toBe(403);
});

test("schedule: a human who is not signed in has no human powers (no booking over capacity, no releasing others' holds)", async () => {
  const { call, enroll } = start("optional");
  await call("/api/resources", { from: "can", kind: "service", host: "spark2", name: "deepseek" });
  await call("/api/reservations", { from: "umit", resource: "spark2 deepseek", hours: 1, purpose: "eval" });
  expect((await call("/api/reservations", { from: "can", resource: "spark2 deepseek", hours: 1, purpose: "x", force: true })).status).toBe(409);
  const { cookie } = await enroll("can");
  expect((await call("/api/reservations", { from: "can", resource: "spark2 deepseek", hours: 1, purpose: "x", force: true }, cookie)).status).toBe(200);
});

test("off (the default): nothing changes, no verified field, no auth routes", async () => {
  const { call } = start("off");
  const sent = await call("/api/messages", { from: "can", to: "@umit", text: "hi" });
  expect("verified" in (sent.body.message as Message)).toBe(false);
  expect((await call("/api/auth/state")).body.mode).toBe("off");
  expect((await call("/api/auth/login/options", {})).status).toBe(404);
});
