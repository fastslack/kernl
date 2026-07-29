import type { SqliteDb } from "./sqlite.js";
import { log } from "../logger.js";

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

  for (const m of sorted) {
    if (applied.has(m.version)) continue;

    log.info(`Migration ${moduleName}@${m.version}`);
    db.exec(m.sql);
    db.prepare("INSERT INTO _migrations (module, version) VALUES (?, ?)").run(
      moduleName,
      m.version,
    );
  }
}
