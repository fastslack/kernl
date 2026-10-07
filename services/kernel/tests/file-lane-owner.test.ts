// services/kernel/tests/file-lane-owner.test.ts
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, existsSync, symlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { TransferStore } from "../src/core/social-net/file-lane/store.js";
import { TransferReceiver } from "../src/core/social-net/file-lane/receiver.js";
import { TransferWorker } from "../src/core/social-net/file-lane/worker.js";
import { TransferOwner } from "../src/core/social-net/file-lane/owner.js";
import { FriendsStore } from "../src/core/peering/friends-store.js";
import { NostrIdentity } from "../src/core/nostr/nostr-identity.js";
import { sha256Hex } from "../src/core/social-net/file-lane/chunks.js";

function setup() {
  const db = new Database(":memory:");
  const friends = new FriendsStore(db);
  const mac = NostrIdentity.fromEd25519Seed(new Uint8Array(randomBytes(32)));
  friends.add({ npub: mac.npub(), petname: "Mac M4", trust: "trusted" });
  const store = new TransferStore(db);
  const dataDir = mkdtempSync(join(tmpdir(), "own-"));
  const receiver = new TransferReceiver({ store, friends, dataDir, freeBytes: () => 1e12 });
  const peer = { post: async () => ({ ok: false, status: 0 }), get: async () => ({ ok: false, status: 0 }), putBinary: async () => ({ ok: false, status: 0 }) };
  const worker = new TransferWorker({ store, peer: peer as never, dataDir });
  const owner = new TransferOwner({ store, receiver, worker, friends, dataDir, allowedRoots: [dataDir] });
  return { owner, store, friends, npub: mac.npub(), dataDir };
}

const hola = new TextEncoder().encode("hola");

describe("TransferOwner", () => {
  it("stages a browser upload part by part and queues it once complete", async () => {
    const { owner, store, npub } = setup();
    const { id, files } = await owner.createOutgoing({ npub, text: "va", files: [{ name: "a.txt", size: 4 }] });
    expect(store.get(id)?.state).toBe("staging");
    expect(files[0].chunks).toBe(1);
    await owner.uploadChunk(id, 0, 0, sha256Hex(hola), hola);
    const t = store.get(id)!;
    expect(t.state).toBe("pending");
    expect(t.next_attempt_at).not.toBeNull();
    expect(t.done_bytes).toBe(0); // progress now counts what the friend confirmed
    expect(store.files(id)[0].sha256).toBe(sha256Hex(hola));
  });

  it("a returning browser learns which parts are missing", async () => {
    const { owner, npub } = setup();
    const { id } = await owner.createOutgoing({ npub, files: [{ name: "a", size: 4 }, { name: "b", size: 4 }] });
    await owner.uploadChunk(id, 0, 0, null, hola);
    const view = owner.list().find((v) => v.id === id)!;
    expect(view.state).toBe("staging");
    expect(view.files.map((f) => f.ready)).toEqual([true, false]);
  });

  it("sends files already inside an allowed root without copying, and refuses others", async () => {
    const { owner, store, npub, dataDir } = setup();
    const p = join(dataDir, "informe.pdf");
    writeFileSync(p, hola);
    const { id } = await owner.createOutgoing({ npub, paths: [p] });
    expect(store.get(id)?.state).toBe("pending");
    expect(store.files(id)[0].path).toBe(p);
    await expect(owner.createOutgoing({ npub, paths: ["/etc/passwd"] })).rejects.toThrow(/outside/);
  });

  it("refuses friends that are not trusted", async () => {
    const { owner, friends, npub } = setup();
    friends.update(npub, { trust: "revoked" });
    await expect(owner.createOutgoing({ npub, text: "hola" })).rejects.toThrow(/trusted/);
  });

  it("accept with 'always' remembers the friend; revoking cancels what is in flight", async () => {
    const { owner, store, friends, npub } = setup();
    const rx = (owner as unknown as { deps: { receiver: TransferReceiver } }).deps.receiver;
    await rx.offer(npub, { id: "offer-0001", files: [{ name: "a", size: 4, sha256: sha256Hex(hola) }] });
    const inId = store.list()[0].id;
    await owner.accept(inId, true);
    expect(friends.get(npub)?.auto_accept).toBe(1);
    expect(store.get(inId)?.state).toBe("accepted");
    owner.onFriendRevoked(npub);
    expect(store.get(inId)?.state).toBe("cancelled");
  });

  it("two uploads finishing together queue the transfer exactly once", async () => {
    const { owner, store, npub } = setup();
    const { id } = await owner.createOutgoing({ npub, files: [{ name: "a", size: 4 }, { name: "b", size: 4 }] });
    await Promise.all([owner.uploadChunk(id, 0, 0, null, hola), owner.uploadChunk(id, 1, 0, null, hola)]);
    const t = store.get(id)!;
    expect(t.state).toBe("pending");
    expect(t.done_bytes).toBe(0);
    expect(store.files(id).every((f) => !!f.sha256)).toBe(true);
  });

  it("a row already moved on is not pushed back to pending", async () => {
    const { owner, store, npub } = setup();
    const { id } = await owner.createOutgoing({ npub, files: [{ name: "a", size: 4 }, { name: "b", size: 4 }] });
    await owner.uploadChunk(id, 0, 0, null, hola);
    const last = owner.uploadChunk(id, 1, 0, null, hola);
    store.setState(id, "accepted");
    await last;
    expect(store.get(id)?.state).toBe("accepted");
  });

  it("refuses a symlink inside a root that points outside; accepts a file named ..notes", async () => {
    const { owner, npub, dataDir } = setup();
    const outside = mkdtempSync(join(tmpdir(), "out-"));
    writeFileSync(join(outside, "secret"), hola);
    const link = join(dataDir, "link");
    symlinkSync(join(outside, "secret"), link);
    await expect(owner.createOutgoing({ npub, paths: [link] })).rejects.toThrow(/outside/);
    const odd = join(dataDir, "..notes");
    writeFileSync(odd, hola);
    const { id } = await owner.createOutgoing({ npub, paths: [odd] });
    expect(id).toBeTruthy();
    expect(realpathSync(odd)).toBe(join(realpathSync(dataDir), "..notes"));
  });
});
