import type { Migration } from "../../core/db/migrations.js";

/**
 * Schema for the `tool-memory` module (semantic memory of past tool calls).
 *
 * v1 is the DDL that used to run inline in `ToolMemoryService`'s constructor
 * via raw `db.exec(...)` calls — moved verbatim here so it's tracked in
 * `_migrations` like every other module. `IF NOT EXISTS` is kept so
 * existing deployments (which already have this table from the old
 * constructor path) are unaffected; `runMigrations` still records v1 as
 * applied for them.
 */
export const toolMemoryMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS tool_memory (
        id              TEXT PRIMARY KEY,
        tool            TEXT NOT NULL,
        embedding       BLOB NOT NULL,
        input_json      TEXT NOT NULL,
        output_json     TEXT NOT NULL,
        receipt_id      TEXT,
        succeeded       INTEGER NOT NULL DEFAULT 1,
        user_action     TEXT,
        owner_agent_id  TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tool_memory_tool ON tool_memory(tool, owner_agent_id);
      CREATE INDEX IF NOT EXISTS idx_tool_memory_owner ON tool_memory(owner_agent_id, created_at DESC);
    `,
  },
  {
    // Outputs are kept as a 2 KB preview from now on (see clipOutput); cut the
    // ones stored whole before that. Same text clipOutput would produce.
    version: 2,
    sql: `
      UPDATE tool_memory
         SET output_json = substr(output_json, 1, 2048) || '… [truncated: ' || length(output_json) || ' chars]'
       WHERE length(output_json) > 2048;
    `,
  },
];
