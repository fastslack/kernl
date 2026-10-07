import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { TransferStore } from "../src/core/social-net/file-lane/store.js";
import { TransferReceiver, OfferError } from "../src/core/social-net/file-lane/receiver.js";
import { FriendsStore } from "../src/core/peering/friends-store.js";
import { NostrIdentity } from "../src/core/nostr/nostr-identity.js";
import { sha256Hex, EMPTY_SHA256 } from "../src/core/social-net/file-lane/chunks.js";

function setup(opts: { autoAccept?: boolean; free?: number; io?: ConstructorParameters<typeof TransferReceiver>[0]["io"] } = {}) {
  const db = new Database(":memory:");
  const friends = new FriendsStore(db);
  const mac = NostrIdentity.fromEd25519Seed(new Uint8Array(randomBytes(32)));
  friends.add({ npub: mac.npub(), petname: "Mac M4", trust: "trusted" });
  if (opts.autoAccept) friends.setAutoAccept(mac.npub(), true);
  const store = new TransferStore(db);
  const dataDir = mkdtempSync(join(tmpdir(), "fl-rx-"));
  const notified: string[] = [];
  const rx = new TransferReceiver({
    store, friends, dataDir,
    notify: (t) => notified.push(t.id),
    freeBytes: () => opts.free ?? Number.MAX_SAFE_INTEGER,
    io: opts.io,
  });
  return { rx, store, friends, npub: mac.npub(), dataDir, notified };
}

const hola = new TextEncoder().encode("hola");

describe("TransferReceiver", () => {
  it("text-only offers land as done without asking", async () => {
    const { rx, store, npub, notified } = setup();
    expect((await rx.offer(npub, { id: "text-0001", text: "mirá esto", files: [] })).state).toBe("done");
    expect(store.getByRemote("in", npub, "text-0001")?.text).toBe("mirá esto");
    expect(notified).toHaveLength(1);
  });

  it("file offers wait for the owner, and a repeated offer is not a second transfer", async () => {
    const { rx, store, npub } = setup();
    const body = { id: "files-0001", files: [{ name: "a.txt", size: 4, sha256: sha256Hex(hola) }] };
    expect((await rx.offer(npub, body)).state).toBe("pending");
    expect((await rx.offer(npub, body)).state).toBe("pending");
    expect(store.pendingIncomingCount(npub)).toBe(1);
  });

  it("refuses the sixth pending offer, oversize files and a full disk", async () => {
    const { rx, npub } = setup({ free: 10 });
    for (let i = 0; i < 5; i++) await rx.offer(npub, { id: `pending-${i}`, files: [{ name: "x", size: 1, sha256: "a".repeat(64) }] });
    await expect(rx.offer(npub, { id: "pending-6", files: [{ name: "x", size: 1, sha256: "a".repeat(64) }] })).rejects.toBeInstanceOf(OfferError);
    const other = setup({ free: 10 });
    await expect(other.rx.offer(other.npub, { id: "big-file1", files: [{ name: "x", size: 11, sha256: "a".repeat(64) }] }))
      .rejects.toThrow(/space/);
  });

  it("accepts, receives a part, verifies it and finishes the file", async () => {
    const { rx, store, npub, dataDir } = setup();
    await rx.offer(npub, { id: "accept-0001", files: [{ name: "../evil/a.txt", size: 4, sha256: sha256Hex(hola) }] });
    const t = store.getByRemote("in", npub, "accept-0001")!;
    expect(await rx.putChunk(npub, "accept-0001", 0, 0, sha256Hex(hola), hola)).toBe("not-accepted");
    await rx.accept(t.id);
    expect(await rx.putChunk(npub, "accept-0001", 0, 0, "0".repeat(64), hola)).toBe("bad-hash");
    expect(await rx.putChunk(npub, "accept-0001", 0, 0, sha256Hex(hola), hola)).toBe("ok");
    const f = store.files(t.id)[0];
    expect(f.path.startsWith(join(dataDir, "transfers", "incoming", "Mac M4"))).toBe(true);
    expect(f.path.endsWith("a.txt")).toBe(true);
    expect(readFileSync(f.path, "utf8")).toBe("hola");
    expect(store.get(t.id)?.state).toBe("done");
  });

  it("zero-byte files complete on accept", async () => {
    const { rx, store, npub } = setup({ autoAccept: true });
    expect((await rx.offer(npub, { id: "zero-0001", files: [{ name: "vacio.txt", size: 0, sha256: EMPTY_SHA256 }] })).state).toBe("done");
    const f = store.files(store.getByRemote("in", npub, "zero-0001")!.id)[0];
    expect(existsSync(f.path)).toBe(true);
  });

  it("a whole-file hash mismatch resets the file; three strikes fail it", async () => {
    const { rx, store, npub } = setup({ autoAccept: true });
    await rx.offer(npub, { id: "hash-0001", files: [{ name: "a", size: 4, sha256: "f".repeat(64) }] });
    const id = store.getByRemote("in", npub, "hash-0001")!.id;
    for (let i = 0; i < 2; i++) expect(await rx.putChunk(npub, "hash-0001", 0, 0, sha256Hex(hola), hola)).toBe("bad-hash");
    expect(await rx.putChunk(npub, "hash-0001", 0, 0, sha256Hex(hola), hola)).toBe("failed");
    expect(store.get(id)?.state).toBe("failed");
  });

  it("reports status with the parts bitmap and honours a peer cancel", async () => {
    const { rx, npub } = setup({ autoAccept: true });
    await rx.offer(npub, { id: "status-01", files: [{ name: "a", size: 4, sha256: sha256Hex(hola) }] });
    expect(rx.status(npub, "status-01")?.state).toBe("accepted");
    expect(rx.status("npub1other", "status-01")).toBeNull();
    expect(rx.cancelFromPeer(npub, "status-01")).toBe(true);
    expect(rx.status(npub, "status-01")?.state).toBe("cancelled");
  });

  it("a full disk mid-transfer fails it, deletes the parts and says how much is missing", async () => {
    let free = Number.MAX_SAFE_INTEGER;
    const enospc = Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    const db = setup({ autoAccept: true, io: { writeAt: async () => { throw enospc; } } });
    // The offer passes the space check; the disk fills up afterwards.
    (db.rx as unknown as { deps: { freeBytes: () => number } }).deps.freeBytes = () => free;
    await db.rx.offer(db.npub, { id: "full-0001", files: [
      { name: "a", size: 4, sha256: sha256Hex(hola) },
      { name: "b", size: 4, sha256: sha256Hex(hola) },
    ] });
    const t = db.store.getByRemote("in", db.npub, "full-0001")!;
    const parts = db.store.files(t.id).map((f) => `${f.path}.part`);
    expect(parts.every((p) => existsSync(p))).toBe(true);
    free = 2;
    expect(await db.rx.putChunk(db.npub, "full-0001", 0, 0, sha256Hex(hola), hola)).toBe("no-space");
    const row = db.store.get(t.id)!;
    expect(row.state).toBe("failed");
    expect(row.error).toMatch(/6 B more free space is needed/);
    expect(db.rx.failureReason(db.npub, "full-0001")).toBe(row.error);
    expect(parts.some((p) => existsSync(p))).toBe(false);
    // Parts still in flight get the plain "failed", not a second explanation.
    expect(await db.rx.putChunk(db.npub, "full-0001", 1, 0, sha256Hex(hola), hola)).toBe("failed");
    expect(db.store.get(t.id)!.error).toBe(row.error);
  });

  it("any other write error fails the transfer as final, with the cause", async () => {
    const eio = Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
    const db = setup({ autoAccept: true, io: { writeAt: async () => { throw eio; } } });
    await db.rx.offer(db.npub, { id: "eio-00001", files: [{ name: "a", size: 4, sha256: sha256Hex(hola) }] });
    const t = db.store.getByRemote("in", db.npub, "eio-00001")!;
    const part = `${db.store.files(t.id)[0].path}.part`;
    expect(await db.rx.putChunk(db.npub, "eio-00001", 0, 0, sha256Hex(hola), hola)).toBe("write-failed");
    expect(db.store.get(t.id)?.state).toBe("failed");
    expect(db.store.get(t.id)?.error).toMatch(/EIO/);
    expect(existsSync(part)).toBe(false);
  });
});
