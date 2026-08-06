/**
 * Publishing where this instance can be reached, and finding out where a
 * friend went.
 *
 * This is the piece that makes the whole thing NAT-independent. An instance
 * behind a phone's tether has no stable address, but it can always *push* a
 * few hundred bytes to a public relay saying "this is me, here is my onion".
 * A friend who can reach none of the old URLs asks the relays and recovers on
 * its own — no re-pairing, no central directory, and no infrastructure we run.
 *
 * The payload is the same signed event served at /.well-known/kernl, so a
 * relay is a dumb carrier: it cannot alter what it stores.
 */
import type { Event as NostrEvent } from "nostr-tools/core";
import { log } from "../logger.js";
import type { NostrRelayPool } from "../nostr/nostr-relay-pool.js";
import { PRESENCE_KIND, PRESENCE_D_TAG, hexOf, verifyDescriptor } from "./descriptor.js";

/** Re-publish this often: relays drop old replaceable events over time. */
export const REPUBLISH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
export const LOOKUP_TIMEOUT_MS = 6_000;

export interface AnnouncerDeps {
  pool: NostrRelayPool;
  /** The current signed descriptor. A getter: reachability changes at runtime. */
  currentDescriptor: () => NostrEvent | null;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearTimer?: (t: ReturnType<typeof setInterval>) => void;
}

export class PresenceAnnouncer {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private deps: AnnouncerDeps) {}

  /** Publish now and keep republishing. Safe to call twice. */
  start(): void {
    void this.publishOnce();
    if (this.timer) return;
    const set = this.deps.setTimer ?? ((fn, ms) => setInterval(fn, ms));
    this.timer = set(() => void this.publishOnce(), REPUBLISH_INTERVAL_MS);
  }

  stop(): void {
    if (!this.timer) return;
    const clear = this.deps.clearTimer ?? ((t) => clearInterval(t));
    clear(this.timer);
    this.timer = null;
  }

  /**
   * Push the descriptor to the relays. Never throws: being unable to announce
   * is a degraded state, not a failure of the kernel.
   */
  async publishOnce(): Promise<boolean> {
    const event = this.deps.currentDescriptor();
    if (!event) return false;
    try {
      const outcomes = await this.deps.pool.publish(event);
      const ok = outcomes.filter((o) => o.ok).length;
      if (ok === 0) {
        log.warn("peering: no relay accepted our presence announcement");
        return false;
      }
      log.info(`peering: presence announced to ${ok}/${outcomes.length} relays`);
      return true;
    } catch (err) {
      log.warn(`peering: presence announcement failed: ${String(err)}`);
      return false;
    }
  }

  /**
   * Where is this npub now? Returns the newest *verified* presence event, or
   * null. This is the resolver's `lookupPresence`.
   */
  async lookup(npub: string): Promise<NostrEvent | null> {
    const pubkey = hexOf(npub);
    if (!pubkey) return null;
    try {
      const events = await this.deps.pool.querySync(
        [
          {
            kinds: [PRESENCE_KIND],
            authors: [pubkey],
            "#d": [PRESENCE_D_TAG],
            limit: 4,
          },
        ],
        LOOKUP_TIMEOUT_MS,
      );
      // A relay can hand us anything; keep only what verifies as this peer,
      // then take the newest. Ordering by created_at is safe *because* every
      // candidate is signed by the key we asked for.
      const valid = events
        .filter((e) => verifyDescriptor(e, { expectNpub: npub }) !== null)
        .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
      return valid[0] ?? null;
    } catch (err) {
      log.debug(`peering: presence lookup for ${npub} failed: ${String(err)}`);
      return null;
    }
  }
}
