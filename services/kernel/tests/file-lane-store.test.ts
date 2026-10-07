import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { TransferStore } from "../src/core/social-net/file-lane/store.js";
import { FriendsStore } from "../src/core/peering/friends-store.js";
import { NostrIdentity } from "../src/core/nostr/nostr-identity.js";
import { CHUNK_SIZE } from "../src/core/social-net/file-lane/limits.js";

const NPUB = "npub1test";

describe("TransferStore", () => {
  it("creates a transfer with files, totals and empty bitmaps", () => {
    const s = new TransferStore(new Database(":memory:"));
    const t = s.create({ direction: "in", peerNpub: NPUB, remoteId: "r1", state: "pending",
      files: [{ name: "a", size: CHUNK_SIZE + 1, sha256: "x" }, { name: "b", size: 0 }] });
    expect(t.total_bytes).toBe(CHUNK_SIZE + 1);
    expect(s.files(t.id).map((f) => f.have.length)).toEqual([1, 0]);
    expect(s.getByRemote("in", NPUB, "r1")?.id).toBe(t.id);
  });

  it("marks parts and adds their bytes to the progress", () => {
    const s = new TransferStore(new Database(":memory:"));
    const t = s.create({ direction: "in", peerNpub: NPUB, remoteId: "r", state: "accepted", files: [{ name: "a", size: 10 }] });
    s.markChunk(t.id, 0, 0, 10);
    s.markChunk(t.id, 0, 0, 10); // a repeated part is not counted twice
    expect(s.get(t.id)?.done_bytes).toBe(10);
    s.resetFile(t.id, 0);
    expect(s.get(t.id)?.done_bytes).toBe(0);
  });

  it("finds due outgoing work and stale offers", () => {
    const s = new TransferStore(new Database(":memory:"));
    const out = s.create({ direction: "out", peerNpub: NPUB, state: "pending", files: [] });
    s.schedule(out.id, { nextAt: 1000 });
    expect(s.due(999)).toHaveLength(0);
    expect(s.due(1000).map((t) => t.id)).toEqual([out.id]);
    const old = s.create({ direction: "in", peerNpub: NPUB, remoteId: "o", state: "pending", files: [] });
    expect(s.staleOffers(Date.now() + 25 * 3600_000, 24 * 3600_000).map((t) => t.id)).toContain(old.id);
    expect(s.pendingIncomingCount(NPUB)).toBe(1);
  });
});

describe("FriendsStore.auto_accept", () => {
  it("adds the column to an existing table and toggles it", () => {
    const db = new Database(":memory:");
    const f = new FriendsStore(db);
    const id = NostrIdentity.fromEd25519Seed(new Uint8Array(randomBytes(32)));
    f.add({ npub: id.npub(), trust: "trusted" });
    expect(f.get(id.npub())?.auto_accept).toBe(0);
    f.setAutoAccept(id.npub(), true);
    expect(new FriendsStore(db).get(id.npub())?.auto_accept).toBe(1);
  });
});
