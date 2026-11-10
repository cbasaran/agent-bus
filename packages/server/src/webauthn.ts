// WebAuthn (passkeys) verification without dependencies: a small CBOR decoder, COSE keys to node:crypto keys, and
// the registration and sign-in checks of the WebAuthn Level 2 spec that matter when attestation is not used
// (we ask for attestation "none": we need to know it is the same device later, not which make of device it is).
// See docs/design/resources-and-auth.md part B.4.
import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";

export class WebAuthnError extends Error {}

// ---- base64url ----

export function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function fromB64url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new WebAuthnError("not base64url");
  return new Uint8Array(Buffer.from(text, "base64url"));
}

const sha256 = (data: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(data).digest());

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// ---- CBOR (RFC 8949), the subset authenticators use: integers, byte/text strings, arrays, maps, simple values ----

export type Cbor = number | bigint | string | Uint8Array | boolean | null | undefined | Cbor[] | Map<Cbor, Cbor>;

/** Decodes one CBOR item at `offset`; returns it and the offset after it. */
export function decodeCbor(data: Uint8Array, offset = 0, depth = 0): [Cbor, number] {
  if (depth > 16) throw new WebAuthnError("CBOR nested too deep");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const need = (n: number): void => {
    if (offset + n > data.length) throw new WebAuthnError("CBOR truncated");
  };
  need(1);
  const initial = data[offset++] as number;
  const major = initial >> 5;
  const info = initial & 0x1f;
  let arg: number;
  if (info < 24) arg = info;
  else if (info === 24) {
    need(1);
    arg = data[offset] as number;
    offset += 1;
  } else if (info === 25) {
    need(2);
    arg = view.getUint16(offset);
    offset += 2;
  } else if (info === 26) {
    need(4);
    arg = view.getUint32(offset);
    offset += 4;
  } else if (info === 27) {
    need(8);
    const big = view.getBigUint64(offset);
    offset += 8;
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new WebAuthnError("CBOR integer too large");
    arg = Number(big);
  } else throw new WebAuthnError("CBOR indefinite lengths are not used by authenticators");
  switch (major) {
    case 0:
      return [arg, offset];
    case 1:
      return [-1 - arg, offset];
    case 2:
      need(arg);
      return [data.slice(offset, offset + arg), offset + arg];
    case 3:
      need(arg);
      return [new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(offset, offset + arg)), offset + arg];
    case 4: {
      const items: Cbor[] = [];
      for (let i = 0; i < arg; i++) {
        const [item, next] = decodeCbor(data, offset, depth + 1);
        items.push(item);
        offset = next;
      }
      return [items, offset];
    }
    case 5: {
      const map = new Map<Cbor, Cbor>();
      for (let i = 0; i < arg; i++) {
        const [key, afterKey] = decodeCbor(data, offset, depth + 1);
        const [value, afterValue] = decodeCbor(data, afterKey, depth + 1);
        map.set(key, value);
        offset = afterValue;
      }
      return [map, offset];
    }
    case 7:
      if (info === 20) return [false, offset];
      if (info === 21) return [true, offset];
      if (info === 22) return [null, offset];
      if (info === 23) return [undefined, offset];
      throw new WebAuthnError("CBOR floats are not used by authenticators");
    default:
      throw new WebAuthnError("CBOR tags are not used by authenticators");
  }
}

// ---- COSE keys (RFC 9053) ----

export const COSE_ES256 = -7;
export const COSE_EDDSA = -8;
export const COSE_RS256 = -257;
export const SUPPORTED_ALGS = [COSE_ES256, COSE_EDDSA, COSE_RS256] as const;

function bytesAt(map: Map<Cbor, Cbor>, key: number): Uint8Array {
  const value = map.get(key);
  if (!(value instanceof Uint8Array)) throw new WebAuthnError(`COSE key parameter ${key} missing`);
  return value;
}

/** A COSE public key as a node:crypto key, with its algorithm. */
export function coseToKey(cose: Cbor): { key: KeyObject; alg: number } {
  if (!(cose instanceof Map)) throw new WebAuthnError("COSE key is not a map");
  const kty = cose.get(1);
  const alg = cose.get(3);
  if (typeof alg !== "number") throw new WebAuthnError("COSE key has no algorithm");
  if (kty === 2 && alg === COSE_ES256) {
    if (cose.get(-1) !== 1) throw new WebAuthnError("ES256 key is not on P-256");
    const x = bytesAt(cose, -2);
    const y = bytesAt(cose, -3);
    if (x.length !== 32 || y.length !== 32) throw new WebAuthnError("ES256 key has the wrong size");
    return { key: createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64url(x), y: b64url(y) }, format: "jwk" }), alg };
  }
  if (kty === 1 && alg === COSE_EDDSA) {
    if (cose.get(-1) !== 6) throw new WebAuthnError("EdDSA key is not Ed25519");
    return { key: createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: b64url(bytesAt(cose, -2)) }, format: "jwk" }), alg };
  }
  if (kty === 3 && alg === COSE_RS256) {
    const n = bytesAt(cose, -1);
    if (n.length < 256) throw new WebAuthnError("RSA key shorter than 2048 bits");
    return { key: createPublicKey({ key: { kty: "RSA", n: b64url(n), e: b64url(bytesAt(cose, -2)) }, format: "jwk" }), alg };
  }
  throw new WebAuthnError(`Unsupported key (kty ${String(kty)}, alg ${alg}); supported: ES256, EdDSA, RS256`);
}

function verifySignature(alg: number, key: KeyObject, data: Uint8Array, signature: Uint8Array): boolean {
  if (alg === COSE_ES256) return cryptoVerify("sha256", data, { key, dsaEncoding: "der" }, signature);
  if (alg === COSE_RS256) return cryptoVerify("sha256", data, key, signature);
  if (alg === COSE_EDDSA) return cryptoVerify(null, data, key, signature);
  return false;
}

// ---- Authenticator data ----

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

interface AuthData {
  rpIdHash: Uint8Array;
  flags: number;
  signCount: number;
  credentialId?: Uint8Array;
  cosePublicKey?: Cbor;
}

function parseAuthData(data: Uint8Array): AuthData {
  if (data.length < 37) throw new WebAuthnError("authenticator data too short");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const flags = data[32] as number;
  const out: AuthData = { rpIdHash: data.slice(0, 32), flags, signCount: view.getUint32(33) };
  if (flags & FLAG_AT) {
    if (data.length < 55) throw new WebAuthnError("attested credential data too short");
    const idLength = view.getUint16(53);
    if (55 + idLength > data.length) throw new WebAuthnError("credential id truncated");
    out.credentialId = data.slice(55, 55 + idLength);
    [out.cosePublicKey] = decodeCbor(data, 55 + idLength);
  }
  return out;
}

// ---- Client data ----

interface ClientData {
  type: string;
  challenge: string;
  origin: string;
}

function checkClientData(raw: Uint8Array, type: "webauthn.create" | "webauthn.get", challenge: string, origins: readonly string[]): void {
  let data: ClientData;
  try {
    data = JSON.parse(new TextDecoder().decode(raw)) as ClientData;
  } catch {
    throw new WebAuthnError("clientDataJSON is not JSON");
  }
  if (data.type !== type) throw new WebAuthnError(`expected ${type}, got ${String(data.type)}`);
  if (data.challenge !== challenge) throw new WebAuthnError("challenge does not match");
  if (!origins.includes(data.origin)) throw new WebAuthnError(`origin ${String(data.origin)} is not this bus (${origins.join(", ")})`);
}

function checkRp(auth: AuthData, rpId: string): void {
  if (!equalBytes(auth.rpIdHash, sha256(new TextEncoder().encode(rpId)))) throw new WebAuthnError("the passkey is for another site");
  if (!(auth.flags & FLAG_UP)) throw new WebAuthnError("no user presence");
}

// ---- Ceremonies ----

export interface RelyingParty {
  rpId: string;
  /** Exact origins the website is served from, e.g. "https://bariton:7843". */
  origins: readonly string[];
}

export interface StoredCredential {
  /** base64url credential id. */
  id: string;
  /** SPKI DER, base64url. */
  publicKey: string;
  alg: number;
  signCount: number;
  userVerified: boolean;
}

/** Checks a registration (navigator.credentials.create) response; returns the credential to store. */
export function verifyRegistration(
  rp: RelyingParty,
  challenge: string,
  response: { clientDataJSON: string; attestationObject: string }
): StoredCredential {
  checkClientData(fromB64url(response.clientDataJSON), "webauthn.create", challenge, rp.origins);
  const [attestation] = decodeCbor(fromB64url(response.attestationObject));
  if (!(attestation instanceof Map)) throw new WebAuthnError("attestationObject is not a map");
  const authDataBytes = attestation.get("authData");
  if (!(authDataBytes instanceof Uint8Array)) throw new WebAuthnError("attestationObject has no authData");
  // Attestation statements are not checked: we asked for "none", and only use the key to recognize the device later.
  const auth = parseAuthData(authDataBytes);
  checkRp(auth, rp.rpId);
  if (!auth.credentialId || auth.cosePublicKey === undefined) throw new WebAuthnError("no credential in the registration");
  const { key, alg } = coseToKey(auth.cosePublicKey);
  return {
    id: b64url(auth.credentialId),
    publicKey: b64url(new Uint8Array(key.export({ format: "der", type: "spki" }))),
    alg,
    signCount: auth.signCount,
    userVerified: (auth.flags & FLAG_UV) !== 0,
  };
}

/** Checks a sign-in (navigator.credentials.get) response against the stored credential; returns the new sign count. */
export function verifyAssertion(
  rp: RelyingParty,
  challenge: string,
  credential: StoredCredential,
  response: { clientDataJSON: string; authenticatorData: string; signature: string }
): number {
  const clientData = fromB64url(response.clientDataJSON);
  checkClientData(clientData, "webauthn.get", challenge, rp.origins);
  const authDataBytes = fromB64url(response.authenticatorData);
  const auth = parseAuthData(authDataBytes);
  checkRp(auth, rp.rpId);
  const key = createPublicKey({ key: Buffer.from(fromB64url(credential.publicKey)), format: "der", type: "spki" });
  const signed = new Uint8Array([...authDataBytes, ...sha256(clientData)]);
  if (!verifySignature(credential.alg, key, signed, fromB64url(response.signature))) throw new WebAuthnError("bad signature");
  // Synced passkeys (iCloud, Google) always report 0; a counter that goes backwards means a cloned key.
  if ((auth.signCount !== 0 || credential.signCount !== 0) && auth.signCount <= credential.signCount) {
    throw new WebAuthnError("signature counter went backwards (cloned authenticator?)");
  }
  return auth.signCount;
}
