// What the route and socket modules share: the store, the configured humans, human authentication, the live state
// (`Hub`), and the checks every write makes.
import { parseAddress, RESOURCES_AGENT_ID, type ParsedAddress } from "@agent-bus/protocol";
import type { HumanAuth } from "./auth";
import type { BusDatabase } from "./db";
import { HttpError } from "./http";
import { Hub } from "./hub";

/** SHA-256 hex of an agent token (the database never holds the token itself). */
export function tokenHash(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

export class BusContext {
  readonly hub: Hub;

  constructor(
    readonly db: BusDatabase,
    /** Configured human ids, in configuration order. */
    readonly humans: string[],
    readonly auth: HumanAuth,
    /** Uploaded files, one blob per file id. */
    readonly filesDir: string
  ) {
    this.hub = new Hub(db, new Set(humans));
  }

  /**
   * Every write's check of its `from`. Agents: an id bound to a token (first join with one) needs that token in
   * `X-Agent-Token`; the built-in @resources is never written as. Humans: the passkey session rules (auth.ts).
   * Returns whether a human writer is verified.
   */
  checkWriter(req: Request, writer: { id: string; kind: "agent" | "human" }): boolean | undefined {
    if (writer.kind === "agent") {
      if (writer.id === RESOURCES_AGENT_ID) throw new HttpError(403, "@resources is the bus's own notices; nobody writes as it");
      const bound = this.db.agentTokenHash(writer.id);
      const given = req.headers.get("x-agent-token");
      if (bound !== null && (given === null || tokenHash(given) !== bound)) {
        throw new HttpError(401, `@${writer.id} is bound to an agent token, and this request does not carry it (X-Agent-Token). Nothing was sent.`);
      }
    }
    return this.auth.checkWriter(req, writer.id, writer.kind);
  }

  /** `to` parsed as an address; 400 when it is not one or names an id that is not a participant. */
  knownAddress(to: string): ParsedAddress {
    let parsed: ParsedAddress;
    try {
      parsed = parseAddress(to);
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : String(error));
    }
    if (parsed.kind === "all") return parsed;
    const unknown = parsed.ids.filter((id) => !this.hub.knownParticipant(id));
    if (unknown.length > 0) {
      throw new HttpError(
        400,
        `Unknown id${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}. Known ids: ${this.hub.knownIds().join(", ")}`
      );
    }
    return parsed;
  }
}
