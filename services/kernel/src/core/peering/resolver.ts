/**
 * Turning an npub into something we can actually talk to.
 *
 * Candidates are tried cheapest-first — LAN, then a direct URL, then onion —
 * and the winner is remembered, so the common case is one request to the
 * endpoint that worked last time. When everything fails we ask Nostr where the
 * peer is now: that single refresh is what makes "my friend moved house"
 * recover by itself instead of needing a re-pairing.
 */
import { log } from "../logger.js";
import type { FriendsStore } from "./friends-store.js";
import {
  verifyDescriptor,
  type InstanceDescriptor,
  type ReachEntry,
  type ReachKind,
} from "./descriptor.js";

/**
 * Per-candidate probe budget. Short for the local hops — we may have several
 * to get through — and much longer for onion, where building a circuit to a
 * hidden service routinely takes ten seconds or more on first contact. A
 * single shared budget starves exactly the transport that exists for the hard
 * cases, so it is chosen per kind.
 */
export const PROBE_TIMEOUT_MS = 4_000;
/**
 * Must cover a cold circuit build (measured at 46s) plus the request itself.
 * Onion is tried last precisely because it is this expensive, and the winner
 * is cached so only the first contact with a friend pays it.
 */
export const ONION_PROBE_TIMEOUT_MS = 120_000;
export const WELL_KNOWN_PATH = "/.well-known/kernl";

export interface ResolvedPeer {
  npub: string;
  /** Origin that answered, e.g. https://host or http://abcd.onion */
  origin: string;
  kind: ReachKind | "cache";
  descriptor: InstanceDescriptor;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Fetches the current presence document from the relays. */
export type PresenceLookup = (npub: string) => Promise<unknown | null>;

export interface ResolverDeps {
  friends: FriendsStore;
  /** Injected so tests never open a socket, and so onion can use a SOCKS agent. */
  fetchImpl: FetchLike;
  /** Optional: when absent, a total failure simply fails. */
  lookupPresence?: PresenceLookup;
  timeoutMs?: number;
}

export class PeerResolver {
  constructor(private deps: ResolverDeps) {}

  /**
   * Resolve a friend to a live endpoint, or null. Never throws: an unreachable
   * friend is an ordinary state of the world, not an error condition.
   */
  async resolve(npub: string): Promise<ResolvedPeer | null> {
    const friend = this.deps.friends.get(npub);
    if (!friend) return null;

    const cached = this.cachedDescriptor(npub);
    for (const origin of this.candidates(npub, cached)) {
      const descriptor = await this.probe(origin.url, npub);
      if (descriptor) {
        this.deps.friends.markSeen(npub, origin.url);
        this.deps.friends.cachePresence(npub, JSON.stringify(descriptor), "wellknown");
        return { npub, origin: origin.url, kind: origin.kind, descriptor };
      }
    }

    // Everything we knew about is stale — ask the relays where they are now.
    const refreshed = await this.refreshFromNostr(npub);
    if (!refreshed) {
      this.deps.friends.markError(npub, "unreachable: no candidate answered");
      return null;
    }
    for (const entry of refreshed.reach) {
      const descriptor = await this.probe(entry.url, npub);
      if (descriptor) {
        this.deps.friends.markSeen(npub, entry.url);
        return { npub, origin: entry.url, kind: entry.kind, descriptor };
      }
    }
    this.deps.friends.markError(npub, "unreachable: refreshed presence did not answer either");
    return null;
  }

  /** Ordered, de-duplicated list of things worth trying. */
  private candidates(
    npub: string,
    cached: InstanceDescriptor | null,
  ): Array<{ url: string; kind: ReachKind | "cache" }> {
    const out: Array<{ url: string; kind: ReachKind | "cache" }> = [];
    const seen = new Set<string>();
    const push = (url: string, kind: ReachKind | "cache") => {
      const clean = url.replace(/\/+$/, "");
      if (!clean || seen.has(clean)) return;
      seen.add(clean);
      out.push({ url: clean, kind });
    };

    const lastReach = this.deps.friends.get(npub)?.last_reach ?? "";
    if (lastReach) push(lastReach, "cache");
    for (const entry of cached?.reach ?? []) push(entry.url, entry.kind);
    return out;
  }

  /** How long this candidate is worth waiting for. */
  private budgetFor(origin: string): number {
    if (this.deps.timeoutMs !== undefined) return this.deps.timeoutMs;
    try {
      if (new URL(origin).hostname.endsWith(".onion")) return ONION_PROBE_TIMEOUT_MS;
    } catch {
      /* fall through to the default */
    }
    return PROBE_TIMEOUT_MS;
  }

  private cachedDescriptor(npub: string): InstanceDescriptor | null {
    const row = this.deps.friends.presence(npub);
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.descriptor) as InstanceDescriptor;
      return parsed && Array.isArray(parsed.reach) ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * Ask one origin who it is. The answer only counts when it is signed by the
   * npub we expect — otherwise a hijacked URL could impersonate a friend.
   */
  private async probe(origin: string, expectNpub: string): Promise<InstanceDescriptor | null> {
    const url = origin.replace(/\/+$/, "") + WELL_KNOWN_PATH;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.budgetFor(origin));
    try {
      const res = await this.deps.fetchImpl(url, { signal: controller.signal });
      if (!res.ok) return null;
      const body = (await res.json()) as unknown;
      return verifyDescriptor(body as never, { expectNpub });
    } catch (err) {
      log.debug(`peering: probe failed for ${url}: ${String(err)}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async refreshFromNostr(npub: string): Promise<InstanceDescriptor | null> {
    if (!this.deps.lookupPresence) return null;
    try {
      const event = await this.deps.lookupPresence(npub);
      if (!event) return null;
      const descriptor = verifyDescriptor(event as never, { expectNpub: npub });
      if (!descriptor) return null;
      this.deps.friends.cachePresence(npub, JSON.stringify(descriptor), "nostr");
      return descriptor;
    } catch (err) {
      log.debug(`peering: presence refresh failed for ${npub}: ${String(err)}`);
      return null;
    }
  }
}

/** Reach entries this instance can advertise, given what is available. */
export function buildReach(opts: {
  lanUrl?: string;
  directUrl?: string;
  onionUrl?: string;
  priorities: Record<ReachKind, number>;
}): ReachEntry[] {
  const out: ReachEntry[] = [];
  if (opts.lanUrl) out.push({ kind: "lan", url: opts.lanUrl, prio: opts.priorities.lan });
  if (opts.directUrl) out.push({ kind: "direct", url: opts.directUrl, prio: opts.priorities.direct });
  if (opts.onionUrl) out.push({ kind: "onion", url: opts.onionUrl, prio: opts.priorities.onion });
  return out;
}
