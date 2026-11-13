import type { Migration } from "../../core/db/migrations.js";

/**
 * One row per (tool call, thing it touched): who called which writing tool,
 * whether it worked, and an id it read or wrote. A call that named no id
 * still gets one row with ref = ''.
 */
export const provenanceMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS tool_provenance (
        id           TEXT PRIMARY KEY,
        call_id      TEXT NOT NULL,
        at           TEXT NOT NULL,
        actor_kind   TEXT NOT NULL CHECK(actor_kind IN ('agent','client')),
        actor_id     TEXT NOT NULL DEFAULT '',
        actor_name   TEXT NOT NULL DEFAULT '',
        run_id       TEXT NOT NULL DEFAULT '',
        tool         TEXT NOT NULL,
        ok           INTEGER NOT NULL DEFAULT 1,
        ref          TEXT NOT NULL DEFAULT '',
        detail       TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_tool_provenance_ref ON tool_provenance(ref, at);
      CREATE INDEX IF NOT EXISTS idx_tool_provenance_at ON tool_provenance(at);
      CREATE INDEX IF NOT EXISTS idx_tool_provenance_run ON tool_provenance(run_id);
    `,
  },
];
