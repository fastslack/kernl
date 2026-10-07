/**
 * The receiving side. Everything here is called with an npub that
 * verifyRequest already proved is a trusted friend.
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { FriendsStore } from "../../peering/friends-store.js";
import type { TransferStore, Transfer, TransferState } from "./store.js";
import { chunkCount, chunkRange, isComplete, bitmapToB64, sha256Hex, sha256File, EMPTY_SHA256 } from "./chunks.js";
import { MAX_FILES, MAX_FILE_BYTES, MAX_TEXT_BYTES, MAX_PENDING_PER_FRIEND, MAX_BAD_HASHES } from "./limits.js";
import { sanitizeFileName, uniquePath, incomingDir } from "./paths.js";
import { preparePart, writeAt, finalize, freeBytes as fsFree } from "./io.js";

export interface OfferBody {
  id: string;
  text?: string;
  files: Array<{ name: string; size: number; mime?: string; sha256: string }>;
}

export type ChunkResult =
  | "ok" | "bad-hash" | "not-accepted" | "not-found" | "out-of-range" | "failed"
  /** The disk filled up mid-transfer: the transfer is now failed, its parts deleted. */
  | "no-space"
  /** Any other write error: same outcome, final for the sender. */
  | "write-failed";

export class OfferError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface ReceiverDeps {
  store: TransferStore;
  friends: FriendsStore;
  dataDir: string;
  /** Called when something new arrives (text, or an offer to answer). */
  notify?: (t: Transfer) => void;
  freeBytes?: (dir: string) => number;
  /** Disk writes, swappable so a full or broken disk can be simulated. */
  io?: { writeAt?: typeof writeAt; finalize?: typeof finalize };
}

const HEX64 = /^[0-9a-f]{64}$/;

export class TransferReceiver {
  constructor(private deps: ReceiverDeps) {}

  async offer(npub: string, body: OfferBody): Promise<{ state: TransferState }> {
    const existing = this.deps.store.getByRemote("in", npub, String(body?.id ?? ""));
    if (existing) return { state: existing.state };
    validateOffer(body);
    const files = body.files ?? [];
    const total = files.reduce((a, f) => a + f.size, 0);
    if (files.length && this.deps.store.pendingIncomingCount(npub) >= MAX_PENDING_PER_FRIEND) {
      throw new OfferError(429, "too many pending offers from this friend");
    }
    const root = join(this.deps.dataDir, "transfers", "incoming");
    if (total > 0 && (this.deps.freeBytes ?? fsFree)(root) < total) {
      throw new OfferError(507, "not enough space on the receiving Kernl");
    }
    const auto = files.length === 0 || this.deps.friends.get(npub)?.auto_accept === 1;
    const t = this.deps.store.create({
      direction: "in", peerNpub: npub, remoteId: body.id, text: body.text ?? "",
      state: files.length === 0 ? "done" : "pending",
      files: files.map((f) => ({ name: sanitizeFileName(f.name), size: f.size, mime: f.mime ?? "", sha256: f.sha256 })),
    });
    if (files.length && auto) await this.accept(t.id);
    const now = this.deps.store.get(t.id)!;
    this.deps.notify?.(now);
    return { state: now.state };
  }

  status(npub: string, remoteId: string): { state: TransferState; files: Array<{ n: number; have: string }> } | null {
    const t = this.deps.store.getByRemote("in", npub, remoteId);
    if (!t) return null;
    return { state: t.state, files: this.deps.store.files(t.id).map((f) => ({ n: f.n, have: bitmapToB64(f.have) })) };
  }

  async putChunk(npub: string, remoteId: string, n: number, k: number, sha: string, data: Uint8Array): Promise<ChunkResult> {
    const t = this.deps.store.getByRemote("in", npub, remoteId);
    if (!t) return "not-found";
    if (t.state !== "accepted" && t.state !== "sending") return t.state === "failed" ? "failed" : "not-accepted";
    const f = this.deps.store.file(t.id, n);
    if (!f || k < 0 || k >= chunkCount(f.size)) return "out-of-range";
    const { start, end } = chunkRange(f.size, k);
    if (data.length !== end - start) return "out-of-range";
    if (sha256Hex(data) !== sha.toLowerCase()) return this.strike(t, n);

    if (t.state === "accepted") this.deps.store.setState(t.id, "sending");
    const io = { writeAt, finalize, ...this.deps.io };
    try {
      await io.writeAt(`${f.path}.part`, start, data);
      const have = this.deps.store.markChunk(t.id, n, k, data.length);
      if (isComplete(have, chunkCount(f.size))) {
        if ((await sha256File(`${f.path}.part`)) !== f.sha256) {
          this.deps.store.resetFile(t.id, n);
          return this.strike(t, n);
        }
        await io.finalize(`${f.path}.part`, f.path);
        if (this.deps.store.files(t.id).every((x) => existsSync(x.path))) this.deps.store.setState(t.id, "done");
      }
    } catch (err) {
      return this.writeFailed(t.id, err);
    }
    return "ok";
  }

  /** Why an incoming transfer failed, for the peer route's answer. */
  failureReason(npub: string, remoteId: string): string {
    return this.deps.store.getByRemote("in", npub, remoteId)?.error ?? "";
  }

  /**
   * A write on our side failed mid-transfer. Spec: stop, delete the parts and
   * say how much is missing — never sit in `sending` with a half-written file.
   */
  private async writeFailed(id: string, err: unknown): Promise<ChunkResult> {
    const t = this.deps.store.get(id);
    // Parallel parts all hit the same full disk: the first one explains it.
    if (!t || t.state === "failed") return "failed";
    const code = (err as NodeJS.ErrnoException)?.code;
    const noSpace = code === "ENOSPC" || code === "EDQUOT";
    // Mark it first so parts arriving in parallel stop writing, then clean up.
    this.deps.store.setState(id, "failed", noSpace ? "not enough space on the receiving Kernl" : "the receiving Kernl could not save the file");
    for (const f of this.deps.store.files(id)) {
      if (f.path) await rm(`${f.path}.part`, { force: true }).catch(() => undefined);
    }
    let reason: string;
    if (noSpace) {
      // With the parts gone, the whole transfer has to fit again.
      const free = (this.deps.freeBytes ?? fsFree)(join(this.deps.dataDir, "transfers", "incoming"));
      const short = t.total_bytes - free;
      reason = short > 0
        ? `not enough space on the receiving Kernl: ${formatBytes(short)} more free space is needed (${formatBytes(t.total_bytes)} to receive, ${formatBytes(free)} free)`
        : `not enough space on the receiving Kernl: the disk filled up with ${formatBytes(Math.max(0, t.total_bytes - t.done_bytes))} still to receive`;
    } else {
      reason = `the receiving Kernl could not save the file (${code ?? (err instanceof Error ? err.message : String(err))})`;
    }
    this.deps.store.setState(id, "failed", reason);
    return noSpace ? "no-space" : "write-failed";
  }

  cancelFromPeer(npub: string, remoteId: string): boolean {
    const t = this.deps.store.getByRemote("in", npub, remoteId);
    if (!t) return false;
    if (!["done", "failed", "expired"].includes(t.state)) this.deps.store.setState(t.id, "cancelled", "cancelled by sender");
    return true;
  }

  /** Owner said yes (or the friend is auto-accepted): reserve names, create .part files. */
  async accept(localId: string): Promise<void> {
    const t = this.deps.store.get(localId);
    if (!t || t.direction !== "in" || t.state !== "pending") return;
    const friend = this.deps.friends.get(t.peer_npub);
    const dir = incomingDir(this.deps.dataDir, friend?.petname || t.peer_npub.slice(0, 16));
    for (const f of this.deps.store.files(t.id)) {
      const path = uniquePath(dir, f.name);
      this.deps.store.setFile(t.id, f.n, { path });
      await preparePart(`${path}.part`, f.size);
      if (f.size === 0) {
        if (f.sha256 !== EMPTY_SHA256) { this.deps.store.setState(t.id, "failed", "empty file with a non-empty hash"); return; }
        await finalize(`${path}.part`, path);
      }
    }
    const done = this.deps.store.files(t.id).every((x) => existsSync(x.path));
    this.deps.store.setState(t.id, done ? "done" : "accepted");
  }

  reject(localId: string): void {
    const t = this.deps.store.get(localId);
    if (t?.direction === "in" && t.state === "pending") this.deps.store.setState(t.id, "rejected");
  }

  private strike(t: Transfer, n: number): ChunkResult {
    if (this.deps.store.bumpBadHash(t.id, n) >= MAX_BAD_HASHES) {
      this.deps.store.setState(t.id, "failed", "a file kept arriving corrupted");
      return "failed";
    }
    return "bad-hash";
  }
}

function validateOffer(body: OfferBody): void {
  if (!body || typeof body.id !== "string" || !/^[\w-]{8,64}$/.test(body.id)) throw new OfferError(400, "bad offer id");
  const files = Array.isArray(body.files) ? body.files : [];
  if (files.length > MAX_FILES) throw new OfferError(413, `at most ${MAX_FILES} files per offer`);
  if (typeof body.text === "string" && Buffer.byteLength(body.text) > MAX_TEXT_BYTES) throw new OfferError(413, "text too long");
  if (!files.length && !body.text) throw new OfferError(400, "an offer needs text or files");
  for (const f of files) {
    if (typeof f.name !== "string" || !f.name) throw new OfferError(400, "file without a name");
    if (!Number.isInteger(f.size) || f.size < 0 || f.size > MAX_FILE_BYTES) throw new OfferError(413, "file too large");
    if (typeof f.sha256 !== "string" || !HEX64.test(f.sha256)) throw new OfferError(400, "file without a valid sha256");
  }
}

function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
