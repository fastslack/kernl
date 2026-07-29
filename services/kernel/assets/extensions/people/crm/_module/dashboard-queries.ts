import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { toRecord } from "../../../../../src/core/db/query-helpers.js";

export interface DashboardCrm {
  total: number;
  byRelationship: Record<string, number>;
  staleContacts: Array<{ id: string; name: string; last_interaction: string | null }>;
  recentInteractions: Array<{
    contact_name: string;
    type: string;
    summary: string;
    date: string;
  }>;
}

export function queryCrm(db: SqliteDb): DashboardCrm {
  const total = (
    db.prepare(`SELECT COUNT(*) as count FROM contacts`).get() as { count: number }
  ).count;

  const byRelationship = toRecord(
    db
      .prepare(`SELECT relationship as key, COUNT(*) as count FROM contacts GROUP BY relationship`)
      .all() as Array<{ key: string; count: number }>,
  );

  const staleContacts = db
    .prepare(
      `SELECT id, name, last_interaction FROM contacts
       WHERE last_interaction IS NULL OR last_interaction < date('now', '-30 days')
       ORDER BY last_interaction ASC NULLS FIRST
       LIMIT 10`,
    )
    .all() as DashboardCrm["staleContacts"];

  const recentInteractions = db
    .prepare(
      `SELECT c.name as contact_name, i.type, i.summary, i.date
       FROM interactions i JOIN contacts c ON c.id = i.contact_id
       ORDER BY i.date DESC, i.created_at DESC
       LIMIT 10`,
    )
    .all() as DashboardCrm["recentInteractions"];

  return { total, byRelationship, staleContacts, recentInteractions };
}
