// services/kernel/src/core/social-net/file-lane/owner.ts
/** What the owner does from the dashboard (kernel token). */
import { join, resolve, relative, isAbsolute, basename, sep } from "node:path";
import { statSync, existsSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { HttpError } from "../../http-server.js";
import type { FriendsStore } from "../../peering/friends-store.js";
import type { TransferStore, Transfer } from "./store.js";
import type { TransferReceiver } from "./receiver.js";
import type { TransferWorker } from "./worker.js";
import { chunkCount, chunkRange, isComplete, bitmapToB64, sha256Hex, sha256File } from "./chunks.js";
import { MAX_FILES, MAX_FILE_BYTES, MAX_TEXT_BYTES } from "./limits.js";
import { sanitizeFileName, outgoingDir } from "./paths.js";
import { preparePart, writeAt, finalize } from "./io.js";

export interface TransferView extends Transfer {
  peer_name: string;
  files: Array<{ n: number; name: string; size: number; mime: string; chunks: number; have: string; ready: boolean }>;
}

export interface OwnerDeps {
  store: TransferStore;
  receiver: TransferReceiver;
  worker: TransferWorker;
  friends: FriendsStore;
  dataDir: string;
  /** Folders a "send from Files" path must live in (commander roots + received). */
  allowedRoots: string[];
}

export class TransferOwner {
  private queueing = new Set<string>();

  constructor(private deps: OwnerDeps) {}

  list(): TransferView[] {
    return this.deps.store.list().map((t) => ({
      ...t,
      peer_name: this.deps.friends.get(t.peer_npub)?.petname || t.peer_npub.slice(0, 16),
      files: this.deps.store.files(t.id).map((f) => ({
        n: f.n, name: f.name, size: f.size, mime: f.mime,
        chunks: chunkCount(f.size), have: bitmapToB64(f.have),
        ready: isComplete(f.have, chunkCount(f.size)),
      })),
    }));
  }

  async createOutgoing(body: { npub: string; text?: string; files?: Array<{ name: string; size: number; mime?: string }>; paths?: string[] }) {
    const friend = this.deps.friends.get(body.npub);
    if (!friend || friend.trust !== "trusted") throw new HttpError(400, "you can only send to a trusted friend");
    if (body.text && Buffer.byteLength(body.text) > MAX_TEXT_BYTES) throw new HttpError(413, "the message is too long (64 KB max)");
    const declared = body.files ?? [];
    const fromPaths = (body.paths ?? []).map((p) => this.checkPath(p));
    if (declared.length + fromPaths.length > MAX_FILES) throw new HttpError(413, `at most ${MAX_FILES} files per send`);
    if (!body.text && !declared.length && !fromPaths.length) throw new HttpError(400, "write a message or add files");
    for (const f of declared) {
      if (!Number.isInteger(f.size) || f.size < 0 || f.size > MAX_FILE_BYTES) throw new HttpError(413, `${f.name}: files up to 2 GB`);
    }

    const t = this.deps.store.create({
      direction: "out", peerNpub: body.npub, text: body.text ?? "",
      state: declared.length ? "staging" : "pending",
      files: [
        ...declared.map((f) => ({ name: sanitizeFileName(f.name), size: f.size, mime: f.mime ?? "" })),
        ...fromPaths.map((p) => ({ name: basename(p.path), size: p.size, mime: "", path: p.path })),
      ],
    });
    const dir = outgoingDir(this.deps.dataDir, t.id);
    await mkdir(dir, { recursive: true });
    for (const f of this.deps.store.files(t.id)) {
      if (f.n < declared.length) {
        const path = join(dir, `${f.n}-${f.name}`);
        this.deps.store.setFile(t.id, f.n, { path });
        await preparePart(`${path}.part`, f.size);
        if (f.size === 0) await finalize(`${path}.part`, path);
      } else {
        // Already on disk: count it as uploaded so staging does not wait for it.
        for (let k = 0; k < chunkCount(f.size); k++) { const r = chunkRange(f.size, k); this.deps.store.markChunk(t.id, f.n, k, r.end - r.start); }
      }
    }
    await this.queueIfReady(t.id);
    return {
      id: t.id,
      files: this.deps.store.files(t.id).map((f) => ({ n: f.n, chunks: chunkCount(f.size), have: bitmapToB64(f.have) })),
    };
  }

  async uploadChunk(id: string, n: number, k: number, sha: string | null, data: Uint8Array): Promise<void> {
    const t = this.deps.store.get(id);
    if (!t || t.direction !== "out" || t.state !== "staging") throw new HttpError(409, "this send is not waiting for uploads");
    const f = this.deps.store.file(id, n);
    if (!f || k < 0 || k >= chunkCount(f.size)) throw new HttpError(400, "no such part");
    const { start, end } = chunkRange(f.size, k);
    if (data.length !== end - start) throw new HttpError(400, "part has the wrong size");
    if (sha && sha256Hex(data) !== sha.toLowerCase()) throw new HttpError(409, "part arrived corrupted, send it again");
    await writeAt(`${f.path}.part`, start, data);
    const have = this.deps.store.markChunk(id, n, k, data.length);
    if (isComplete(have, chunkCount(f.size))) await finalize(`${f.path}.part`, f.path);
    await this.queueIfReady(id);
  }

  async accept(id: string, always = false): Promise<void> {
    const t = this.deps.store.get(id);
    if (!t || t.direction !== "in") throw new HttpError(404, "not found");
    if (always) this.deps.friends.setAutoAccept(t.peer_npub, true);
    await this.deps.receiver.accept(id);
  }

  reject(id: string): void {
    this.deps.receiver.reject(id);
  }

  async cancel(id: string): Promise<void> {
    const t = this.deps.store.get(id);
    if (!t) throw new HttpError(404, "not found");
    if (t.direction === "out") return this.deps.worker.cancel(id);
    if (["pending", "accepted", "sending"].includes(t.state)) this.deps.store.setState(id, "cancelled", "cancelled by you");
  }

  retry(id: string): void {
    const t = this.deps.store.get(id);
    if (!t || t.direction !== "out" || t.state !== "failed") throw new HttpError(409, "only a failed send can be retried");
    this.deps.store.setState(id, "pending");
    this.deps.store.schedule(id, { attempts: 0, polls: 0, unreachableSince: null });
    this.deps.worker.kick(id);
  }

  filePath(id: string, n: number): { path: string; name: string; size: number; mime: string } | null {
    const f = this.deps.store.file(id, n);
    return f && f.path && existsSync(f.path) ? { path: f.path, name: f.name, size: f.size, mime: f.mime } : null;
  }

  onFriendRevoked(npub: string): void {
    for (const t of this.deps.store.activeWith(npub)) this.deps.store.setState(t.id, "cancelled", "the friend was revoked");
  }

  private async queueIfReady(id: string): Promise<void> {
    // A second upload finishing while the first is hashing returns at once:
    // the first caller queues the transfer.
    if (this.queueing.has(id)) return;
    const queueable = (state: string, nextAt: string | null) => state === "staging" || (state === "pending" && !nextAt);
    const t0 = this.deps.store.get(id);
    if (!t0 || !queueable(t0.state, t0.next_attempt_at)) return;
    this.queueing.add(id);
    try {
      const files = this.deps.store.files(id);
      if (!files.every((f) => isComplete(f.have, chunkCount(f.size)))) return;
      for (const f of files) if (!f.sha256) this.deps.store.setFile(id, f.n, { sha256: await sha256File(f.path) });
      // Re-read after the awaits: only act if nobody moved the row meanwhile.
      const t = this.deps.store.get(id);
      if (!t || !queueable(t.state, t.next_attempt_at)) return;
      // The bitmap tracked the upload to this Kernl; from here it tracks what
      // the friend confirmed, so the progress bar starts over at 0.
      for (const f of this.deps.store.files(id)) this.deps.store.resetFile(id, f.n);
      if (t.state === "staging") this.deps.store.setState(id, "pending");
      this.deps.worker.kick(id);
    } finally {
      this.queueing.delete(id);
    }
  }

  private checkPath(p: string): { path: string; size: number } {
    let abs: string;
    try { abs = realpathSync(resolve(p)); } catch { throw new HttpError(400, `${p} is not a file`); }
    const rawRoots = this.deps.allowedRoots.length ? this.deps.allowedRoots : [homedir()];
    const roots = rawRoots.map((r) => { try { return realpathSync(resolve(r)); } catch { return resolve(r); } });
    const inside = roots.some((r) => {
      const rel = relative(r, abs);
      return rel === "" || (rel.split(sep)[0] !== ".." && !isAbsolute(rel));
    });
    if (!inside) throw new HttpError(400, `${p} is outside the folders Kernl can share`);
    const st = statSync(abs, { throwIfNoEntry: false });
    if (!st?.isFile()) throw new HttpError(400, `${p} is not a file`);
    if (st.size > MAX_FILE_BYTES) throw new HttpError(413, `${basename(abs)}: files up to 2 GB`);
    return { path: abs, size: st.size };
  }
}
