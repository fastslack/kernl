/**
 * ConvertJobService — make an undecodable source playable, once.
 *
 * This is the fallback for items where nothing on offer is browser-decodable:
 * no h264 derivative, only an MPEG2 or a Cinepak AVI. The player's earlier
 * answer was a live transcode, and the measurements killed it — archive.org
 * serves those originals around 200 KB/s against a source that needs 286 KB/s
 * just to play, ffmpeg opens a fresh TLS connection per seek, and the encode
 * came out at 0.0665x realtime. There is no arrangement of that pipeline where
 * a 40-minute film plays.
 *
 * Two phases, deliberately:
 *
 *   1. DOWNLOAD, sequentially, to a temp file. Straight-through is the one
 *      access pattern the CDN is quick at — measured 1.28 MB/s against the
 *      200 KB/s the seeking transcode managed.
 *   2. CONVERT from that local file. Off the network, ffmpeg is CPU-bound
 *      again, which on this material means faster than realtime.
 *
 * What the viewer gets in exchange for waiting is a file rather than a stream:
 * seekable (the live transcode never was), and free on every later viewing.
 */

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir, rm, rename } from "node:fs/promises";
import path from "node:path";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { isoNow } from "../../../../../src/core/helpers.js";
import { log } from "../../../../../src/core/logger.js";
import { mediaToolBin, mediaToolError } from "../../../../../src/core/media-tools.js";

export type ConvertJobState = "running" | "ready" | "error" | "interrupted";

export interface ConvertJobStatus {
  key: string;
  url: string;
  status: ConvertJobState;
  /** "download" | "convert" | "" */
  phase: string;
  frac: number;
  doneUnits: number;
  totalUnits: number;
  outBytes: number;
  error: string;
  updatedAt: string;
}

interface JobRow {
  key: string;
  url: string;
  status: ConvertJobState;
  phase: string;
  frac: number;
  done_units: number;
  total_units: number;
  out_bytes: number;
  error: string;
  updated_at: string;
}

/** Same reasoning as the transcribe jobs: ticks are frequent, rows are not. */
const ROW_WRITE_INTERVAL_MS = 1_000;

interface LiveJob {
  status: ConvertJobStatus;
  promise: Promise<void>;
  abort: AbortController;
  lastRowWrite: number;
}

export class ConvertJobService {
  private readonly live = new Map<string, LiveJob>();

  constructor(
    private readonly db: SqliteDb,
    /** Where finished MP4s live. One file per key, plus a .part while working. */
    private readonly outDir: string,
  ) {}

  /** Path of the playable result for a key, finished or not. */
  outPath(key: string): string {
    return path.join(this.outDir, `${key}.mp4`);
  }

  isReady(key: string): boolean {
    return existsSync(this.outPath(key));
  }

  /** Mark rows owned by a process that no longer exists. Called at boot. */
  sweepInterrupted(): number {
    const rows = this.db
      .prepare(`SELECT key FROM cinema_convert_jobs WHERE status = 'running'`)
      .all() as Array<{ key: string }>;
    if (rows.length === 0) return 0;
    this.db
      .prepare(
        `UPDATE cinema_convert_jobs
            SET status = 'interrupted',
                error = 'the kernel restarted while this was converting',
                updated_at = ?
          WHERE status = 'running'`,
      )
      .run(isoNow());
    return rows.length;
  }

  status(key: string): ConvertJobStatus | null {
    const live = this.live.get(key);
    if (live) return { ...live.status };
    const row = this.db
      .prepare(`SELECT * FROM cinema_convert_jobs WHERE key = ?`)
      .get(key) as JobRow | undefined;
    if (row) return this.fromRow(row);
    // No row but a finished file: a conversion from an older process, or one
    // whose row was pruned. The file is the stronger evidence.
    if (this.isReady(key)) {
      return {
        key, url: "", status: "ready", phase: "", frac: 1,
        doneUnits: 0, totalUnits: 0,
        outBytes: statSync(this.outPath(key)).size,
        error: "", updatedAt: isoNow(),
      };
    }
    return null;
  }

  /** Start (or join) a conversion. Returns immediately. */
  start(key: string, url: string, fetchUrl: string): ConvertJobStatus {
    const existing = this.live.get(key);
    if (existing) return { ...existing.status };

    if (this.isReady(key)) {
      const done: ConvertJobStatus = {
        key, url, status: "ready", phase: "", frac: 1,
        doneUnits: 0, totalUnits: 0,
        outBytes: statSync(this.outPath(key)).size,
        error: "", updatedAt: isoNow(),
      };
      this.writeRow(done);
      return done;
    }

    const status: ConvertJobStatus = {
      key, url, status: "running", phase: "download", frac: 0,
      doneUnits: 0, totalUnits: 0, outBytes: 0, error: "", updatedAt: isoNow(),
    };
    this.writeRow(status);

    const job: LiveJob = {
      status,
      abort: new AbortController(),
      lastRowWrite: Date.now(),
      promise: Promise.resolve(),
    };
    this.live.set(key, job);

    const tick = (patch: Partial<ConvertJobStatus>, force = false) => {
      Object.assign(status, patch, { updatedAt: isoNow() });
      const now = Date.now();
      if (force || now - job.lastRowWrite >= ROW_WRITE_INTERVAL_MS) {
        job.lastRowWrite = now;
        this.writeRow(status);
      }
    };

    job.promise = (async () => {
      const srcPath = path.join(this.outDir, `${key}.src`);
      const partPath = `${this.outPath(key)}.part`;
      try {
        await mkdir(this.outDir, { recursive: true });
        await this.download(fetchUrl, srcPath, job.abort.signal, (done, total) => {
          tick({
            phase: "download",
            doneUnits: done,
            totalUnits: total,
            frac: total > 0 ? Math.min(0.99, done / total) : 0,
          });
        });
        tick({ phase: "convert", frac: 0, doneUnits: 0, totalUnits: 0 }, true);
        await this.convert(srcPath, partPath, job.abort.signal, (sec, total) => {
          tick({
            phase: "convert",
            doneUnits: sec,
            totalUnits: total,
            frac: total > 0 ? Math.min(0.99, sec / total) : 0,
          });
        });
        // Rename last: a half-written file must never look like a cache hit.
        await rename(partPath, this.outPath(key));
        status.status = "ready";
        status.frac = 1;
        status.outBytes = statSync(this.outPath(key)).size;
        status.error = "";
        log.info(`cinema/convert: ${key.slice(0, 8)} ready (${(status.outBytes / 1048576).toFixed(1)} MB)`);
      } catch (err) {
        status.status = "error";
        status.error = err instanceof Error ? err.message : String(err);
        log.error(`cinema/convert: ${key.slice(0, 8)} failed`, err);
        // convert() only rejects from ffmpeg's exit handler, so the process is
        // gone by now — but Windows can still answer EBUSY/EPERM while an
        // antivirus scans the file it just closed. Retry instead of leaving a
        // stale .part behind.
        await rm(partPath, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
      } finally {
        await rm(srcPath, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
        status.updatedAt = isoNow();
        this.writeRow(status);
        this.live.delete(key);
      }
    })();

    return { ...status };
  }

  /** Stop a running conversion and forget it. */
  cancel(key: string): boolean {
    const live = this.live.get(key);
    if (!live) return false;
    try { live.abort.abort(); } catch { /* already gone */ }
    return true;
  }

  async join(key: string): Promise<void> {
    await this.live.get(key)?.promise;
  }

  isRunning(key: string): boolean {
    return this.live.has(key);
  }

  /** Phase 1 — straight-through fetch, no seeking, with byte progress. */
  private async download(
    url: string,
    dest: string,
    signal: AbortSignal,
    onProgress: (done: number, total: number) => void,
  ): Promise<void> {
    const r = await fetch(url, { signal, redirect: "follow" });
    if (!r.ok) throw new Error(`source fetch ${r.status} ${r.statusText}`);
    if (!r.body) throw new Error("source returned no body");
    const total = Number(r.headers.get("content-length") ?? 0);
    const out = createWriteStream(dest);
    const reader = r.body.getReader();
    let done = 0;
    try {
      while (true) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        if (signal.aborted) throw new Error("cancelled");
        if (value) {
          done += value.byteLength;
          if (!out.write(Buffer.from(value))) {
            await new Promise<void>((resolve) => out.once("drain", () => resolve()));
          }
          onProgress(done, total);
        }
      }
    } finally {
      await new Promise<void>((resolve) => out.end(() => resolve()));
      try { await reader.cancel(); } catch { /* already closed */ }
    }
    if (total > 0 && done < total) {
      throw new Error(`source truncated at ${done} of ${total} bytes`);
    }
  }

  /** Phase 2 — local to local, so ffmpeg is CPU-bound rather than network-bound. */
  private async convert(
    src: string,
    dest: string,
    signal: AbortSignal,
    onProgress: (sec: number, totalSec: number) => void,
  ): Promise<void> {
    const totalSec = await this.probeDuration(src);
    await new Promise<void>((resolve, reject) => {
      const ff = spawn(mediaToolBin("ffmpeg"), [
        "-hide_banner", "-loglevel", "error",
        "-i", src,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k",
        // The output is a file this time, so the moov can go up front —
        // that is what makes the result seekable in the browser instead of
        // the forward-only stream the live transcode produced.
        "-movflags", "+faststart",
        // Named explicitly because `dest` ends in `.part` while the work is
        // in flight — ffmpeg infers the muxer from the extension and gives up
        // on an unknown one ("Unable to find a suitable output format").
        "-f", "mp4",
        "-y", dest,
        "-progress", "pipe:1", "-nostats",
      ], { stdio: ["ignore", "pipe", "pipe"] });

      const kill = () => { try { ff.kill("SIGKILL"); } catch { /* */ } };
      signal.addEventListener("abort", kill, { once: true });

      let buf = "";
      ff.stdout?.on("data", (b: Buffer) => {
        buf += b.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const m = /out_time_us=(\d+)/.exec(line);
          if (m) onProgress(Number(m[1]) / 1_000_000, totalSec);
        }
      });
      let stderr = "";
      ff.stderr?.on("data", (b: Buffer) => { stderr += b.toString(); });
      ff.on("error", (e) => reject(mediaToolError("ffmpeg", e)));
      ff.on("exit", (code) => {
        signal.removeEventListener("abort", kill);
        if (signal.aborted) return reject(new Error("cancelled"));
        if (code === 0) return resolve();
        reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(0, 200)}`));
      });
    });
  }

  private async probeDuration(file: string): Promise<number> {
    return await new Promise<number>((resolve) => {
      const p = spawn(mediaToolBin("ffprobe"), [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        file,
      ], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      p.stdout?.on("data", (b: Buffer) => { out += b.toString(); });
      p.on("error", () => resolve(0));
      p.on("exit", () => {
        const n = parseFloat(out.trim());
        resolve(Number.isFinite(n) && n > 0 ? n : 0);
      });
    });
  }

  private fromRow(r: JobRow): ConvertJobStatus {
    return {
      key: r.key, url: r.url, status: r.status, phase: r.phase, frac: r.frac,
      doneUnits: r.done_units, totalUnits: r.total_units, outBytes: r.out_bytes,
      error: r.error, updatedAt: r.updated_at,
    };
  }

  private writeRow(s: ConvertJobStatus): void {
    const now = isoNow();
    this.db.prepare(
      `INSERT INTO cinema_convert_jobs
         (key, url, status, phase, frac, done_units, total_units, out_bytes,
          error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
          status      = excluded.status,
          phase       = excluded.phase,
          frac        = excluded.frac,
          done_units  = excluded.done_units,
          total_units = excluded.total_units,
          out_bytes   = excluded.out_bytes,
          error       = excluded.error,
          updated_at  = excluded.updated_at`,
    ).run(
      s.key, s.url, s.status, s.phase, s.frac, s.doneUnits, s.totalUnits,
      s.outBytes, s.error, now, s.updatedAt,
    );
  }
}
