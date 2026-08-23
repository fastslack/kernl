import type { Migration } from "../../../../../../src/core/db/migrations.js";

/**
 * Which agents may reach a repo that is not shared.
 *
 * `repos.shared` has existed since 001 and the tool schema advertises it —
 * "If false, only the Repos Office sees this repo" — but nothing ever wrote a
 * 0, no UI exposed it, and there was no table saying *who* the exception is
 * for. So the flag described an access model the install could not express.
 *
 * A row here means "this agent may reach this repo". It only matters while
 * `shared = 0`; a shared repo is reachable by everyone regardless, which keeps
 * the default behaviour of every existing install exactly as it was.
 */
export const repoAccessMigrations: Migration[] = [
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS repo_access (
        repo_id     TEXT NOT NULL,
        agent_id    TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        PRIMARY KEY (repo_id, agent_id)
      );
      CREATE INDEX IF NOT EXISTS idx_repo_access_agent ON repo_access(agent_id);
    `,
  },
];
