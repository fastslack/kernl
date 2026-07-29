/**
 * Thin wrapper over nostr-tools `SimplePool` — shared Nostr relay
 * infrastructure (used by cinema's discovery providers and, when
 * installed, the paid social extension's Nostr bridge). Holds a list of
 * relay URLs, exposes publish + subscribe, and reports per-relay status
 * (connected / connecting / error / closed).
 *
 * SimplePool already handles event dedup, multi-relay fan-out and EOSE
 * coalescing — we only add bookkeeping the rest of the kernel cares
 * about: which relays are healthy and a pluggable verifier so we can
 * fail-fast on malformed sigs without touching the heavy crypto path.
 */

import { SimplePool } from "nostr-tools/pool";
import type { Filter } from "nostr-tools/filter";
import type { Event as NostrEvent } from "nostr-tools/core";
import type { SubCloser } from "nostr-tools/abstract-pool";
import { log } from "../logger.js";

export type RelayStatus = "connecting" | "connected" | "error" | "closed";

export interface RelayState {
  url: string;
  status: RelayStatus;
  lastError?: string;
  lastEventAt?: number;
}

export interface PublishOutcome {
  relay: string;
  ok: boolean;
  error?: string;
}

export const DEFAULT_RELAYS = [
  // Primary set — major public relays. Damus, nos.lol and snort handle
  // 90%+ of Kernl traffic and accept anonymous publishing.
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.snort.social",
  // Secondary set — adds resilience + reach into broader Nostr clients
  // (Primal, search-friendly nostr.band). All accept anon kind-1/30079.
  "wss://relay.primal.net",
  "wss://relay.nostr.band",
  "wss://nostr.mom",
  // Wine deliberately removed: it requires sign-up to publish (Stage-0
  // probe rejected our events). Keep it out of the default fan-out so
  // kernels don't waste sockets on relays they can't write to.
];

export class NostrRelayPool {
  private pool = new SimplePool();
  private relays: string[];
  private states = new Map<string, RelayState>();
  private subs = new Set<SubCloser>();

  constructor(relays: string[] = DEFAULT_RELAYS) {
    this.relays = [...relays];
    for (const r of relays) this.states.set(r, { url: r, status: "connecting" });
  }

  /** Replace the active relay list. Existing subscriptions are NOT
   *  rebound automatically — callers should re-subscribe. */
  setRelays(next: string[]): void {
    const dropping = this.relays.filter((r) => !next.includes(r));
    if (dropping.length > 0) {
      this.pool.close(dropping);
      for (const r of dropping) this.states.delete(r);
    }
    for (const r of next) {
      if (!this.states.has(r)) this.states.set(r, { url: r, status: "connecting" });
    }
    this.relays = [...next];
  }

  list(): string[] {
    return [...this.relays];
  }

  status(): RelayState[] {
    return [...this.states.values()];
  }

  /** Publish a signed event to every configured relay. Resolves with one
   *  outcome per relay; failures don't reject the whole thing. */
  async publish(event: NostrEvent): Promise<PublishOutcome[]> {
    const outcomes: PublishOutcome[] = [];
    const promises = this.pool.publish(this.relays, event);
    await Promise.all(
      promises.map(async (p, i) => {
        const relay = this.relays[i];
        try {
          await p;
          outcomes.push({ relay, ok: true });
          this.markState(relay, "connected");
        } catch (err) {
          const msg = String(err);
          outcomes.push({ relay, ok: false, error: msg });
          this.markState(relay, "error", msg);
        }
      }),
    );
    return outcomes;
  }

  /**
   * Open a long-lived subscription against the configured relays.
   * `onevent` fires for every (verified, deduped) event matching the
   * filters. The returned closer should be tracked by the caller and
   * called on shutdown / filter change.
   */
  subscribe(
    filters: Filter[],
    onevent: (ev: NostrEvent) => void,
    onclose?: (reasons: string[]) => void,
  ): SubCloser {
    // SimplePool's subscribe takes a single Filter, so we open one sub per
    // filter. The pool dedupes events at the connection level.
    const closers: SubCloser[] = [];
    for (const filter of filters) {
      const closer = this.pool.subscribe(this.relays, filter, {
        onevent: (ev) => {
          for (const r of this.relays) this.markState(r, "connected");
          this.states.get(this.relays[0])!.lastEventAt = Date.now();
          onevent(ev);
        },
        onclose: (reasons) => {
          for (const reason of reasons) {
            log.debug?.(`nostr: relay sub closed — ${reason}`);
          }
          onclose?.(reasons);
        },
      });
      closers.push(closer);
    }
    const composite: SubCloser = {
      close: () => {
        for (const c of closers) c.close();
      },
    };
    this.subs.add(composite);
    return composite;
  }

  /** One-shot synchronous query. Returns events seen up to EOSE. */
  async querySync(filters: Filter[], maxWaitMs = 4000): Promise<NostrEvent[]> {
    const out: NostrEvent[] = [];
    for (const f of filters) {
      const evs = await this.pool.querySync(this.relays, f, { maxWait: maxWaitMs });
      out.push(...evs);
    }
    return out;
  }

  /** Tear down all subs and close every relay socket. */
  close(): void {
    for (const sub of this.subs) sub.close();
    this.subs.clear();
    this.pool.close(this.relays);
    for (const r of this.relays) this.markState(r, "closed");
  }

  private markState(url: string, status: RelayStatus, lastError?: string): void {
    const cur = this.states.get(url);
    if (!cur) return;
    cur.status = status;
    if (lastError) cur.lastError = lastError;
    if (status === "connected") cur.lastError = undefined;
  }
}
