/**
 * Persona link-proofs over peering: only a trusted friend may ask which public
 * persona runs on this instance, and what comes back is checked before it is
 * believed.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { KernelHttpServer } from "../src/core/http-server.js";
import type { KernelConfig } from "../src/core/config.js";
import { FriendsStore } from "../src/core/peering/friends-store.js";
import { NostrIdentity } from "../src/core/nostr/nostr-identity.js";
import { buildAuthHeader } from "../src/core/peering/auth.js";
import { registerPeeringRoutes } from "../src/core/peering/routes.js";
import { PeerClient } from "../src/core/peering/client.js";
import type { PeerResolver } from "../src/core/peering/resolver.js";
import { isPeerAuthenticatedPath } from "../src/core/auth.js";
import {
  buildLinkProof,
  openLinkProof,
  sealLinkProof,
  verifyLinkProof,
  type LinkProof,
} from "../src/core/social-net/link-proof.js";
import { PeeringService, PERSONA_REFRESH_MS, PERSONA_RETRY_MS } from "../src/core/peering/service.js";

const newIdentity = () => NostrIdentity.fromEd25519Seed(new Uint8Array(randomBytes(32)));

describe("GET /api/peering/persona", () => {
  let server: KernelHttpServer;
  let db: Database;
  let base: string;
  let me: NostrIdentity;
  let persona: NostrIdentity;
  let friend: NostrIdentity;
  let stranger: NostrIdentity;
  let revoked: NostrIdentity;
  let pending: NostrIdentity;
  let proof: LinkProof | null;
  let sealing: boolean;

  beforeEach(async () => {
    db = new Database(":memory:");
    const friends = new FriendsStore(db);
    me = newIdentity();
    persona = newIdentity();
    friend = newIdentity();
    stranger = newIdentity();
    revoked = newIdentity();
    pending = newIdentity();
    friends.add({ npub: friend.npub(), trust: "trusted" });
    friends.add({ npub: pending.npub(), trust: "pending" });
    friends.add({ npub: revoked.npub(), trust: "revoked" });
    proof = buildLinkProof(me, persona);
    sealing = true;
    server = new KernelHttpServer({
      config: { dashboard: { port: 0, bind: "127.0.0.1" }, auth: { token: "" }, cors: { allowedOrigins: [] } } as unknown as KernelConfig,
    });
    registerPeeringRoutes(server, {
      friends,
      resolver: {} as PeerResolver,
      currentDescriptor: () => null,
      selfNpub: () => me.npub(),
      personaProof: () => proof,
      sealPersonaProof: (p, friendHex) => {
        if (!sealing) throw new Error("unreachable: route must not seal without a sealer");
        return sealLinkProof(p, me.secretKey, friendHex);
      },
    });
    expect(await server.start()).toBe(true);
    const addr = server.nodeServer!.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterEach(async () => {
    await server.stop();
    db.close();
  });

  async function get(as?: NostrIdentity): Promise<Response> {
    const url = `${base}/api/peering/persona`;
    const headers: Record<string, string> = {};
    if (as) headers.authorization = await buildAuthHeader(as, url, "GET");
    return fetch(url, { headers });
  }

  it("is exempt from the operator token, never from peer auth", () => {
    expect(isPeerAuthenticatedPath("/api/peering/persona")).toBe(true);
  });

  it("hands a trusted friend a sealed proof that only they can open", async () => {
    const res = await get(friend);
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    // Ciphertext only: no persona key, no signature, nothing else in the clear.
    expect(Object.keys(body).sort()).toEqual(["nip44", "v"]);
    expect(body.v).toBe(1);
    expect(text).not.toContain(persona.pubkeyHex);
    expect(text).not.toContain(me.pubkeyHex);
    expect(text).not.toContain(proof!.persona_sig);

    const r = verifyLinkProof(openLinkProof(body, friend.secretKey, me.pubkeyHex), me.pubkeyHex);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.proof.persona).toBe(persona.pubkeyHex);

    // Anyone else who captured it — a stranger, or us — cannot read it.
    expect(openLinkProof(body, stranger.secretKey, me.pubkeyHex)).toBeNull();
    expect(openLinkProof(body, stranger.secretKey, friend.pubkeyHex)).toBeNull();
  });

  it("refuses strangers, pending and revoked friends with 403, unsigned with 401", async () => {
    expect((await get(stranger)).status).toBe(403);
    expect((await get(pending)).status).toBe(403);
    expect((await get(revoked)).status).toBe(403);
    expect((await get()).status).toBe(401);
  });

  it("answers 404 when no persona is registered", async () => {
    proof = null;
    expect((await get(friend)).status).toBe(404);
    // ...but a stranger still learns nothing, not even that there is none.
    expect((await get(stranger)).status).toBe(403);
  });
});

describe("PeerClient.fetchPersona", () => {
  const me = newIdentity();
  const friendInstance = newIdentity();
  const friendPersona = newIdentity();
  const sealed = (p: LinkProof, from = friendInstance, to = me) => sealLinkProof(p, from.secretKey, to.pubkeyHex);

  function setup(answer: unknown, status = 200) {
    const db = new Database(":memory:");
    const friends = new FriendsStore(db);
    friends.add({ npub: friendInstance.npub(), trust: "trusted" });
    const seen: string[] = [];
    const resolver = { resolve: async () => ({ kind: "lan", origin: "http://friend.test" }) } as unknown as PeerResolver;
    const client = new PeerClient({
      identity: me,
      friends,
      resolver,
      fetchImpl: (async (url: string, init?: RequestInit) => {
        seen.push(`${init?.method ?? "GET"} ${url} ${String((init?.headers as Record<string, string>)?.authorization ?? "").slice(0, 6)}`);
        return new Response(JSON.stringify(answer), { status, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch,
    });
    return { friends, client, seen };
  }

  it("stores the persona of a friend whose proof checks out", async () => {
    const { friends, client, seen } = setup(sealed(buildLinkProof(friendInstance, friendPersona)));
    const out = await client.fetchPersona(friendInstance.npub());
    expect(out).toBe(friendPersona.pubkeyHex);
    expect(seen).toEqual(["GET http://friend.test/api/peering/persona Nostr "]);
    expect(friends.get(friendInstance.npub())!.persona_npub).toBe(friendPersona.npub());
    expect(friends.trustedPersonas()).toEqual([friendPersona.pubkeyHex]);
  });

  it("ignores a proof signed for another instance", async () => {
    const { friends, client } = setup(sealed(buildLinkProof(newIdentity(), friendPersona)));
    expect(await client.fetchPersona(friendInstance.npub())).toBeNull();
    expect(friends.get(friendInstance.npub())!.persona_npub).toBe("");
  });

  it("ignores a proof sent in the clear", async () => {
    const { friends, client } = setup(buildLinkProof(friendInstance, friendPersona));
    expect(await client.fetchPersonaOutcome(friendInstance.npub())).toEqual({ persona: null, definitive: true });
    expect(friends.get(friendInstance.npub())!.persona_npub).toBe("");
  });

  it("ignores a proof sealed for someone else", async () => {
    const { friends, client } = setup(sealed(buildLinkProof(friendInstance, friendPersona), friendInstance, newIdentity()));
    expect(await client.fetchPersona(friendInstance.npub())).toBeNull();
    expect(friends.get(friendInstance.npub())!.persona_npub).toBe("");
  });

  it("reports which answers are definitive", async () => {
    const npub = friendInstance.npub();
    expect((await setup(sealed(buildLinkProof(friendInstance, friendPersona))).client.fetchPersonaOutcome(npub)).definitive).toBe(true);
    expect((await setup({ error: "no persona" }, 404).client.fetchPersonaOutcome(npub)).definitive).toBe(true);
    expect((await setup({ error: "refused" }, 403).client.fetchPersonaOutcome(npub)).definitive).toBe(true);
    expect((await setup({ error: "boom" }, 500).client.fetchPersonaOutcome(npub)).definitive).toBe(false);
  });

  it("network errors are not definitive", async () => {
    const db = new Database(":memory:");
    const friends = new FriendsStore(db);
    friends.add({ npub: friendInstance.npub(), trust: "trusted" });
    const client = new PeerClient({
      identity: me,
      friends,
      resolver: { resolve: async () => ({ kind: "lan", origin: "http://friend.test" }) } as unknown as PeerResolver,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    expect(await client.fetchPersonaOutcome(friendInstance.npub())).toEqual({ persona: null, definitive: false });
  });

  it("tells its owner every time a friend answers, and only then", async () => {
    const db = new Database(":memory:");
    const friends = new FriendsStore(db);
    friends.add({ npub: friendInstance.npub(), trust: "trusted" });
    const answered: string[] = [];
    let status = 200;
    const client = new PeerClient({
      identity: me,
      friends,
      resolver: { resolve: async () => ({ kind: "lan", origin: "http://friend.test" }) } as unknown as PeerResolver,
      fetchImpl: (async () => new Response("{}", { status })) as unknown as typeof fetch,
      onFriendAnswered: (npub) => answered.push(npub),
    });
    await client.get(friendInstance.npub(), "/api/cinema/directories");
    expect(answered).toEqual([friendInstance.npub()]);
    status = 500;
    await client.get(friendInstance.npub(), "/api/cinema/directories");
    expect(answered).toEqual([friendInstance.npub()]);
  });

  it("forgets a persona the friend no longer has", async () => {
    const { friends, client } = setup({ error: "no persona" }, 404);
    friends.setPersona(friendInstance.npub(), friendPersona.npub());
    expect(await client.fetchPersona(friendInstance.npub())).toBeNull();
    expect(friends.get(friendInstance.npub())!.persona_npub).toBe("");
  });

  it("keeps what it knew when the friend is just unreachable", async () => {
    const { friends, client } = setup({ error: "boom" }, 500);
    friends.setPersona(friendInstance.npub(), friendPersona.npub());
    expect(await client.fetchPersona(friendInstance.npub())).toBeNull();
    expect(friends.get(friendInstance.npub())!.persona_npub).toBe(friendPersona.npub());
  });
});

describe("FriendsStore persona column", () => {
  it("migrates an older table without losing rows", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE kernl_friends (
      npub TEXT PRIMARY KEY, pubkey_hex TEXT NOT NULL, petname TEXT NOT NULL DEFAULT '',
      trust TEXT NOT NULL DEFAULT 'pending', added_by TEXT NOT NULL DEFAULT 'local',
      note TEXT NOT NULL DEFAULT '', last_seen_at TEXT, last_reach TEXT NOT NULL DEFAULT '',
      last_error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    const old = newIdentity();
    db.prepare(`INSERT INTO kernl_friends (npub, pubkey_hex, petname, trust, created_at, updated_at) VALUES (?, ?, 'viejo', 'trusted', 'x', 'x')`)
      .run(old.npub(), old.pubkeyHex);

    const friends = new FriendsStore(db);
    const row = friends.get(old.npub())!;
    expect(row.petname).toBe("viejo");
    expect(row.persona_npub).toBe("");
    expect(friends.trustedPersonas()).toEqual([]);
    new FriendsStore(db); // idempotent
    expect(friends.list()).toHaveLength(1);
  });

  it("only reports personas of trusted friends", () => {
    const friends = new FriendsStore(new Database(":memory:"));
    const a = newIdentity();
    const b = newIdentity();
    const pa = newIdentity();
    const pb = newIdentity();
    friends.add({ npub: a.npub(), trust: "trusted" });
    friends.add({ npub: b.npub(), trust: "pending" });
    friends.setPersona(a.npub(), pa.npub());
    friends.setPersona(b.npub(), pb.npub());
    expect(friends.trustedPersonas()).toEqual([pa.pubkeyHex]);
    friends.update(a.npub(), { trust: "revoked" });
    expect(friends.trustedPersonas()).toEqual([]);
  });
});

describe("PeeringService.registerPersona", () => {
  function service(): PeeringService {
    const s = PeeringService.create({
      sqlite: new Database(":memory:") as never,
      encryptionKey: "",
      version: "test",
      port: 0,
      dataDir: "/nonexistent-kernl-test",
    });
    expect(s).not.toBeNull();
    return s!;
  }

  afterEach(() => { PeeringService.current = null; });

  it("keeps only a proof, and the first persona wins", () => {
    const s = service();
    const persona = newIdentity();
    expect(s.personaLinkProof()).toBeNull();
    expect(s.registerPersona(persona)).toBe(true);
    const first = s.personaLinkProof()!;
    expect(verifyLinkProof(first, s.identity.pubkeyHex).ok).toBe(true);
    expect(first.persona).toBe(persona.pubkeyHex);
    expect(JSON.stringify(first)).not.toContain(Buffer.from(persona.secretKey).toString("hex"));

    // Same persona again: no-op. Another persona: ignored.
    expect(s.registerPersona(persona)).toBe(true);
    expect(s.personaLinkProof()).toBe(first);
    expect(s.registerPersona(newIdentity())).toBe(false);
    expect(s.personaLinkProof()!.persona).toBe(persona.pubkeyHex);

    // Withdrawn, then a new one may register.
    s.registerPersona(null);
    expect(s.personaLinkProof()).toBeNull();
    const next = newIdentity();
    expect(s.registerPersona(next)).toBe(true);
    expect(s.personaLinkProof()!.persona).toBe(next.pubkeyHex);
  });

  it("ignores a persona that is the instance key itself", () => {
    const s = service();
    expect(s.registerPersona(s.identity)).toBe(false);
    expect(s.personaLinkProof()).toBeNull();
  });

  it("nothing waits in a process-wide slot for a service created later", () => {
    expect(Object.keys(globalThis).some((k) => k.toLowerCase().includes("persona"))).toBe(false);
    expect(service().personaLinkProof()).toBeNull();
  });
});

describe("PeeringService persona refresh (trigger + throttle)", () => {
  afterEach(() => { PeeringService.current = null; });

  function setup() {
    const db = new Database(":memory:");
    const s = PeeringService.create({
      sqlite: db as never,
      encryptionKey: "",
      version: "test",
      port: 0,
      dataDir: "/nonexistent-kernl-test",
    })!;
    let clock = 1_000_000;
    s.now = () => clock;
    const calls: string[] = [];
    const pending: Array<(o: { persona: string | null; definitive: boolean }) => void> = [];
    let mode: "definitive" | "network" | "hang" = "definitive";
    (s.client as unknown as { fetchPersonaOutcome: (npub: string) => Promise<unknown> }).fetchPersonaOutcome = (npub) => {
      calls.push(npub);
      if (mode === "hang") return new Promise((r) => pending.push(r));
      return Promise.resolve({ persona: null, definitive: mode === "definitive" });
    };
    return {
      s,
      calls,
      pending,
      setMode: (m: typeof mode) => { mode = m; },
      advance: (ms: number) => { clock += ms; },
    };
  }

  it("asks once per 6h after a definitive answer", async () => {
    const { s, calls, advance } = setup();
    await s.refreshPersona("npub1a");
    await s.refreshPersona("npub1a");
    expect(calls).toEqual(["npub1a"]);
    advance(PERSONA_REFRESH_MS - 1);
    await s.refreshPersona("npub1a");
    expect(calls).toHaveLength(1);
    advance(2);
    await s.refreshPersona("npub1a");
    expect(calls).toHaveLength(2);
  });

  it("retries after 10 minutes when the friend did not answer", async () => {
    const { s, calls, setMode, advance } = setup();
    setMode("network");
    await s.refreshPersona("npub1a");
    advance(PERSONA_RETRY_MS - 1);
    await s.refreshPersona("npub1a");
    expect(calls).toHaveLength(1);
    advance(2);
    await s.refreshPersona("npub1a");
    expect(calls).toHaveLength(2);
    expect(PERSONA_RETRY_MS).toBeLessThan(PERSONA_REFRESH_MS);
  });

  it("sets no throttle until the fetch completes, and never runs two at once", async () => {
    const { s, calls, pending, setMode } = setup();
    setMode("hang");
    const first = s.refreshPersona("npub1a");
    await s.refreshPersona("npub1a"); // in flight: skipped, not queued
    await s.refreshPersona("npub1a", { force: true }); // force does not bypass the in-flight guard
    expect(calls).toEqual(["npub1a"]);
    // Still in flight → nothing recorded: once it ends without an answer, the
    // short retry window applies, not 6h.
    pending[0]!({ persona: null, definitive: false });
    await first;
    setMode("definitive");
    await s.refreshPersona("npub1a");
    expect(calls).toHaveLength(1); // inside the 10-min retry window
  });

  it("asks a friend the moment it becomes trusted, throttle or not", async () => {
    const { s, calls } = setup();
    const f = newIdentity().npub();
    s.friends.add({ npub: f, trust: "pending" });
    expect(calls).toEqual([]);
    await s.refreshPersona(f); // sets a 6h throttle
    expect(calls).toEqual([f]);
    s.friends.update(f, { trust: "trusted" });
    await Promise.resolve();
    expect(calls).toEqual([f, f]);
    // Already trusted: a no-op update does not ask again.
    s.friends.update(f, { trust: "trusted", petname: "x" });
    await Promise.resolve();
    expect(calls).toEqual([f, f]);
    // Added directly as trusted: asked too.
    const g = newIdentity().npub();
    s.friends.add({ npub: g, trust: "trusted" });
    await Promise.resolve();
    expect(calls).toEqual([f, f, g]);
  });

  it("a successful request to a friend triggers a (throttled) refresh", async () => {
    const { s, calls } = setup();
    const hook = (s.client as unknown as { deps: { onFriendAnswered?: (npub: string) => void } }).deps.onFriendAnswered;
    expect(typeof hook).toBe("function");
    hook!("npub1x");
    await Promise.resolve();
    hook!("npub1x");
    await Promise.resolve();
    expect(calls).toEqual(["npub1x"]);
  });
});
