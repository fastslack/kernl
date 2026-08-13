/**
 * Resolver and client: which endpoint gets tried, in what order, and what
 * happens when a friend has moved. No sockets — fetch is injected.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { NostrIdentity } from "../src/core/nostr/nostr-identity.js";
import { FriendsStore } from "../src/core/peering/friends-store.js";
import {
  PeerResolver,
  buildReach,
  WELL_KNOWN_PATH,
  PROBE_TIMEOUT_MS,
  ONION_PROBE_TIMEOUT_MS,
} from "../src/core/peering/resolver.js";
import { PeerClient } from "../src/core/peering/client.js";
import {
  buildDescriptor,
  signDescriptor,
  DEFAULT_PRIORITY,
  type ReachEntry,
} from "../src/core/peering/descriptor.js";
import { verifyRequest } from "../src/core/peering/auth.js";
import type { IncomingMessage } from "node:http";

const LAN = "http://friend-kernl.local:3087";
const DIRECT = "https://friend.example";
const ONION = "http://friendabcdefghij.onion";

function makeIdentity(): NostrIdentity {
  return NostrIdentity.fromEd25519Seed(new Uint8Array(randomBytes(32)));
}

function descriptorEvent(id: NostrIdentity, reach: ReachEntry[]) {
  return signDescriptor(id, buildDescriptor(id, { name: "friend", version: "0.1.0", reach }));
}

/** A fetch that answers only for the origins we say are alive. */
function makeFetch(alive: Record<string, unknown>) {
  const calls: string[] = [];
  const fetchImpl = async (url: string): Promise<Response> => {
    calls.push(url);
    const body = alive[url];
    if (!body) throw new Error("ECONNREFUSED");
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { fetchImpl, calls };
}

describe("peer resolver", () => {
  let store: FriendsStore;
  let friend: NostrIdentity;

  beforeEach(() => {
    store = new FriendsStore(new Database(":memory:"));
    friend = makeIdentity();
    store.add({ npub: friend.npub() });
    store.update(friend.npub(), { trust: "trusted" });
  });

  const allReach = () =>
    buildReach({ lanUrl: LAN, directUrl: DIRECT, onionUrl: ONION, priorities: DEFAULT_PRIORITY });

  function cacheDescriptor(reach: ReachEntry[]) {
    const event = descriptorEvent(friend, reach);
    const parsed = JSON.parse(event.content) as { reach: ReachEntry[] };
    store.cachePresence(friend.npub(), JSON.stringify(parsed), "manual");
    return event;
  }

  it("tries LAN before direct and onion", async () => {
    const event = cacheDescriptor(allReach());
    const { fetchImpl, calls } = makeFetch({ [LAN + WELL_KNOWN_PATH]: event });
    const r = new PeerResolver({ friends: store, fetchImpl });

    const peer = await r.resolve(friend.npub());
    expect(peer?.kind).toBe("lan");
    expect(calls[0]).toBe(LAN + WELL_KNOWN_PATH);
  });

  it("falls through to onion when the cheaper hops are dead", async () => {
    const event = cacheDescriptor(allReach());
    const { fetchImpl, calls } = makeFetch({ [ONION + WELL_KNOWN_PATH]: event });
    const r = new PeerResolver({ friends: store, fetchImpl });

    const peer = await r.resolve(friend.npub());
    expect(peer?.kind).toBe("onion");
    expect(calls).toHaveLength(3); // lan, direct, onion — in that order
  });

  it("prefers the endpoint that worked last time", async () => {
    const event = cacheDescriptor(allReach());
    store.markSeen(friend.npub(), ONION);
    const { fetchImpl, calls } = makeFetch({ [ONION + WELL_KNOWN_PATH]: event });
    const r = new PeerResolver({ friends: store, fetchImpl });

    const peer = await r.resolve(friend.npub());
    expect(peer?.kind).toBe("cache");
    expect(calls).toHaveLength(1);
  });

  it("refuses an endpoint that answers with someone else's identity", async () => {
    cacheDescriptor(allReach());
    const impostor = makeIdentity();
    const { fetchImpl } = makeFetch({
      [LAN + WELL_KNOWN_PATH]: descriptorEvent(impostor, allReach()),
      [DIRECT + WELL_KNOWN_PATH]: descriptorEvent(impostor, allReach()),
      [ONION + WELL_KNOWN_PATH]: descriptorEvent(impostor, allReach()),
    });
    const r = new PeerResolver({ friends: store, fetchImpl });
    expect(await r.resolve(friend.npub())).toBeNull();
  });

  it("recovers when a friend moved, via one presence refresh", async () => {
    cacheDescriptor([{ kind: "direct", url: "https://old.example", prio: 20 }]);
    const moved = descriptorEvent(friend, [{ kind: "direct", url: DIRECT, prio: 20 }]);
    const { fetchImpl, calls } = makeFetch({ [DIRECT + WELL_KNOWN_PATH]: moved });

    let lookups = 0;
    const r = new PeerResolver({
      friends: store,
      fetchImpl,
      lookupPresence: async () => {
        lookups++;
        return moved;
      },
    });

    const peer = await r.resolve(friend.npub());
    expect(peer?.origin).toBe(DIRECT);
    expect(lookups).toBe(1); // exactly one refresh, not a retry storm
    expect(calls[0]).toContain("old.example");
  });

  it("gives up quietly and records why", async () => {
    cacheDescriptor(allReach());
    const { fetchImpl } = makeFetch({});
    const r = new PeerResolver({ friends: store, fetchImpl });

    expect(await r.resolve(friend.npub())).toBeNull();
    expect(store.get(friend.npub())!.last_error).toContain("unreachable");
  });

  it("gives an onion candidate a far longer budget than a local one", async () => {
    // Building a circuit to a hidden service takes many seconds on first
    // contact; the LAN budget would abort every one of them.
    const r = new PeerResolver({ friends: store, fetchImpl: async () => new Response("{}") });
    const budget = (origin: string) =>
      (r as unknown as { budgetFor(o: string): number }).budgetFor(origin);
    expect(budget(ONION)).toBe(ONION_PROBE_TIMEOUT_MS);
    expect(budget(LAN)).toBe(PROBE_TIMEOUT_MS);
    expect(budget(DIRECT)).toBe(PROBE_TIMEOUT_MS);
  });

  it("does not resolve someone who is not a friend", async () => {
    const stranger = makeIdentity();
    const { fetchImpl } = makeFetch({});
    const r = new PeerResolver({ friends: store, fetchImpl });
    expect(await r.resolve(stranger.npub())).toBeNull();
  });
});

describe("peer client", () => {
  let store: FriendsStore;
  let me: NostrIdentity;
  let friend: NostrIdentity;

  beforeEach(() => {
    store = new FriendsStore(new Database(":memory:"));
    me = makeIdentity();
    friend = makeIdentity();
    store.add({ npub: friend.npub() });
    store.update(friend.npub(), { trust: "trusted" });
  });

  function resolverFor(event: unknown, alive: Record<string, unknown>) {
    const parsed = JSON.parse((event as { content: string }).content) as { reach: ReachEntry[] };
    store.cachePresence(friend.npub(), JSON.stringify(parsed), "manual");
    const { fetchImpl, calls } = makeFetch(alive);
    return { resolver: new PeerResolver({ friends: store, fetchImpl }), fetchImpl, calls };
  }

  it("signs the request so the far end can authenticate us", async () => {
    const reach = [{ kind: "direct" as const, url: DIRECT, prio: 20 }];
    const event = descriptorEvent(friend, reach);
    const path = "/api/cinema/directories";

    // The far end is our own verifier, with us added as a trusted friend.
    const theirStore = new FriendsStore(new Database(":memory:"));
    theirStore.add({ npub: me.npub() });
    theirStore.update(me.npub(), { trust: "trusted" });

    let seenAuth = "";
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith(WELL_KNOWN_PATH)) {
        return new Response(JSON.stringify(event), { status: 200 });
      }
      seenAuth = String((init?.headers as Record<string, string>)?.authorization ?? "");
      return new Response(JSON.stringify({ directories: [] }), { status: 200 });
    };
    const parsed = JSON.parse(event.content) as { reach: ReachEntry[] };
    store.cachePresence(friend.npub(), JSON.stringify(parsed), "manual");

    const client = new PeerClient({
      identity: me,
      friends: store,
      resolver: new PeerResolver({ friends: store, fetchImpl }),
      fetchImpl,
    });

    const res = await client.get(friend.npub(), path);
    expect(res.ok).toBe(true);
    expect(res.via).toBe("direct");

    const check = await verifyRequest({
      req: { headers: { authorization: seenAuth }, method: "GET" } as unknown as IncomingMessage,
      url: DIRECT + path,
      friends: theirStore,
    });
    expect(check.ok).toBe(true);
    expect(check.npub).toBe(me.npub());
  });

  it("will not talk to a friend it has not trusted", async () => {
    store.update(friend.npub(), { trust: "pending" });
    const { resolver, fetchImpl } = resolverFor(descriptorEvent(friend, []), {});
    const client = new PeerClient({ identity: me, friends: store, resolver, fetchImpl });

    const res = await client.get(friend.npub(), "/x");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("pending");
  });

  it("reports unreachable instead of throwing", async () => {
    const { resolver, fetchImpl } = resolverFor(
      descriptorEvent(friend, [{ kind: "direct", url: DIRECT, prio: 20 }]),
      {},
    );
    const client = new PeerClient({ identity: me, friends: store, resolver, fetchImpl });

    const res = await client.get(friend.npub(), "/x");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("unreachable");
  });
});
