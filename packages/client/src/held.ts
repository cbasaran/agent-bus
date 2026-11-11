// Deliveries the model has not been given yet, and messages held for a harness hook to hand over. Used by the bindings
// whose harness has no "add this to the session" call of its own (Claude Code, Codex: hooks return the held texts as
// added context) and by those that see what goes to the model (omp and pi: the `context` event).
import { deliveryHeaderSeqs } from "../../protocol/src/address";

/** Claude Code caps each hook's additionalContext at 10 000 characters; Codex hooks get the same budget. */
const CONTEXT_BUDGET = 9_500;

/** Delivered seqs the model has not been given yet; each is reported seen once. */
export class UnseenSeqs {
  private readonly seqs = new Set<number>();

  constructor(private readonly markSeen: (seq: number) => void) {}

  get size(): number {
    return this.seqs.size;
  }

  add(seq: number): void {
    this.seqs.add(seq);
  }

  /** Reports `seq` seen if it was waiting; true when it was. */
  seen(seq: number): boolean {
    if (!this.seqs.delete(seq)) return false;
    this.markSeen(seq);
    return true;
  }

  /** Reports every waiting delivery whose header (`[message-bus] #n @`) is in `text`, i.e. reached the model. */
  seenIn(text: string): void {
    for (const seq of deliveryHeaderSeqs(text)) this.seen(seq);
  }

  clear(): void {
    this.seqs.clear();
  }
}

/** A text waiting for a hook: a delivery (`seq`) or a receipt notice. Wake ones should start a turn. */
export interface HeldItem {
  text: string;
  seq?: number;
  wake: boolean;
}

export class HeldQueue {
  private items: HeldItem[] = [];

  /** Deliveries taken from the queue are reported seen through `unseen`: a hook's answer goes into the next request. */
  constructor(private readonly unseen: UnseenSeqs) {}

  push(item: HeldItem): void {
    this.items.push(item);
  }

  /** Puts `item` first (it was meant to reach the session before the rest). */
  unshift(item: HeldItem): void {
    this.items.unshift(item);
  }

  hasWake(): boolean {
    return this.items.some((item) => item.wake);
  }

  /** Removes and returns the held wake deliveries; quiet ones and receipt notices stay. */
  takeWake(): HeldItem[] {
    const wake = this.items.filter((item) => item.wake && item.seq !== undefined);
    if (wake.length > 0) this.items = this.items.filter((item) => !wake.includes(item));
    return wake;
  }

  /**
   * Held texts for a hook's added context, oldest first, within CONTEXT_BUDGET (a longer text is cut, pointing to
   * `op=show`); the rest stays held. Undefined when nothing is held.
   */
  take(): string | undefined {
    if (this.items.length === 0) return undefined;
    const parts: string[] = [];
    let size = 0;
    while (this.items.length > 0) {
      const item = this.items[0] as HeldItem;
      let text = item.text;
      if (text.length > CONTEXT_BUDGET) {
        text = `${text.slice(0, CONTEXT_BUDGET - 200)}\n… (cut here; message-bus op=show message_id ${item.seq ?? "?"} for all of it)`;
      }
      if (parts.length > 0 && size + text.length > CONTEXT_BUDGET) break;
      this.items.shift();
      if (item.seq !== undefined) this.unseen.seen(item.seq);
      parts.push(text);
      size += text.length + 2;
    }
    return parts.join("\n\n");
  }
}
