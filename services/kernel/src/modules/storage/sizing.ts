/**
 * How much each table weighs.
 *
 * SQLite answers this exactly through the `dbstat` virtual table, but the
 * bun:sqlite build the kernel ships is compiled without it. So: use dbstat when
 * the build has it, otherwise estimate — row count × average row size from a
 * sample of the newest and oldest rows, plus the same for every index. The
 * estimate counts text in characters, not bytes, and ignores page slack; it is
 * meant to rank tables and size a cleanup, not to balance to the byte.
 */

import { statSync, readdirSync, statfsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import type { SqliteDb } from "../../core/db/sqlite.js";

export interface TableSize {
  name: string;
  rows: number;
  /** Table plus its indexes. */
  bytes: number;
}

const SAMPLE = 400;
const SLICES = 20;

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function hasDbstat(db: SqliteDb): boolean {
  try {
    db.prepare("SELECT 1 FROM dbstat LIMIT 1").get();
    return true;
  } catch {
    return false;
  }
}

/** Ordinary tables, FTS shadow tables included; virtual tables themselves hold no pages. */
export function listTables(db: SqliteDb): string[] {
  const rows = db
    .prepare(
      `SELECT name, sql FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    )
    .all() as Array<{ name: string; sql: string | null }>;
  return rows
    .filter((r) => !/^\s*CREATE\s+VIRTUAL/i.test(r.sql ?? ""))
    .map((r) => r.name);
}

function countRows(db: SqliteDb, table: string): number {
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`).get() as { n: number }).n;
  } catch {
    return 0;
  }
}

function rowidRange(db: SqliteDb, table: string): { min: number; max: number } | null {
  try {
    const r = db.prepare(`SELECT MIN(rowid) AS lo, MAX(rowid) AS hi FROM ${quoteIdent(table)}`).get() as { lo: number | null; hi: number | null };
    return r.lo === null || r.hi === null ? null : { min: r.lo, max: r.hi };
  } catch {
    return null; // WITHOUT ROWID table
  }
}

/**
 * Average summed column length over rows spread across the whole table:
 * SLICES short runs starting at evenly spaced rowids. Sampling only the ends
 * misleads — a catalog's newest rows carry long descriptions its oldest don't.
 */
function avgLength(db: SqliteDb, table: string, columns: string[], range: { min: number; max: number } | null): number {
  if (columns.length === 0) return 0;
  const expr = columns.map((c) => `ifnull(length(${quoteIdent(c)}),0)`).join("+");
  const t = quoteIdent(table);
  try {
    if (!range) {
      const r = db.prepare(`SELECT AVG(n) AS a FROM (SELECT ${expr} AS n FROM ${t} LIMIT ${SAMPLE})`).get() as { a: number | null };
      return r.a ?? 0;
    }
    const stmt = db.prepare(`SELECT ${expr} AS n FROM ${t} WHERE rowid >= ? ORDER BY rowid LIMIT ${SAMPLE / SLICES}`);
    let sum = 0;
    let count = 0;
    const span = range.max - range.min;
    for (let i = 0; i < SLICES; i++) {
      const start = range.min + Math.floor((span * i) / SLICES);
      for (const row of stmt.all(start) as Array<{ n: number }>) {
        sum += row.n;
        count++;
      }
    }
    return count ? sum / count : 0;
  } catch {
    return 0;
  }
}

function columnsOf(db: SqliteDb, table: string): string[] {
  try {
    return (db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as Array<{ name: string }>).map((c) => c.name);
  } catch {
    return [];
  }
}

function indexColumns(db: SqliteDb, table: string): string[][] {
  try {
    const idx = db.prepare(`PRAGMA index_list(${quoteIdent(table)})`).all() as Array<{ name: string }>;
    return idx.map((i) =>
      (db.prepare(`PRAGMA index_info(${quoteIdent(i.name)})`).all() as Array<{ name: string | null }>)
        .map((c) => c.name)
        .filter((n): n is string => !!n),
    );
  } catch {
    return [];
  }
}

// Per-row cost the column lengths miss: record header, rowid, cell pointer.
// Page slack is not guessed here; the service scales every estimate so they
// add up to the real file size (see `calibrate`).
const ROW_OVERHEAD = 12;

export function estimateTable(db: SqliteDb, table: string): TableSize {
  const rows = countRows(db, table);
  if (rows === 0) return { name: table, rows: 0, bytes: 0 };
  const range = rowidRange(db, table);
  let bytes = rows * (avgLength(db, table, columnsOf(db, table), range) + ROW_OVERHEAD);
  for (const cols of indexColumns(db, table)) {
    bytes += rows * (avgLength(db, table, cols, range) + ROW_OVERHEAD);
  }
  return { name: table, rows, bytes: Math.round(bytes) };
}

/**
 * Scale estimated sizes so they sum to `usedBytes` (file size minus free
 * pages). The estimate ranks tables well but misses page slack, overflow
 * pages and b-tree interior pages; the file size is the one exact number we
 * have, so the shares come from the estimate and the total from the file.
 */
export function calibrate(tables: TableSize[], usedBytes: number): TableSize[] {
  const sum = tables.reduce((s, t) => s + t.bytes, 0);
  if (sum <= 0 || usedBytes <= 0) return tables;
  const k = usedBytes / sum;
  return tables.map((t) => ({ ...t, bytes: Math.round(t.bytes * k) }));
}

/** Exact sizes from dbstat, indexes folded into their table. */
function exactSizes(db: SqliteDb): Map<string, number> {
  const owner = new Map<string, string>();
  for (const r of db.prepare("SELECT name, tbl_name FROM sqlite_master").all() as Array<{ name: string; tbl_name: string }>) {
    owner.set(r.name, r.tbl_name);
  }
  const out = new Map<string, number>();
  for (const r of db.prepare("SELECT name, SUM(pgsize) AS b FROM dbstat GROUP BY name").all() as Array<{ name: string; b: number }>) {
    const t = owner.get(r.name) ?? r.name;
    out.set(t, (out.get(t) ?? 0) + r.b);
  }
  return out;
}

/**
 * Measure every table. Async on purpose: bun:sqlite is synchronous, and a
 * catalog of a few GB takes seconds to sample, so it yields to the event loop
 * between tables instead of freezing the kernel for the whole pass.
 */
export async function measureTables(db: SqliteDb): Promise<{ exact: boolean; tables: TableSize[] }> {
  const names = listTables(db);
  if (hasDbstat(db)) {
    const sizes = exactSizes(db);
    return {
      exact: true,
      tables: names.map((n) => ({ name: n, rows: countRows(db, n), bytes: sizes.get(n) ?? 0 })),
    };
  }
  const tables: TableSize[] = [];
  for (const n of names) {
    tables.push(estimateTable(db, n));
    await new Promise((r) => setTimeout(r, 0));
  }
  return { exact: false, tables };
}

/**
 * Tables a policy accounts for. A policy may name an FTS5 virtual table; its
 * pages live in the `<name>_data`, `_content`, `_docsize`, `_idx` and
 * `_config` shadow tables, so those count as the policy's too.
 */
export function expandPolicyTables(policyTables: string[], allTables: string[]): string[] {
  const out = new Set<string>();
  for (const t of policyTables) {
    if (allTables.includes(t)) out.add(t);
    for (const suffix of ["_data", "_content", "_docsize", "_idx", "_config"]) {
      if (allTables.includes(t + suffix)) out.add(t + suffix);
    }
  }
  return [...out];
}

export function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Free bytes on the filesystem holding `dir`, or -1 when it can't be read. */
export function diskFree(dir: string): number {
  try {
    const s = statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    // Fall back to df where statfs isn't implemented.
    try {
      const r = spawnSync("df", ["-Pk", dir], { encoding: "utf8" });
      const line = r.stdout.trim().split("\n").pop() ?? "";
      const avail = Number(line.split(/\s+/)[3]);
      return Number.isFinite(avail) ? avail * 1024 : -1;
    } catch {
      return -1;
    }
  }
}

export interface StrayFile {
  name: string;
  bytes: number;
  modified: string;
}

const DB_FILE = /\.(db|sqlite|sqlite3)(\.bak)?(-wal|-shm|-journal)?$/i;

/**
 * Database files sitting next to the live one that the kernel does not use:
 * hand-made backups before a migration, copies, leftovers. Never the live DB
 * or its WAL/SHM.
 */
export function listStrayFiles(dbPath: string): StrayFile[] {
  const dir = dirname(dbPath);
  const live = basename(dbPath);
  const keep = new Set([live, `${live}-wal`, `${live}-shm`, `${live}-journal`]);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: StrayFile[] = [];
  for (const name of names) {
    if (keep.has(name) || !DB_FILE.test(name)) continue;
    try {
      const st = statSync(join(dir, name));
      if (!st.isFile()) continue;
      out.push({ name, bytes: st.size, modified: st.mtime.toISOString() });
    } catch {
      /* vanished between readdir and stat */
    }
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}
