/**
 * The file-lane's LAN-facing surface, over real HTTP: these four routes are
 * token-exempt (PEER_AUTH_PATHS), so a NIP-98 signature from a *trusted*
 * friend is the only thing standing between them and anyone on the network.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { KernelHttpServer } from "../src/core/http-server.js";
import type { KernelConfig } from "../src/core/config.js";
import { FriendsStore } from "../src/core/peering/friends-store.js";
import { NostrIdentity } from "../src/core/nostr/nostr-identity.js";
import { buildAuthHeader } from "../src/core/peering/auth.js";
import { TransferStore } from "../src/core/social-net/file-lane/store.js";
import { TransferReceiver } from "../src/core/social-net/file-lane/receiver.js";
import { registerTransferPeerRoutes } from "../src/core/social-net/file-lane/peer-routes.js";
import { sha256Hex } from "../src/core/social-net/file-lane/chunks.js";

const hola = new TextEncoder().encode("hola");
const newIdentity = () => NostrIdentity.fromEd25519Seed(new Uint8Array(randomBytes(32)));

let server: KernelHttpServer;
let db: Database;
let base: string;
let store: TransferStore;
let friend: NostrIdentity;
let stranger: NostrIdentity;
let pendingFriend: NostrIdentity;
let receiver: TransferReceiver;

beforeEach(async () => {
  db = new Database(":memory:");
  const friends = new FriendsStore(db);
  friend = newIdentity();
  stranger = newIdentity();
  pendingFriend = newIdentity();
  friends.add({ npub: friend.npub(), petname: "Mac M4", trust: "trusted" });
  friends.setAutoAccept(friend.npub(), true);
  friends.add({ npub: pendingFriend.npub(), petname: "not yet", trust: "pending" });
  store = new TransferStore(db);
  receiver = new TransferReceiver({
    store, friends, dataDir: mkdtempSync(join(tmpdir(), "fl-routes-")), freeBytes: () => Number.MAX_SAFE_INTEGER,
  });
  server = new KernelHttpServer({
    config: { dashboard: { port: 0, bind: "127.0.0.1" }, auth: { token: "" }, cors: { allowedOrigins: [] } } as unknown as KernelConfig,
  });
  registerTransferPeerRoutes(server, { receiver, friends });
  expect(await server.start()).toBe(true);
  const addr = server.nodeServer!.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterEach(async () => {
  await server.stop();
  db.close();
});

type Call = { method: "GET" | "POST" | "PUT"; path: string; json?: unknown; bytes?: Uint8Array };

/** Send one request; `as` signs it like PeerClient does, omitted sends it unsigned. */
async function send(call: Call, as?: NostrIdentity): Promise<Response> {
  const url = base + call.path;
  const headers: Record<string, string> = {};
  if (as) headers.authorization = await buildAuthHeader(as, url, call.method, call.json);
  let body: BodyInit | undefined;
  if (call.json !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(call.json); }
  if (call.bytes) { headers["content-type"] = "application/octet-stream"; body = call.bytes as unknown as BodyInit; }
  return fetch(url, { method: call.method, headers, body });
}

const offer = (id: string): Call => ({
  method: "POST", path: "/api/peering/transfer/offer",
  json: { id, files: [{ name: "a.txt", size: 4, sha256: sha256Hex(hola) }] },
});
const allRoutes = (id: string): Call[] => [
  offer(id),
  { method: "GET", path: `/api/peering/transfer/${id}` },
  { method: "PUT", path: `/api/peering/transfer/${id}/files/0/chunks/0?sha=${sha256Hex(hola)}`, bytes: hola },
  { method: "POST", path: `/api/peering/transfer/${id}/cancel`, json: {} },
];

describe("file-lane peer routes", () => {
  it("answer 401 to an unsigned request on all four routes", async () => {
    for (const call of allRoutes("unsigned-01")) {
      const res = await send(call);
      expect(`${call.method} ${call.path} → ${res.status}`).toBe(`${call.method} ${call.path} → 401`);
    }
    expect(store.list()).toHaveLength(0);
  });

  it("answer 401 to a stranger's and a not-yet-trusted friend's signature on all four routes", async () => {
    for (const who of [stranger, pendingFriend]) {
      for (const call of allRoutes("stranger-01")) {
        const res = await send(call, who);
        expect(`${call.method} ${call.path} → ${res.status}`).toBe(`${call.method} ${call.path} → 401`);
      }
    }
    expect(store.list()).toHaveLength(0);
  });

  it("refuse a trusted friend's signature replayed on another route", async () => {
    const url = `${base}/api/peering/transfer/offer`;
    const auth = await buildAuthHeader(friend, url, "POST", offer("replay-001").json);
    const res = await fetch(`${base}/api/peering/transfer/replay-001`, { headers: { authorization: auth } });
    expect(res.status).toBe(401);
  });

  it("let a trusted friend through to the receiver: offer, status, part, cancel", async () => {
    const offered = await send(offer("trusted-01"), friend);
    expect(offered.status).toBe(200);
    expect(await offered.json()).toEqual({ state: "accepted" }); // auto-accepted friend

    const status = await send({ method: "GET", path: "/api/peering/transfer/trusted-01" }, friend);
    expect(status.status).toBe(200);
    expect(((await status.json()) as { state: string }).state).toBe("accepted");

    const part = await send(allRoutes("trusted-01")[2], friend);
    expect(part.status).toBe(200);
    expect(await part.json()).toEqual({ result: "ok" });
    expect(store.getByRemote("in", friend.npub(), "trusted-01")?.state).toBe("done");

    // A second, still-open transfer to cancel.
    await send(offer("trusted-02"), friend);
    const cancelled = await send({ method: "POST", path: "/api/peering/transfer/trusted-02/cancel", json: {} }, friend);
    expect(cancelled.status).toBe(200);
    expect(store.getByRemote("in", friend.npub(), "trusted-02")?.state).toBe("cancelled");
  });

  it("does not let one friend read another friend's transfer", async () => {
    await send(offer("private-01"), friend);
    const other = newIdentity();
    const friends = new FriendsStore(db);
    friends.add({ npub: other.npub(), petname: "other", trust: "trusted" });
    const res = await send({ method: "GET", path: "/api/peering/transfer/private-01" }, other);
    expect(res.status).toBe(404);
  });

  it("answers 507 with the missing space when the disk fills up mid-transfer, 422 for other write errors", async () => {
    const deps = (receiver as unknown as { deps: { io?: unknown; freeBytes: () => number } }).deps;
    deps.io = { writeAt: async () => { throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }); } };
    await send(offer("full-disk1"), friend);
    deps.freeBytes = () => 1;
    const full = await send(allRoutes("full-disk1")[2], friend);
    expect(full.status).toBe(507);
    expect(((await full.json()) as { error: string }).error).toMatch(/3 B more free space is needed/);

    deps.freeBytes = () => Number.MAX_SAFE_INTEGER;
    deps.io = { writeAt: async () => { throw Object.assign(new Error("EIO"), { code: "EIO" }); } };
    await send(offer("broken-01"), friend);
    const broken = await send(allRoutes("broken-01")[2], friend);
    expect(broken.status).toBe(422);
    expect(((await broken.json()) as { error: string }).error).toMatch(/EIO/);
  });
});

describe("removing a friend", () => {
  it("cancels what is in flight with them (onRevoked) before the row goes", async () => {
    const { registerPeeringRoutes } = await import("../src/core/peering/routes.js");
    const pdb = new Database(":memory:");
    const friends = new FriendsStore(pdb);
    const who = newIdentity();
    friends.add({ npub: who.npub(), petname: "gone soon", trust: "trusted" });
    const seen: Array<{ npub: string; stillThere: boolean }> = [];
    const srv = new KernelHttpServer({
      config: { dashboard: { port: 0, bind: "127.0.0.1" }, auth: { token: "" }, cors: { allowedOrigins: [] } } as unknown as KernelConfig,
    });
    registerPeeringRoutes(srv, {
      friends,
      resolver: {} as never,
      currentDescriptor: () => null,
      selfNpub: () => "npub1self",
      onRevoked: (npub) => seen.push({ npub, stillThere: !!friends.get(npub) }),
    });
    expect(await srv.start()).toBe(true);
    try {
      const addr = srv.nodeServer!.address();
      const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api/peering/friends/${who.npub()}`;
      expect((await fetch(url, { method: "DELETE" })).status).toBe(200);
      expect(seen).toEqual([{ npub: who.npub(), stillThere: true }]);
      expect(friends.get(who.npub())).toBeFalsy();
    } finally {
      await srv.stop();
      pdb.close();
    }
  });
});
