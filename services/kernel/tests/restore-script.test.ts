/**
 * scripts/restore.sh — the other half of a backup.
 *
 * The previous version copied the database into the repo's own `data/`
 * directory. On the standard Docker deployment the kernel reads from the
 * `kernel-data` volume instead, so a "successful" restore wrote to a path
 * nothing reads: the operator sees green output and still has none of their
 * data. It also skipped `.kernel-encryption-key` — without which every
 * encrypted secret in a restored database is permanently unreadable — and
 * printed "starting fresh" when the archive had no database at all.
 *
 * These tests do the full round trip: back up a real database, clobber the
 * target, restore, and read the rows back.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";

/** The graph client the kernel ships (`@relate/relate`). */
const Relate = (createRequire(import.meta.url)("@relate/relate") as {
  Database: {
    open(path: string, options?: { readOnly?: boolean }): {
      connect(): { query(cypher: string): { rows: Record<string, unknown>[] } };
      checkpoint(): void;
    };
  };
}).Database;

const BACKUP_SCRIPT = resolve(import.meta.dir, "../scripts/backup.sh");
const RESTORE_SCRIPT = resolve(import.meta.dir, "../scripts/restore.sh");

const scratch: string[] = [];
afterEach(() => {
  while (scratch.length > 0) {
    const dir = scratch.pop()!;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function newScratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "kernl-restore-test-"));
  scratch.push(dir);
  return dir;
}

function makeBackup(work: string, rows: number, dataDir = join(work, "source-data")): { zip: string; dataDir: string } {
  mkdirSync(dataDir, { recursive: true });

  const db = new Database(join(dataDir, "kernel.db"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO notes (body) VALUES (?)");
  for (let i = 0; i < rows; i++) insert.run(`note ${i}`);

  writeFileSync(join(dataDir, ".kernel-encryption-key"), "0123456789abcdef".repeat(4));
  writeFileSync(join(dataDir, ".kernel-auth-token"), "a-token");

  const zip = join(work, "backup.zip");
  const proc = Bun.spawnSync({
    cmd: ["bash", BACKUP_SCRIPT, zip],
    env: { ...process.env, KERNEL_BACKUP_MODE: "native", KERNEL_BACKUP_DATA_DIR: dataDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  db.close();
  if (proc.exitCode !== 0) {
    throw new Error(`backup failed: ${proc.stdout.toString()}${proc.stderr.toString()}`);
  }
  return { zip, dataDir };
}

function runRestore(args: string[]) {
  return Bun.spawnSync({ cmd: ["bash", RESTORE_SCRIPT, ...args], stdout: "pipe", stderr: "pipe" });
}

describe("restore.sh", () => {
  it("puts the backed-up rows into the target data dir", () => {
    const work = newScratch();
    const { zip } = makeBackup(work, 300);

    // A target that already holds a DIFFERENT database, as a real restore does.
    const target = join(work, "target-data");
    mkdirSync(target, { recursive: true });
    const stale = new Database(join(target, "kernel.db"));
    stale.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
    stale.run("INSERT INTO notes (body) VALUES ('stale row')");
    stale.close();

    const proc = runRestore([zip, "--native", target, "--yes"]);
    expect(proc.exitCode).toBe(0);

    const restored = new Database(join(target, "kernel.db"), { readonly: true });
    const { c } = restored.query("SELECT count(*) AS c FROM notes").get() as { c: number };
    expect(c).toBe(300);
    restored.close();
  }, 60_000);

  it("restores the encryption key, without which the data is unreadable", () => {
    const work = newScratch();
    const { zip } = makeBackup(work, 10);
    const target = join(work, "target-data");

    const proc = runRestore([zip, "--native", target, "--yes"]);
    expect(proc.exitCode).toBe(0);

    const keyPath = join(target, ".kernel-encryption-key");
    expect(existsSync(keyPath)).toBe(true);
    expect(readFileSync(keyPath, "utf-8")).toBe("0123456789abcdef".repeat(4));
  }, 60_000);

  it("clears a stale WAL that would otherwise shadow the restored database", () => {
    const work = newScratch();
    const { zip } = makeBackup(work, 10);

    const target = join(work, "target-data");
    mkdirSync(target, { recursive: true });
    const stale = new Database(join(target, "kernel.db"));
    stale.exec("PRAGMA journal_mode = WAL");
    stale.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
    stale.run("INSERT INTO notes (body) VALUES ('stale row')");
    // Left open on purpose: the -wal and -shm files stay on disk.
    expect(existsSync(join(target, "kernel.db-wal"))).toBe(true);

    const proc = runRestore([zip, "--native", target, "--yes"]);
    stale.close();
    expect(proc.exitCode).toBe(0);
    expect(existsSync(join(target, "kernel.db-wal"))).toBe(false);
  }, 60_000);

  it("restores the graph store and keeps the one it replaces", () => {
    const work = newScratch();
    const dataDir = join(work, "source-data");
    mkdirSync(dataDir, { recursive: true });
    const graph = Relate.open(join(dataDir, "graph"));
    graph.connect().query("UNWIND range(1, 40) AS i CREATE (:Memory {i: i})-[:KNOWS]->(:Contact {i: i})");
    graph.checkpoint();
    const { zip } = makeBackup(work, 5, dataDir);

    // The target already has a graph of its own, which must not be lost.
    const target = join(work, "target-data");
    mkdirSync(join(target, "graph"), { recursive: true });
    writeFileSync(join(target, "graph", "marker"), "previous store");

    const proc = runRestore([zip, "--native", target, "--yes"]);
    expect(proc.exitCode, proc.stdout.toString() + proc.stderr.toString()).toBe(0);

    // The restored store opens as a writer, as the kernel will open it.
    const restored = Relate.open(join(target, "graph")).connect();
    expect(Number(restored.query("MATCH (n) RETURN count(n) AS n").rows[0].n)).toBe(80);
    expect(Number(restored.query("MATCH ()-[r:KNOWS]->() RETURN count(r) AS n").rows[0].n)).toBe(40);

    const kept = readdirSync(target).filter((f) => f.startsWith("graph.before-restore-"));
    expect(kept.length).toBe(1);
    expect(readFileSync(join(target, kept[0]!, "marker"), "utf-8")).toBe("previous store");
  }, 120_000);

  it("leaves the target's graph alone when the archive has none", () => {
    const work = newScratch();
    const { zip } = makeBackup(work, 5);
    const target = join(work, "target-data");
    mkdirSync(join(target, "graph"), { recursive: true });
    writeFileSync(join(target, "graph", "marker"), "untouched");

    const proc = runRestore([zip, "--native", target, "--yes"]);
    expect(proc.exitCode).toBe(0);
    expect(readFileSync(join(target, "graph", "marker"), "utf-8")).toBe("untouched");
    expect(readdirSync(target).some((f) => f.startsWith("graph.before-restore-"))).toBe(false);
  }, 60_000);

  it("refuses an archive with no database instead of reporting a fresh start", () => {
    const work = newScratch();

    // An archive shaped like ours but with nothing in it.
    const fakeRoot = join(work, "fake");
    mkdirSync(join(fakeRoot, "kernl-backup", "data"), { recursive: true });
    const zip = join(work, "empty.zip");
    const z = Bun.spawnSync({ cmd: ["zip", "-r", zip, "kernl-backup/", "-q"], cwd: fakeRoot });
    expect(z.exitCode).toBe(0);

    const target = join(work, "target-data");
    const proc = runRestore([zip, "--native", target, "--yes"]);

    expect(proc.exitCode).not.toBe(0);
    const output = (proc.stdout.toString() + proc.stderr.toString()).toLowerCase();
    expect(output).toContain("no database");
  }, 60_000);

  it("requires an explicit target mode rather than guessing", () => {
    const work = newScratch();
    const { zip } = makeBackup(work, 5);
    const proc = runRestore([zip]);
    expect(proc.exitCode).not.toBe(0);
  }, 60_000);
});
