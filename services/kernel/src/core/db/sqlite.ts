// bun:sqlite adapter.
// Exports SqliteDb as bun's Database type directly.
// Tests and services both import from "bun:sqlite" — types match exactly.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "../logger.js";

export type SqliteDb = Database;

export function openSqlite(dbPath: string): SqliteDb {
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);

  // WAL mode for concurrent reads + single writer
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  // Performance pragmas
  db.run("PRAGMA synchronous = NORMAL");       // safe with WAL, faster than FULL
  db.run("PRAGMA cache_size = -65536");        // 64 MB page cache
  db.run("PRAGMA mmap_size = 268435456");      // 256 MB memory-mapped I/O
  db.run("PRAGMA temp_store = MEMORY");        // temp tables/indexes in RAM

  log.info(`SQLite opened: ${dbPath}`);
  return db;
}

export function closeSqlite(db: SqliteDb): void {
  db.close();
  log.info("SQLite closed");
}
