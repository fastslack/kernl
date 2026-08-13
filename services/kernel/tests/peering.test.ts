/**
 * Peering: instance descriptor, friends trust rules and NIP-98 auth.
 * Everything here runs without sockets — signing and verification are pure.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { NostrIdentity } from "../src/core/nostr/nostr-identity.js";
import {
  buildDescriptor,
  signDescriptor,
  verifyDescriptor,
  isSafeReach,
  npubOf,
  hexOf,
  PRESENCE_KIND,
  DEFAULT_PRIORITY,
  type ReachEntry,
} from "../src/core/peering/descriptor.js";
import { FriendsStore } from "../src/core/peering/friends-store.js";
import { buildAuthHeader, verifyRequest, MAX_CLOCK_SKEW_SEC } from "../src/core/peering/auth.js";
import { checkRelay, MAX_RELAY_BODY_BYTES } from "../src/core/peering/routes.js";

function makeIdentity(): NostrIdentity {
  return NostrIdentity.fromEd25519Seed(new Uint8Array(randomBytes(32)));
}

const REACH: ReachEntry[] = [
  { kind: "onion", url: "http://abcdefghijklmnop.onion", prio: DEFAULT_PRIORITY.onion },
  { kind: "lan", url: "http://purma-kernl.local:3087", prio: DEFAULT_PRIORITY.lan },
];

function makeDescriptor(identity: NostrIdentity) {
  return buildDescriptor(identity, {
    name: "purma",
    version: "0.1.0",
    reach: REACH,
    endpoints: { directories: "/api/cinema/directories" },
  });
}

describe("instance descriptor", () => {
  it("signs and verifies a round trip", () => {
    const id = makeIdentity();
    const event = signDescriptor(id, makeDescriptor(id));
    expect(event.kind).toBe(PRESENCE_KIND);

    const back = verifyDescriptor(event);
    expect(back).not.toBeNull();
    expect(back!.npub).toBe(id.npub());
    expect(back!.name).toBe("purma");
  });

  it("orders reach cheapest-first regardless of input order", () => {
    const id = makeIdentity();
    const d = makeDescriptor(id);
    expect(d.reach.map((r) => r.kind)).toEqual(["lan", "onion"]);
  });

  it("rejects a tampered descriptor", () => {
    const id = makeIdentity();
    const event = signDescriptor(id, makeDescriptor(id));
    const forged = {
      ...event,
      content: event.content.replace("purma", "evil"),
    };
    expect(verifyDescriptor(forged)).toBeNull();
  });

  it("rejects a descriptor claiming a key it was not signed with", () => {
    const mine = makeIdentity();
    const other = makeIdentity();
    // Claim someone else's npub while signing with our own key.
    const d = { ...makeDescriptor(mine), npub: other.npub() };
    const event = signDescriptor(mine, d);
    expect(verifyDescriptor(event)).toBeNull();
  });

  it("rejects a descriptor from an unexpected peer", () => {
    const a = makeIdentity();
    const b = makeIdentity();
    const event = signDescriptor(a, makeDescriptor(a));
    expect(verifyDescriptor(event, { expectNpub: b.npub() })).toBeNull();
    expect(verifyDescriptor(event, { expectNpub: a.npub() })).not.toBeNull();
  });

  it("drops unusable or dishonest reach entries", () => {
    expect(isSafeReach({ kind: "direct", url: "https://ok.example", prio: 1 })).toBe(true);
    expect(isSafeReach({ kind: "direct", url: "file:///etc/passwd", prio: 1 })).toBe(false);
    expect(isSafeReach({ kind: "direct", url: "not a url", prio: 1 })).toBe(false);
    // An onion entry must be an onion, and a clearnet entry must not claim to be one.
    expect(isSafeReach({ kind: "onion", url: "https://evil.example", prio: 1 })).toBe(false);
    expect(isSafeReach({ kind: "direct", url: "http://abc.onion", prio: 1 })).toBe(false);
  });

  it("strips bad reach entries during verification", () => {
    const id = makeIdentity();
    const d = makeDescriptor(id);
    d.reach.push({ kind: "direct", url: "file:///etc/shadow", prio: 1 });
    const event = signDescriptor(id, d);
    const back = verifyDescriptor(event)!;
    expect(back.reach.some((r) => r.url.startsWith("file:"))).toBe(false);
  });

  it("converts between npub and hex", () => {
    const id = makeIdentity();
    expect(hexOf(id.npub())).toBe(id.pubkeyHex);
    expect(npubOf(id.pubkeyHex)).toBe(id.npub());
    expect(hexOf("not-an-npub")).toBe("");
    expect(npubOf("zzzz")).toBe("");
  });
});

describe("friends store", () => {
  let store: FriendsStore;
  let friend: NostrIdentity;

  beforeEach(() => {
    store = new FriendsStore(new Database(":memory:"));
    friend = makeIdentity();
  });

  it("adds a friend as pending, never trusted by default", () => {
    const f = store.add({ npub: friend.npub(), petname: "matias" })!;
    expect(f.trust).toBe("pending");
    expect(store.isTrusted(friend.pubkeyHex)).toBe(false);
  });

  it("only trusts a friend the user promoted", () => {
    store.add({ npub: friend.npub() });
    store.update(friend.npub(), { trust: "trusted" });
    expect(store.isTrusted(friend.pubkeyHex)).toBe(true);
    expect(store.trusted()).toHaveLength(1);
  });

  it("keeps a revoked friend revoked when re-added", () => {
    store.add({ npub: friend.npub() });
    store.update(friend.npub(), { trust: "revoked" });
    store.add({ npub: friend.npub(), trust: "trusted" }); // a stale flow retries
    expect(store.get(friend.npub())!.trust).toBe("revoked");
    expect(store.isTrusted(friend.pubkeyHex)).toBe(false);
  });

  it("refuses a malformed npub", () => {
    expect(store.add({ npub: "npub-not-real" })).toBeUndefined();
    expect(store.list()).toHaveLength(0);
  });

  it("records reachability and errors without throwing", () => {
    store.add({ npub: friend.npub() });
    store.markSeen(friend.npub(), "http://x.onion");
    expect(store.get(friend.npub())!.last_reach).toBe("http://x.onion");
    store.markError(friend.npub(), "unreachable");
    expect(store.get(friend.npub())!.last_error).toBe("unreachable");
  });

  it("caches a verified presence document", () => {
    store.add({ npub: friend.npub() });
    store.cachePresence(friend.npub(), '{"kernl":1}', "nostr");
    expect(store.presence(friend.npub())!.source).toBe("nostr");
    store.cachePresence(friend.npub(), '{"kernl":1,"n":2}', "wellknown");
    expect(store.presence(friend.npub())!.descriptor).toContain('"n":2');
  });

  it("forgets the presence cache when a friend is removed", () => {
    store.add({ npub: friend.npub() });
    store.cachePresence(friend.npub(), "{}", "manual");
    store.remove(friend.npub());
    expect(store.presence(friend.npub())).toBeUndefined();
  });
});

describe("NIP-98 request auth", () => {
  const URL_A = "https://kernl.example/api/cinema/directories";
  let store: FriendsStore;
  let caller: NostrIdentity;

  beforeEach(() => {
    store = new FriendsStore(new Database(":memory:"));
    caller = makeIdentity();
    store.add({ npub: caller.npub() });
    store.update(caller.npub(), { trust: "trusted" });
  });

  function reqWith(token: string, method = "GET"): IncomingMessage {
    return { headers: { authorization: token }, method } as unknown as IncomingMessage;
  }

  it("accepts a trusted friend", async () => {
    const token = await buildAuthHeader(caller, URL_A, "GET");
    const res = await verifyRequest({ req: reqWith(token), url: URL_A, friends: store });
    expect(res.ok).toBe(true);
    expect(res.npub).toBe(caller.npub());
  });

  it("refuses a signer we do not know", async () => {
    const stranger = makeIdentity();
    const token = await buildAuthHeader(stranger, URL_A, "GET");
    const res = await verifyRequest({ req: reqWith(token), url: URL_A, friends: store });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("not a trusted friend");
  });

  it("refuses a friend who is only pending", async () => {
    const pending = makeIdentity();
    store.add({ npub: pending.npub() });
    const token = await buildAuthHeader(pending, URL_A, "GET");
    const res = await verifyRequest({ req: reqWith(token), url: URL_A, friends: store });
    expect(res.ok).toBe(false);
  });

  it("refuses a revoked friend", async () => {
    store.update(caller.npub(), { trust: "revoked" });
    const token = await buildAuthHeader(caller, URL_A, "GET");
    const res = await verifyRequest({ req: reqWith(token), url: URL_A, friends: store });
    expect(res.ok).toBe(false);
  });

  it("refuses a token replayed against another URL", async () => {
    const token = await buildAuthHeader(caller, URL_A, "GET");
    const res = await verifyRequest({
      req: reqWith(token),
      url: "https://kernl.example/api/peering/friends",
      friends: store,
    });
    expect(res.ok).toBe(false);
  });

  it("refuses a token replayed with another method", async () => {
    const token = await buildAuthHeader(caller, URL_A, "GET");
    const res = await verifyRequest({ req: reqWith(token, "DELETE"), url: URL_A, friends: store });
    expect(res.ok).toBe(false);
  });

  it("refuses a request with no Authorization at all", async () => {
    const res = await verifyRequest({
      req: { headers: {}, method: "GET" } as unknown as IncomingMessage,
      url: URL_A,
      friends: store,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("missing");
  });

  it("refuses a stale token", async () => {
    const stale = caller.signEvent({
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000) - (MAX_CLOCK_SKEW_SEC + 30),
      tags: [
        ["u", URL_A],
        ["method", "GET"],
      ],
      content: "",
    });
    const token = "Nostr " + Buffer.from(JSON.stringify(stale)).toString("base64");
    const res = await verifyRequest({ req: reqWith(token), url: URL_A, friends: store });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("clock skew");
  });

  it("binds the body so a payload cannot be swapped", async () => {
    const body = { directory: "a" };
    const token = await buildAuthHeader(caller, URL_A, "POST", body);
    const good = await verifyRequest({
      req: reqWith(token, "POST"),
      url: URL_A,
      friends: store,
      body,
    });
    expect(good.ok).toBe(true);

    const tampered = await verifyRequest({
      req: reqWith(token, "POST"),
      url: URL_A,
      friends: store,
      body: { directory: "b" },
    });
    expect(tampered.ok).toBe(false);
  });
});

describe("relay rules", () => {
  const A = "npub1sender";
  const B = "npub1target";
  const trustedSet = new Set([A, B]);
  const isTrusted = (n: string) => trustedSet.has(n);
  const base = { target: B, path: "/api/cinema/directories/friend-view", method: "GET", auth: "Nostr xyz" };

  it("carries a request between two trusted friends", () => {
    expect(checkRelay(base, A, isTrusted)).toEqual({ ok: true });
  });

  it("refuses when the sender is not trusted", () => {
    expect(checkRelay(base, "npub1stranger", isTrusted)).toMatchObject({ ok: false });
  });

  it("refuses when the target is not trusted — no open proxying", () => {
    expect(checkRelay({ ...base, target: "npub1stranger" }, A, isTrusted)).toMatchObject({ ok: false });
  });

  it("refuses to relay a relay", () => {
    expect(checkRelay({ ...base, path: "/api/peering/relay" }, A, isTrusted)).toMatchObject({
      ok: false,
      reason: "relay chaining",
    });
  });

  it("refuses a body over the cap", () => {
    const big = "x".repeat(MAX_RELAY_BODY_BYTES + 1);
    expect(checkRelay({ ...base, method: "POST", body: big }, A, isTrusted)).toMatchObject({ ok: false });
  });

  it("refuses an incomplete request or an odd method", () => {
    expect(checkRelay({ path: "/x", auth: "a" }, A, isTrusted)).toMatchObject({ ok: false });
    expect(checkRelay({ ...base, method: "DELETE" }, A, isTrusted)).toMatchObject({ ok: false });
  });

  it("refuses a request pointed back at the sender", () => {
    expect(checkRelay({ ...base, target: A }, A, isTrusted)).toMatchObject({ ok: false });
  });
});
