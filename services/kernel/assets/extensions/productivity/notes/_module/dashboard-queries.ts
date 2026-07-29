import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { tableExists, toRecord, today, daysFromNow } from "../../../../../src/core/db/query-helpers.js";

export interface DashboardNotes {
  kpis: { total: number; pinned: number; withTags: number };
  recentNotes: Array<{ id: string; title: string; tags: string; pinned: number; updated_at: string }>;
  pinnedNotes: Array<{ id: string; title: string; tags: string; updated_at: string }>;
  byTag: Record<string, number>;
}

export function queryNotes(db: SqliteDb): DashboardNotes | null {
  if (!tableExists(db, "notes")) return null;

  const stats = db
    .prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN pinned = 1 THEN 1 ELSE 0 END) as pinned,
         SUM(CASE WHEN tags <> '' THEN 1 ELSE 0 END) as withTags
       FROM notes`,
    )
    .get() as { total: number; pinned: number; withTags: number };

  const recentNotes = db
    .prepare(
      `SELECT id, title, tags, pinned, updated_at FROM notes
       ORDER BY updated_at DESC LIMIT 10`,
    )
    .all() as DashboardNotes["recentNotes"];

  const pinnedNotes = db
    .prepare(
      `SELECT id, title, tags, updated_at FROM notes
       WHERE pinned = 1 ORDER BY updated_at DESC LIMIT 10`,
    )
    .all() as DashboardNotes["pinnedNotes"];

  // Tag breakdown — split comma-separated tags
  const tagRows = db
    .prepare(`SELECT tags FROM notes WHERE tags <> ''`)
    .all() as Array<{ tags: string }>;
  const tagCounts: Record<string, number> = {};
  for (const row of tagRows) {
    for (const tag of row.tags.split(",")) {
      const t = tag.trim();
      if (t) tagCounts[t] = (tagCounts[t] ?? 0) + 1;
    }
  }

  return {
    kpis: { total: stats.total ?? 0, pinned: stats.pinned ?? 0, withTags: stats.withTags ?? 0 },
    recentNotes,
    pinnedNotes,
    byTag: tagCounts,
  };
}
