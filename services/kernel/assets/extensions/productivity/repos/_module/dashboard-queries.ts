import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { tableExists } from "../../../../../src/core/db/query-helpers.js";

export function queryRepos(db: SqliteDb): unknown {
  if (!tableExists(db, "repos")) return null;
  const stats = db.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN shared = 1 THEN 1 ELSE 0 END) AS shared
     FROM repos WHERE deleted_at IS NULL`,
  ).get() as { total?: number; shared?: number };
  const recent = db.prepare(
    `SELECT id, name, path, language, default_branch, tags, shared, last_seen_at, updated_at
     FROM repos WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 20`,
  ).all();
  const byLanguage: Record<string, number> = {};
  for (const r of recent as Array<{ language: string }>) {
    const k = r.language || "unknown";
    byLanguage[k] = (byLanguage[k] ?? 0) + 1;
  }
  return {
    kpis: { total: stats.total ?? 0, shared: stats.shared ?? 0 },
    recent,
    byLanguage,
  };
}
