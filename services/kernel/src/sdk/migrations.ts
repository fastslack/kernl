import type { SqliteDb } from "../core/db/sqlite.js";
import { log } from "./log.js";

/** Ensures the migrations meta-table exists */
function ensureMetaTable(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      module      TEXT    NOT NULL,
      version     INTEGER NOT NULL,
      applied_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(module, version)
    )
  `);
}

export interface Migration {
  version: number;
  sql: string;
}

/**
 * Run pending migrations for a module.
 * Migrations are applied in version order, idempotently.
 */
export function runMigrations(
  db: SqliteDb,
  moduleName: string,
  migrations: Migration[],
): void {
  ensureMetaTable(db);

  const applied = new Set(
    (
      db
        .prepare("SELECT version FROM _migrations WHERE module = ?")
        .all(moduleName) as Array<{ version: number }>
    ).map((r) => r.version),
  );

  const sorted = [...migrations].sort((a, b) => a.version - b.version);

  // One transaction per migration, bookkeeping included: a multi-statement
  // migration that fails partway used to leave its first statements applied
  // and unrecorded, so the next boot re-ran it against a half-migrated schema.
  // (A PRAGMA that must run outside a transaction, like foreign_keys, does
  // not belong in a migration; see comms' ensureEmailAccountsSchema.)
  const apply = db.transaction((m: Migration) => {
    db.exec(m.sql);
    db.prepare("INSERT INTO _migrations (module, version) VALUES (?, ?)").run(moduleName, m.version);
  });

  for (const m of sorted) {
    if (applied.has(m.version)) continue;
    log.info(`Migration ${moduleName}@${m.version}`);
    apply(m);
  }
}
