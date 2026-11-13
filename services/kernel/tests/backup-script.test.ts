/**
 * scripts/backup.sh — end-to-end, against a real SQLite database.
 *
 * Two failures this pins down, both of which shipped:
 *
 *   1. **WAL loss.** The kernel keeps the DB open in WAL mode, so recent
 *      writes live in `kernel.db-wal`, not in `kernel.db`. A plain `cp` of the
 *      main file captures a database that is missing everything written since
 *      the last checkpoint. The backup has to go through SQLite itself
 *      (`VACUUM INTO`), not the filesystem.
 *
 *   2. **Silent empty success.** When it couldn't find a database the script
 *      printed "skipping" and exited 0, producing an archive with no data and
 *      calling it a backup. A backup that isn't there must fail loudly — it is
 *      only ever discovered at restore time, which is the worst moment.
 *
 * The test holds a connection open across the backup, exactly as the running
 * kernel does, so the WAL is genuinely un-checkpointed while the script runs.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";

const SCRIPT = resolve(import.meta.dir, "../scripts/backup.sh");

/** The graph client the kernel ships (`@relate/relate`). */
const Relate = (createRequire(import.meta.url)("@relate/relate") as {
  Database: {
    open(path: string, options?: { readOnly?: boolean }): {
      connect(): { query(cypher: string): { rows: Record<string, unknown>[] } };
      checkpoint(): void;
    };
  };
}).Database;

const scratch: string[] = [];

afterEach(() => {
  // Test-only cleanup of directories this test created under the OS temp dir.
  while (scratch.length > 0) {
    const dir = scratch.pop()!;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function newScratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "kernl-backup-test-"));
  scratch.push(dir);
  return dir;
}

/**
 * A data dir holding a WAL-mode database with rows that are still in the WAL.
 * Returns the open connection — the caller must keep it open to keep the WAL
 * un-checkpointed, then close it.
 */
function seedWalDatabase(dataDir: string, rows: number): Database {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, "kernel.db"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO notes (body) VALUES (?)");
  for (let i = 0; i < rows; i++) insert.run(`note ${i}`);
  return db;
}

function runBackup(dataDir: string, outZip: string) {
  return Bun.spawnSync({
    cmd: ["bash", SCRIPT, outZip],
    env: {
      ...process.env,
      KERNEL_BACKUP_MODE: "native",
      KERNEL_BACKUP_DATA_DIR: dataDir,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function unzipTo(zipPath: string, dest: string): void {
  const r = Bun.spawnSync({ cmd: ["unzip", "-q", zipPath, "-d", dest] });
  if (r.exitCode !== 0) throw new Error(`unzip failed: ${r.exitCode}`);
}

/** Locate kernel.db anywhere under `root` — the archive's layout is its own business. */
function findDatabase(root: string): string | null {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === "kernel.db") return full;
    }
  }
  return null;
}

describe("backup.sh", () => {
  it("captures rows that are still in the WAL", () => {
    const work = newScratch();
    const dataDir = join(work, "data");
    const db = seedWalDatabase(dataDir, 500);

    // The WAL must genuinely hold the data: the main file alone must not have
    // it. If this ever stops being true the test below proves nothing.
    expect(existsSync(join(dataDir, "kernel.db-wal"))).toBe(true);

    const out = join(work, "backup.zip");
    try {
      const proc = runBackup(dataDir, out);
      expect(proc.exitCode).toBe(0);
      expect(existsSync(out)).toBe(true);

      const extracted = join(work, "extracted");
      mkdirSync(extracted);
      unzipTo(out, extracted);

      const restoredPath = findDatabase(extracted);
      expect(restoredPath).not.toBeNull();

      const restored = new Database(restoredPath!, { readonly: true });
      const count = restored.query("SELECT count(*) AS c FROM notes").get() as { c: number };
      expect(count.c).toBe(500);
      restored.close();
    } finally {
      db.close();
    }
  }, 60_000);

  it("captures the graph store, including writes still in its WAL, while a writer holds it open", () => {
    const work = newScratch();
    const dataDir = join(work, "data");
    const db = seedWalDatabase(dataDir, 5);

    // The running kernel's side: the store's single writer, never closed (the
    // client cannot close one), with part of the graph only in the WAL.
    const store = Relate.open(join(dataDir, "graph"));
    const conn = store.connect();
    conn.query("UNWIND range(1, 120) AS i CREATE (:Memory {i: i})-[:ABOUT]->(:Concept {i: i})");
    store.checkpoint();
    conn.query("UNWIND range(1, 30) AS i CREATE (:Episode {i: i})");

    const out = join(work, "backup.zip");
    try {
      const proc = runBackup(dataDir, out);
      const output = proc.stdout.toString() + proc.stderr.toString();
      expect(proc.exitCode, output).toBe(0);
      expect(output).toContain("270 nodes, 120 relationships");

      const extracted = join(work, "extracted");
      mkdirSync(extracted);
      unzipTo(out, extracted);
      const copy = join(extracted, "kernl-backup", "data", "graph");
      expect(existsSync(join(copy, "manifest.json"))).toBe(true);

      const c = Relate.open(copy, { readOnly: true }).connect();
      expect(Number(c.query("MATCH (n) RETURN count(n) AS n").rows[0].n)).toBe(270);
      expect(Number(c.query("MATCH ()-[r:ABOUT]->() RETURN count(r) AS n").rows[0].n)).toBe(120);
      expect(Number(c.query("MATCH (e:Episode) RETURN count(e) AS n").rows[0].n)).toBe(30);
    } finally {
      db.close();
    }
  }, 120_000);

  it("fails loudly when the graph store cannot be copied", () => {
    const work = newScratch();
    const dataDir = join(work, "data");
    const db = seedWalDatabase(dataDir, 5);
    // A directory where the store should be, holding no readable store.
    mkdirSync(join(dataDir, "graph"));
    writeFileSync(join(dataDir, "graph", "manifest.json"), "not a manifest");

    const out = join(work, "backup.zip");
    try {
      const proc = runBackup(dataDir, out);
      expect(proc.exitCode).not.toBe(0);
      expect(existsSync(out)).toBe(false);
      const output = proc.stdout.toString() + proc.stderr.toString();
      expect(output).toContain("graph copy failed");
      expect(output).toContain("KERNEL_BACKUP_SKIP_GRAPH=1");
    } finally {
      db.close();
    }
  }, 120_000);

  it("refuses to skip a single-file graph store silently", () => {
    const work = newScratch();
    const dataDir = join(work, "data");
    const db = seedWalDatabase(dataDir, 5);
    writeFileSync(join(dataDir, "graph.rl"), "");

    try {
      const proc = runBackup(dataDir, join(work, "backup.zip"));
      expect(proc.exitCode).not.toBe(0);
      expect(proc.stderr.toString()).toContain("graph.rl");
    } finally {
      db.close();
    }
  }, 60_000);

  it("fails loudly instead of producing an empty backup when there is no database", () => {
    const work = newScratch();
    const emptyDataDir = join(work, "data");
    mkdirSync(emptyDataDir, { recursive: true });

    const out = join(work, "backup.zip");
    const proc = runBackup(emptyDataDir, out);

    expect(proc.exitCode).not.toBe(0);
    const output = proc.stdout.toString() + proc.stderr.toString();
    expect(output.toLowerCase()).toContain("no database");
  }, 60_000);
});
