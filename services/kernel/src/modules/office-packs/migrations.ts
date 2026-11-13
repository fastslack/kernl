import type { Migration } from "../../core/db/migrations.js";

/**
 * Knowledge packs brought into an office, held for review.
 *
 * Nothing from a pack reaches an agent's prompt until a person accepts it:
 * an import only stages its items here. Accepting one copies it into
 * agent_learnings, like a learning added by hand.
 */
export const officePackMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS office_pack_imports (
        id          TEXT PRIMARY KEY,
        office_id   TEXT NOT NULL,
        pack_name   TEXT NOT NULL DEFAULT '',
        pack_hash   TEXT NOT NULL,
        source      TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_office_pack_imports_office ON office_pack_imports(office_id);

      CREATE TABLE IF NOT EXISTS office_pack_items (
        id           TEXT PRIMARY KEY,
        import_id    TEXT NOT NULL REFERENCES office_pack_imports(id) ON DELETE CASCADE,
        agent_name   TEXT NOT NULL,
        agent_id     TEXT NOT NULL DEFAULT '',
        type         TEXT NOT NULL,
        content      TEXT NOT NULL,
        confidence   REAL NOT NULL,
        status       TEXT NOT NULL DEFAULT 'pending'
                     CHECK(status IN ('pending','accepted','rejected','duplicate','no_agent')),
        learning_id  TEXT NOT NULL DEFAULT '',
        reviewed_at  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_office_pack_items_import ON office_pack_items(import_id, status);
    `,
  },
];
