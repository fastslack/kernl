// services/kernel/tests/file-lane-worker.test.ts
/**
 * Two kernels in one process: the sender's worker talks to a fake transport
 * that calls the receiver's TransferReceiver directly.
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { TransferStore } from "../src/core/social-net/file-lane/store.js";
import { TransferReceiver } from "../src/core/social-net/file-lane/receiver.js";
import { TransferWorker, type PeerTransport } from "../src/core/social-net/file-lane/worker.js";
import { FriendsStore } from "../src/core/peering/friends-store.js";
import { NostrIdentity } from "../src/core/nostr/nostr-identity.js";
import { sha256File } from "../src/core/social-net/file-lane/chunks.js";
import { CHUNK_SIZE } from "../src/core/social-net/file-lane/limits.js";

function pair(opts: { autoAccept?: boolean } = {}) {
  const sender = NostrIdentity.fromEd25519Seed(new Uint8Array(randomBytes(32)));
  const rxDb = new Database(":memory:");
  const rxFriends = new FriendsStore(rxDb);
  rxFriends.add({ npub: sender.npub(), petname: "purma", trust: "trusted" });
  if (opts.autoAccept) rxFriends.setAutoAccept(sender.npub(), true);
  const rxStore = new TransferStore(rxDb);
  const rx = new TransferReceiver({ store: rxStore, friends: rxFriends, dataDir: mkdtempSync(join(tmpdir(), "rx-")), freeBytes: () => 1e12 });

  let online = true;
  let dropNextChunk = false;
  let chunkFault: null | "flaky" | number = null;
  let chunkCalls = 0;
  const peer: PeerTransport = {
    async post(_npub, path, body) {
      if (!online) return { ok: false, status: 0, error: "unreachable" };
      if (path === "/api/peering/transfer/offer") return { ok: true, status: 200, data: await rx.offer(sender.npub(), body as never) as never };
      const id = path.split("/")[4];
      rx.cancelFromPeer(sender.npub(), id);
      return { ok: true, status: 200, data: { state: "cancelled" } as never };
    },
    async get(_npub, path) {
      if (!online) return { ok: false, status: 0, error: "unreachable" };
      const s = rx.status(sender.npub(), path.split("/").pop()!);
      return s ? { ok: true, status: 200, data: s as never } : { ok: false, status: 404 };
    },
    async putBinary(_npub, path, data) {
      if (!online) return { ok: false, status: 0, error: "unreachable" };
      if (typeof chunkFault === "number") return { ok: false, status: chunkFault, data: { error: "boom" } };
      if (chunkFault === "flaky" && chunkCalls++ % 3 !== 0) return { ok: false, status: 0, error: "reset" };
      if (dropNextChunk) { dropNextChunk = false; online = false; return { ok: false, status: 0, error: "reset" }; }
      const u = new URL(path, "http://x");
      const [, , , , id, , n, , k] = u.pathname.split("/");
      const r = await rx.putChunk(sender.npub(), id, Number(n), Number(k), u.searchParams.get("sha")!, data);
      return { ok: r === "ok", status: r === "ok" ? 200 : 409, data: { result: r } };
    },
  };

  const txDb = new Database(":memory:");
  const txStore = new TransferStore(txDb);
  const txDir = mkdtempSync(join(tmpdir(), "tx-"));
  let clock = Date.now();
  const worker = new TransferWorker({ store: txStore, peer, dataDir: txDir, now: () => clock });
  return {
    rx, rxStore, txStore, worker, txDir,
    now: () => clock,
    setChunkFault: (v: null | "flaky" | number) => { chunkFault = v; chunkCalls = 0; },
    advance: (ms: number) => { clock += ms; },
    setOnline: (v: boolean) => { online = v; },
    dropNext: () => { dropNextChunk = true; },
  };
}

async function outgoing(p: ReturnType<typeof pair>, bytes: Uint8Array) {
  const path = join(p.txDir, "src.bin");
  writeFileSync(path, bytes);
  const t = p.txStore.create({ direction: "out", peerNpub: "npub1mac", state: "pending",
    files: [{ name: "src.bin", size: bytes.length, sha256: await sha256File(path), path }] });
  p.txStore.schedule(t.id, { nextAt: 0 });
  return t;
}

async function runUntilSettled(p: ReturnType<typeof pair>, rounds = 30) {
  for (let i = 0; i < rounds; i++) { await p.worker.tick(); p.advance(60 * 60 * 1000); }
}

describe("TransferWorker", () => {
  it("sends a multi-part file end to end to an auto-accepting friend", async () => {
    const p = pair({ autoAccept: true });
    const bytes = new Uint8Array(randomBytes(CHUNK_SIZE + 1234));
    const t = await outgoing(p, bytes);
    await runUntilSettled(p);
    expect(p.txStore.get(t.id)?.state).toBe("done");
    const rxT = p.rxStore.list()[0];
    const rxFile = p.rxStore.files(rxT.id)[0];
    expect(readFileSync(rxFile.path).equals(Buffer.from(bytes))).toBe(true);
  });

  it("waits while the offer is pending, then sends once accepted", async () => {
    const p = pair();
    const t = await outgoing(p, new Uint8Array(randomBytes(100)));
    await p.worker.tick();
    expect(p.txStore.get(t.id)?.state).toBe("pending");
    await p.rx.accept(p.rxStore.list()[0].id);
    await runUntilSettled(p);
    expect(p.txStore.get(t.id)?.state).toBe("done");
  });

  it("resumes after the connection drops mid-file", async () => {
    const p = pair({ autoAccept: true });
    const t = await outgoing(p, new Uint8Array(randomBytes(CHUNK_SIZE * 2 + 10)));
    p.dropNext();
    await p.worker.tick(); // sends the offer; auto-accepted, the upload starts on the next tick
    await p.worker.tick(); // first part hits the dropped connection
    expect(p.txStore.get(t.id)?.state).not.toBe("done");
    p.setOnline(true);
    await runUntilSettled(p);
    expect(p.txStore.get(t.id)?.state).toBe("done");
  });

  it("gives up after six hours of an unreachable friend", async () => {
    const p = pair();
    const t = await outgoing(p, new Uint8Array(10));
    p.setOnline(false);
    await runUntilSettled(p, 10);
    expect(p.txStore.get(t.id)?.state).toBe("failed");
  });

  it("does not give up while each round still makes progress, even over more than six hours", async () => {
    const p = pair({ autoAccept: true });
    const t = await outgoing(p, new Uint8Array(randomBytes(CHUNK_SIZE * 9 + 5)));
    p.setChunkFault("flaky"); // one part of every batch of three gets through, the rest drop
    for (let i = 0; i < 9; i++) { await p.worker.tick(); p.advance(45 * 60 * 1000); }
    expect(p.now() - Date.parse(p.txStore.get(t.id)!.created_at)).toBeGreaterThan(6 * 3600_000);
    expect(p.txStore.get(t.id)?.state).not.toBe("failed");
    p.setChunkFault(null);
    await runUntilSettled(p, 10);
    expect(p.txStore.get(t.id)?.state).toBe("done");
  });

  it("backs off and finally fails when the receiver answers 500 to every part", async () => {
    const p = pair({ autoAccept: true });
    const t = await outgoing(p, new Uint8Array(randomBytes(100)));
    p.setChunkFault(500);
    await p.worker.tick(); // offer
    await p.worker.tick(); // upload hits 500
    const row = p.txStore.get(t.id)!;
    expect(row.state).not.toBe("failed");
    expect(Date.parse(row.next_attempt_at!)).toBeGreaterThan(p.now());
    expect(Date.parse(row.next_attempt_at!) - p.now()).toBeLessThanOrEqual(3600_000);
    await runUntilSettled(p, 10);
    expect(p.txStore.get(t.id)?.state).toBe("failed");
  });

  it("fails with a reason, instead of retrying every tick, when the file to send vanished", async () => {
    const p = pair({ autoAccept: true });
    const t = await outgoing(p, new Uint8Array(randomBytes(100)));
    await p.worker.tick(); // offer, auto-accepted
    rmSync(p.txStore.files(t.id)[0].path); // moved or deleted from Files before the upload
    await p.worker.tick();
    const row = p.txStore.get(t.id)!;
    expect(row.state).toBe("failed");
    expect(row.error).toBe("the file to send is no longer available");
    expect(row.next_attempt_at).toBeNull();
    expect(p.txStore.due(p.now() + 3600_000)).toHaveLength(0);
  });

  it("fails when the file to send shrank since it was offered", async () => {
    const p = pair({ autoAccept: true });
    const t = await outgoing(p, new Uint8Array(randomBytes(100)));
    await p.worker.tick();
    writeFileSync(p.txStore.files(t.id)[0].path, new Uint8Array(10));
    await p.worker.tick();
    expect(p.txStore.get(t.id)?.state).toBe("failed");
    expect(p.txStore.get(t.id)?.error).toMatch(/changed/);
  });

  it("a receiver out of space (507) or unable to write (422) fails the transfer at once, with its reason", async () => {
    for (const status of [507, 422]) {
      const p = pair({ autoAccept: true });
      const t = await outgoing(p, new Uint8Array(randomBytes(100)));
      await p.worker.tick();
      p.setChunkFault(status);
      await p.worker.tick();
      expect(p.txStore.get(t.id)?.state).toBe("failed");
      expect(p.txStore.get(t.id)?.error).toBe("boom");
    }
  });

  it("keeps network failures on the backoff path", async () => {
    const p = pair({ autoAccept: true });
    const t = await outgoing(p, new Uint8Array(randomBytes(100)));
    await p.worker.tick();
    p.setOnline(false);
    await p.worker.tick();
    const row = p.txStore.get(t.id)!;
    expect(row.state).not.toBe("failed");
    expect(Date.parse(row.next_attempt_at!)).toBeGreaterThan(p.now());
  });

  it("mirrors a rejection", async () => {
    const p = pair();
    const t = await outgoing(p, new Uint8Array(10));
    await p.worker.tick();
    p.rx.reject(p.rxStore.list()[0].id);
    await runUntilSettled(p, 3);
    expect(p.txStore.get(t.id)?.state).toBe("rejected");
  });

  it("expires offers nobody answered in 24 h", async () => {
    const p = pair();
    const t = await outgoing(p, new Uint8Array(10));
    await p.worker.tick();
    p.advance(25 * 3600_000);
    await p.worker.housekeeping();
    expect(p.txStore.get(t.id)?.state).toBe("expired");
  });
});
