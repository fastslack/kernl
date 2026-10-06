// services/kernel/src/core/social-net/file-lane/worker.ts
/**
 * The sending side. Drives every outgoing transfer: offer → wait → upload
 * missing parts → done, retrying an unreachable friend with backoff and
 * resuming from the receiver's bitmap. State lives in the store, so a
 * restart simply picks up where it left off.
 */
import { open, rm } from "node:fs/promises";
import { log } from "../../logger.js";
import type { PeerResponse } from "../../peering/client.js";
import type { TransferStore, Transfer, TransferState } from "./store.js";
import { chunkCount, chunkRange, bitmapFromB64, missingChunks, sha256Hex } from "./chunks.js";
import { retryDelayMs, pollDelayMs, GIVE_UP_AFTER_MS, OFFER_TTL_MS, ORPHAN_TTL_MS } from "./limits.js";
import { outgoingDir } from "./paths.js";
import type { OfferBody } from "./receiver.js";

export interface PeerTransport {
  post<T>(npub: string, path: string, body: unknown): Promise<PeerResponse<T>>;
  get<T>(npub: string, path: string): Promise<PeerResponse<T>>;
  putBinary(npub: string, path: string, data: Uint8Array): Promise<PeerResponse<unknown>>;
}

interface RemoteStatus { state: TransferState; files: Array<{ n: number; have: string }> }

/**
 * Something on this machine, not the network, stopped the send: the original
 * was moved or deleted, its staged copy was cleaned up, the disk errored.
 * Retrying cannot fix it, so the transfer fails with the reason instead of
 * being picked up again every tick.
 */
export class LocalSendError extends Error {}

const REMOTE_FINAL: TransferState[] = ["done", "rejected", "cancelled", "failed", "expired"];
const BASE = "/api/peering/transfer";

export class TransferWorker {
  private running = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private now: () => number;
  private concurrency: number;

  constructor(private deps: { store: TransferStore; peer: PeerTransport; dataDir: string; now?: () => number; concurrency?: number }) {
    this.now = deps.now ?? Date.now;
    this.concurrency = deps.concurrency ?? 3;
  }

  start(intervalMs = 2_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, intervalMs);
    // Retake what a restart interrupted.
    for (const t of this.deps.store.list(500)) {
      if (t.direction === "out" && ["pending", "accepted", "sending"].includes(t.state) && !t.next_attempt_at) this.kick(t.id);
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  kick(id: string): void {
    this.deps.store.schedule(id, { nextAt: this.now() });
  }

  async tick(): Promise<void> {
    for (const t of this.deps.store.due(this.now())) {
      if (this.running.has(t.id)) continue;
      this.running.add(t.id);
      try { await this.step(t); } catch (err) { this.localFailure(t, err); }
      finally { this.running.delete(t.id); }
    }
  }

  /** Owner cancelled an outgoing transfer: stop here, tell the friend if we can. */
  async cancel(id: string): Promise<void> {
    const t = this.deps.store.get(id);
    if (!t || t.direction !== "out" || REMOTE_FINAL.includes(t.state)) return;
    this.deps.store.setState(id, "cancelled");
    await this.deps.peer.post(t.peer_npub, `${BASE}/${t.remote_id}/cancel`, {});
    await rm(outgoingDir(this.deps.dataDir, t.id), { recursive: true, force: true });
  }

  /** Expire unanswered offers and remove leftovers of finished-badly transfers. */
  async housekeeping(): Promise<void> {
    for (const t of this.deps.store.staleOffers(this.now(), OFFER_TTL_MS)) {
      this.deps.store.setState(t.id, "expired", "nobody answered within 24 hours");
      if (t.direction === "out") await rm(outgoingDir(this.deps.dataDir, t.id), { recursive: true, force: true });
    }
    const cutoff = new Date(this.now() - ORPHAN_TTL_MS).toISOString();
    for (const t of this.deps.store.finishedBefore(cutoff)) {
      for (const f of this.deps.store.files(t.id)) if (f.path && t.direction === "in") await rm(`${f.path}.part`, { force: true });
      if (t.direction === "out") await rm(outgoingDir(this.deps.dataDir, t.id), { recursive: true, force: true });
    }
  }

  /**
   * The peer client never throws (an offline friend is a result, not an
   * exception), so whatever reaches here is local. Leaving next_attempt_at in
   * the past would retry it every tick forever.
   */
  private localFailure(stale: Transfer, err: unknown): void {
    log.warn(`file-lane: step failed for ${stale.id}: ${String(err)}`);
    const t = this.deps.store.get(stale.id);
    if (!this.active(t)) return;
    const reason = err instanceof LocalSendError
      ? err.message
      : `could not send: ${err instanceof Error ? err.message : String(err)}`;
    this.deps.store.setState(t.id, "failed", reason);
  }

  private active(t: Transfer | null | undefined): t is Transfer {
    return !!t && ["pending", "accepted", "sending"].includes(t.state);
  }

  private async step(stale: Transfer): Promise<void> {
    // Work from the row as it is now: a cancel or a reset since `due()` must not be undone.
    const t = this.deps.store.get(stale.id);
    if (!this.active(t)) return;
    if (t.state === "pending" && t.polls === 0) {
      const files = this.deps.store.files(t.id);
      const offer: OfferBody = {
        id: t.remote_id,
        text: t.text || undefined,
        files: files.map((f) => ({ name: f.name, size: f.size, mime: f.mime, sha256: f.sha256 })),
      };
      const r = await this.deps.peer.post<{ state: TransferState; error?: string }>(t.peer_npub, `${BASE}/offer`, offer);
      if (!r.ok) return this.unreachableOrRefused(t, r);
      this.reachable(t);
      return this.follow(t, r.data!.state);
    }
    const s = await this.deps.peer.get<RemoteStatus>(t.peer_npub, `${BASE}/${t.remote_id}`);
    if (!s.ok) return this.unreachableOrRefused(t, s);
    // An answering friend whose uploads keep failing is not "reachable" yet:
    // the reset happens on upload progress, not on a status reply alone.
    if (s.data!.state === "accepted" || s.data!.state === "sending") return this.upload(t, s.data!);
    this.reachable(t);
    return this.follow(t, s.data!.state);
  }

  private async follow(t: Transfer, remote: TransferState): Promise<void> {
    if (REMOTE_FINAL.includes(remote)) {
      this.deps.store.setState(t.id, remote, remote === "done" ? "" : `the friend's Kernl says ${remote}`);
      if (remote === "done") this.markAllSent(t);
      if (remote !== "failed") await rm(outgoingDir(this.deps.dataDir, t.id), { recursive: true, force: true });
      return;
    }
    if (remote === "pending") {
      const polls = (this.deps.store.get(t.id)?.polls ?? 0) + 1;
      this.deps.store.schedule(t.id, { polls, nextAt: this.now() + pollDelayMs(polls) });
      return;
    }
    this.deps.store.schedule(t.id, { polls: Math.max(1, t.polls), nextAt: this.now() });
  }

  private async upload(t: Transfer, status: RemoteStatus): Promise<void> {
    if (t.state !== "sending") this.deps.store.setState(t.id, "sending");
    this.deps.store.schedule(t.id, { polls: Math.max(1, t.polls) });
    let anyMissing = false;
    for (const f of this.deps.store.files(t.id)) {
      const remote = status.files.find((x) => x.n === f.n);
      const have = remote ? bitmapFromB64(remote.have) : new Uint8Array();
      const todo = missingChunks(have, chunkCount(f.size));
      if (todo.length) anyMissing = true;
      for (let i = 0; i < todo.length; i += this.concurrency) {
        const batch = todo.slice(i, i + this.concurrency);
        const results = await Promise.all(batch.map((k) => this.sendChunk(t, f.n, f.path, f.size, k)));
        if (!this.active(this.deps.store.get(t.id))) return; // cancelled while uploading
        if (results.some((r) => r.kind === "ok")) this.reachable(this.deps.store.get(t.id)!);
        const gone = results.some((r) => r.kind === "gone");
        const bad = results.find((r) => r.kind === "fail");
        if (bad && bad.kind === "fail") return this.unreachableOrRefused(t, bad.res);
        if (gone) { this.deps.store.schedule(t.id, { nextAt: this.now() }); return; }
      }
    }
    if (!anyMissing) this.reachable(this.deps.store.get(t.id) ?? t);
    // Ask once more: the receiver flips to done when the last file verifies.
    this.deps.store.schedule(t.id, { nextAt: this.now() });
  }

  private async sendChunk(t: Transfer, n: number, path: string, size: number, k: number):
    Promise<{ kind: "ok" } | { kind: "gone" } | { kind: "fail"; res: PeerResponse<unknown> }> {
    const { start, end } = chunkRange(size, k);
    const buf = await readPart(path, start, end - start);
    const url = `${BASE}/${t.remote_id}/files/${n}/chunks/${k}?sha=${sha256Hex(buf)}`;
    let r = await this.deps.peer.putBinary(t.peer_npub, url, buf);
    // A part the receiver rejected as corrupt in transit is worth one more try within the round.
    if (!r.ok && r.status === 409) r = await this.deps.peer.putBinary(t.peer_npub, url, buf);
    if (r.ok) { this.deps.store.markChunk(t.id, n, k, buf.length); return { kind: "ok" }; }
    if (r.status === 410 || r.status === 404) return { kind: "gone" };
    // 409 twice or a 5xx: back off like an unreachable friend. Other 4xx fail the transfer.
    if (r.status === 409) return { kind: "fail", res: { ok: false, status: 0, error: "part rejected twice" } };
    return { kind: "fail", res: r };
  }

  private markAllSent(t: Transfer): void {
    for (const f of this.deps.store.files(t.id)) for (let k = 0; k < chunkCount(f.size); k++) {
      const { start, end } = chunkRange(f.size, k);
      this.deps.store.markChunk(t.id, f.n, k, end - start);
    }
  }

  private reachable(t: Transfer): void {
    if (t.unreachable_since || t.attempts) this.deps.store.schedule(t.id, { attempts: 0, unreachableSince: null });
  }

  private unreachableOrRefused(stale: Transfer, r: PeerResponse<unknown>): void {
    const t = this.deps.store.get(stale.id);
    if (!this.active(t)) return;
    if (r.status === 507) {
      // The receiver says how much is missing when it can; keep that.
      const detail = (r.data as { error?: string } | undefined)?.error;
      this.deps.store.setState(t.id, "failed", detail || "the friend's Kernl is out of space");
      return;
    }
    if (r.status >= 400 && r.status < 500 && r.status !== 404 && r.status !== 408) {
      const msg = (r.data as { error?: string } | undefined)?.error ?? r.error ?? `HTTP ${r.status}`;
      this.deps.store.setState(t.id, "failed", msg);
      return;
    }
    const since = t.unreachable_since ? Date.parse(t.unreachable_since) : this.now();
    if (this.now() - since >= GIVE_UP_AFTER_MS) {
      this.deps.store.setState(t.id, "failed", "the friend did not answer for 6 hours");
      return;
    }
    this.deps.store.schedule(t.id, {
      attempts: t.attempts + 1,
      unreachableSince: new Date(since).toISOString(),
      nextAt: this.now() + retryDelayMs(t.attempts),
    });
  }
}

/** One part of the file being sent; a missing or shrunken file is a LocalSendError. */
async function readPart(path: string, start: number, length: number): Promise<Uint8Array> {
  const buf = new Uint8Array(length);
  let fh;
  try { fh = await open(path, "r"); } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new LocalSendError(code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR"
      ? "the file to send is no longer available"
      : `the file to send can't be read (${code ?? String(err)})`);
  }
  try {
    const { bytesRead } = await fh.read(buf, 0, length, start);
    if (bytesRead < length) throw new LocalSendError("the file to send changed since it was offered");
  } finally { await fh.close(); }
  return buf;
}
