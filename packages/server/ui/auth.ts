// The sign-in page (experimental; docs/design/resources-and-auth.md part B): create a passkey from an invite link
// (/auth#invite=<token>), sign in with one, list and remove your passkeys, sign out.
import { api, postJson, PROFILE_KEY, SESSION_KEY } from "./api";
import { el } from "./html";

const show = (id: string): void => {
  el(id).hidden = false;
};
const msg = el<HTMLDivElement>("auth-msg");

const toB64url = (buf: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const fromB64url = (text: string): ArrayBuffer => {
  const bin = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer;
};

interface CreationOptions {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: Array<{ type: "public-key"; alg: number }>;
  authenticatorSelection: AuthenticatorSelectionCriteria;
  attestation: AttestationConveyancePreference;
  excludeCredentials: Array<{ type: "public-key"; id: string }>;
  timeout: number;
}

async function enroll(invite: string): Promise<void> {
  const o = await postJson<CreationOptions>("/api/auth/register/options", { invite });
  const credential = (await navigator.credentials.create({
    publicKey: {
      ...o,
      challenge: fromB64url(o.challenge),
      user: { ...o.user, id: fromB64url(o.user.id) },
      excludeCredentials: o.excludeCredentials.map((c) => ({ type: c.type, id: fromB64url(c.id) })),
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("No passkey was made");
  const response = credential.response as AuthenticatorAttestationResponse;
  const done = await postJson<{ session: string }>("/api/auth/register/verify", {
    invite,
    credential: { id: credential.id, type: credential.type, response: { clientDataJSON: toB64url(response.clientDataJSON), attestationObject: toB64url(response.attestationObject) } },
  });
  localStorage.setItem(SESSION_KEY, done.session);
  history.replaceState(null, "", "/auth");
}

async function signIn(): Promise<void> {
  // The profile picked on the conversations page: its passkeys are named in the request (see loginOptions).
  const human = localStorage.getItem(PROFILE_KEY) ?? undefined;
  const o = await postJson<{
    challenge: string;
    rpId: string;
    userVerification: UserVerificationRequirement;
    timeout: number;
    allowCredentials: Array<{ type: "public-key"; id: string; transports: AuthenticatorTransport[] }>;
  }>("/api/auth/login/options", { human });
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: fromB64url(o.challenge),
      rpId: o.rpId,
      userVerification: o.userVerification,
      timeout: o.timeout,
      allowCredentials: o.allowCredentials.map((c) => ({ ...c, id: fromB64url(c.id) })),
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("No passkey was chosen");
  const response = credential.response as AuthenticatorAssertionResponse;
  const done = await postJson<{ session: string }>("/api/auth/login/verify", {
    credential: {
      id: credential.id,
      type: credential.type,
      response: {
        clientDataJSON: toB64url(response.clientDataJSON),
        authenticatorData: toB64url(response.authenticatorData),
        signature: toB64url(response.signature),
        userHandle: response.userHandle ? toB64url(response.userHandle) : "",
      },
    },
  });
  localStorage.setItem(SESSION_KEY, done.session);
}

async function renderMe(me: string): Promise<void> {
  show("auth-me");
  el("auth-me-name").textContent = me;
  localStorage.setItem(PROFILE_KEY, me);
  const { credentials } = await api<{ credentials: Array<{ id: string; label: string; createdAt: number; lastUsedAt: number | null }> }>("/api/auth/credentials");
  const list = el<HTMLUListElement>("auth-credentials");
  list.replaceChildren(
    ...credentials.map((c) => {
      const li = document.createElement("li");
      const when = c.lastUsedAt ? `last used ${new Date(c.lastUsedAt).toISOString().slice(0, 16).replace("T", " ")}Z` : "not used to sign in yet";
      li.textContent = `${c.label} · made ${new Date(c.createdAt).toISOString().slice(0, 10)} · ${when} `;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "link-btn";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        if (!confirm(`Remove the passkey "${c.label}"? You will be signed out everywhere.`)) return;
        postJson(`/api/auth/credentials/${encodeURIComponent(c.id)}/remove`, {}).then(
          () => {
            localStorage.removeItem(SESSION_KEY);
            location.reload();
          },
          (err: Error) => (msg.textContent = err.message)
        );
      });
      li.append(remove);
      return li;
    })
  );
}

const run = (action: () => Promise<void>) => (): void => {
  msg.textContent = "";
  action().then(
    () => location.reload(),
    (err: Error) => {
      msg.textContent = err.name === "NotAllowedError" ? "Cancelled (or this device has no passkey for this bus)." : err.message;
    }
  );
};

async function boot(): Promise<void> {
  const state = await api<{ mode: string; rpId: string; httpsPort: number | null; me: string | null }>("/api/auth/state");
  if (state.mode === "off") return show("auth-off");
  if (!window.isSecureContext || !window.PublicKeyCredential) {
    show("auth-insecure");
    const link = el<HTMLAnchorElement>("auth-secure-link");
    const base = state.httpsPort ? `https://${state.rpId}:${state.httpsPort}` : `https://${state.rpId}`;
    link.href = `${base}/auth${location.hash}`;
    link.textContent = `${base}/auth`;
    return;
  }
  const invite = new URLSearchParams(location.hash.slice(1)).get("invite");
  if (invite) {
    try {
      const o = await postJson<CreationOptions>("/api/auth/register/options", { invite });
      show("auth-enroll");
      el("auth-enroll-human").textContent = o.user.name;
      el("auth-enroll-btn").addEventListener("click", run(() => enroll(invite)));
    } catch (err) {
      msg.textContent = (err as Error).message;
    }
    return;
  }
  if (state.me) return renderMe(state.me);
  show("auth-signin");
  el("auth-signin-btn").addEventListener("click", run(signIn));
}

el("auth-signout-btn").addEventListener("click", () => {
  void postJson("/api/auth/logout", {}).finally(() => {
    localStorage.removeItem(SESSION_KEY);
    location.reload();
  });
});

void boot();
