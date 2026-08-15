/**
 * Captioning runs that outlive the request that asked for them.
 *
 * The behaviours worth pinning are the ones the old blocking design could not
 * have: that starting a run returns before the run finishes, that a second
 * asker joins the first instead of spawning a second whisper, and — the one
 * that actually bit a user — that a run killed by a kernel restart is
 * recognisable as such on the next boot instead of leaving a row that claims
 * to be running forever.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { cinemaMigrations } from "../assets/extensions/leisure/cinema/_module/migrations/001_cinema_titles.js";
import {
  TranscribeJobService,
  type TranscribeJobParams,
  type TranscribeRunner,
} from "../assets/extensions/leisure/cinema/_module/transcribe-jobs.js";
import type { SqliteDb } from "../src/core/db/sqlite.js";

let db: SqliteDb;

const PARAMS: TranscribeJobParams = {
  key: "a".repeat(40),
  url: "https://archive.org/download/x/x.mp4",
  engine: "whispercpp",
  model: "base",
  lang: "en",
  jobId: "job-1",
};

beforeEach(() => {
  db = new Database(":memory:") as unknown as SqliteDb;
  runMigrations(db, "cinema", cinemaMigrations);
});

/** A runner the test drives by hand: it finishes when `release` is called. */
function controllable(): {
  runner: TranscribeRunner;
  release: (cueCount: number) => void;
  fail: (msg: string) => void;
  emit: (p: { subPhase: string; frac: number }) => void;
  calls: number;
} {
  let resolve!: (v: { cueCount: number }) => void;
  let reject!: (e: Error) => void;
  let emitter: ((p: { subPhase: string; frac: number }) => void) | null = null;
  const state = {
    calls: 0,
    runner: ((_params, onProgress) => {
      state.calls += 1;
      emitter = onProgress;
      return new Promise<{ cueCount: number }>((res, rej) => {
        resolve = res;
        reject = rej;
      });
    }) as TranscribeRunner,
    release: (cueCount: number) => resolve({ cueCount }),
    fail: (msg: string) => reject(new Error(msg)),
    emit: (p: { subPhase: string; frac: number }) => emitter?.(p),
  };
  return state;
}

describe("transcribe jobs", () => {
  it("returns while the run is still going", () => {
    const c = controllable();
    const svc = new TranscribeJobService(db, c.runner);

    const started = svc.start(PARAMS, null);

    // The point of the whole exercise: the caller has an answer before the
    // work is anywhere near done.
    expect(started.status).toBe("running");
    expect(svc.isRunning(PARAMS.key)).toBe(true);
    expect(c.calls).toBe(1);
  });

  it("joins a second asker to the run already in flight", () => {
    const c = controllable();
    const svc = new TranscribeJobService(db, c.runner);

    svc.start(PARAMS, null);
    const second = svc.start({ ...PARAMS, jobId: "job-2" }, null);

    expect(second.status).toBe("running");
    // One run, not two — this is what stops a double-click from spawning a
    // second whisper over the same film.
    expect(c.calls).toBe(1);
    // …but progress follows the newer listener, or the second tab's bar
    // would never move.
    expect(svc.status(PARAMS.key)?.jobId).toBe("job-2");
  });

  it("reports ready without running anything when the VTT is already cached", () => {
    const c = controllable();
    const svc = new TranscribeJobService(db, c.runner);

    const s = svc.start(PARAMS, { cueCount: 812 });

    expect(s.status).toBe("ready");
    expect(s.cueCount).toBe(812);
    expect(c.calls).toBe(0);
  });

  it("carries progress into the status a reloaded tab reads", async () => {
    const c = controllable();
    const svc = new TranscribeJobService(db, c.runner);
    svc.start(PARAMS, null);

    c.emit({ subPhase: "extract", frac: 0.42 });

    const s = svc.status(PARAMS.key);
    expect(s?.phase).toBe("extract");
    expect(s?.frac).toBeCloseTo(0.42);
  });

  it("settles to ready with the cue count", async () => {
    const c = controllable();
    const svc = new TranscribeJobService(db, c.runner);
    svc.start(PARAMS, null);

    c.release(540);
    await svc.join(PARAMS.key);

    const s = svc.status(PARAMS.key);
    expect(s?.status).toBe("ready");
    expect(s?.cueCount).toBe(540);
    // Read back from the row, not from memory — the live entry is gone.
    expect(svc.isRunning(PARAMS.key)).toBe(false);
  });

  it("keeps the failure message instead of losing it with the socket", async () => {
    const c = controllable();
    const svc = new TranscribeJobService(db, c.runner);
    svc.start(PARAMS, null);

    c.fail("whisper-cli exited 1");
    await svc.join(PARAMS.key);

    const s = svc.status(PARAMS.key);
    expect(s?.status).toBe("error");
    expect(s?.error).toContain("whisper-cli exited 1");
  });

  it("marks a run the kernel restarted through as interrupted", () => {
    // Simulate the restart: one service writes a running row, then a brand
    // new service (new process, empty memory) boots against the same db.
    const first = new TranscribeJobService(db, controllable().runner);
    first.start(PARAMS, null);
    expect(first.status(PARAMS.key)?.status).toBe("running");

    const afterReboot = new TranscribeJobService(db, controllable().runner);
    const swept = afterReboot.sweepInterrupted();

    expect(swept).toBe(1);
    const s = afterReboot.status(PARAMS.key);
    // Not "running" forever, and not a bare gateway error either — a state
    // the player can name and offer to retry.
    expect(s?.status).toBe("interrupted");
    expect(s?.error).toContain("restarted");
  });

  it("lets a retry re-run a job that was interrupted", () => {
    const first = new TranscribeJobService(db, controllable().runner);
    first.start(PARAMS, null);

    const c = controllable();
    const afterReboot = new TranscribeJobService(db, c.runner);
    afterReboot.sweepInterrupted();

    const retried = afterReboot.start(PARAMS, null);

    expect(retried.status).toBe("running");
    expect(c.calls).toBe(1);
  });

  it("lists jobs for a url so the player can offer what exists", async () => {
    const c = controllable();
    const svc = new TranscribeJobService(db, c.runner);
    svc.start(PARAMS, null);
    c.release(120);
    await svc.join(PARAMS.key);

    const c2 = controllable();
    const svc2 = new TranscribeJobService(db, c2.runner);
    svc2.start({ ...PARAMS, key: "b".repeat(40), model: "large-v3-turbo" }, null);

    const listed = svc2.listForUrl(PARAMS.url);
    expect(listed.length).toBe(2);
    expect(listed.map((j) => j.model).sort()).toEqual(["base", "large-v3-turbo"]);
  });
});
