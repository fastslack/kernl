import type { SqliteDb } from "../../core/db/sqlite.js";
import { tableExists, safeAll, safeGet, toRecord } from "../../core/db/query-helpers.js";

export interface DashboardChat {
  kpis: {
    totalEpisodes: number;
    activeEpisodes: number;
    archivedEpisodes: number;
    totalMessages: number;
    totalTokens: number;
    totalExtractions: number;
  };
  recentEpisodes: Array<{
    id: string;
    title: string;
    status: string;
    message_count: number;
    total_tokens: number;
    llm_provider: string;
    updated_at: string;
  }>;
  extractionsByType: Record<string, number>;
  topEntities: Array<{ label: string; entity_type: string; count: number }>;
}

export function queryChat(db: SqliteDb): DashboardChat | null {
  if (!tableExists(db, "chat_episodes")) return null;

  const totalEpisodes = (db.prepare("SELECT COUNT(*) as c FROM chat_episodes").get() as { c: number }).c;
  const activeEpisodes = (db.prepare("SELECT COUNT(*) as c FROM chat_episodes WHERE status = 'active'").get() as { c: number }).c;
  const archivedEpisodes = (db.prepare("SELECT COUNT(*) as c FROM chat_episodes WHERE status = 'archived'").get() as { c: number }).c;
  const totalMessages = (db.prepare("SELECT COUNT(*) as c FROM chat_messages").get() as { c: number }).c;
  const totalTokens = (db.prepare("SELECT COALESCE(SUM(total_tokens), 0) as c FROM chat_episodes").get() as { c: number }).c;

  const totalExtractions = safeGet(db, "SELECT COUNT(*) as c FROM chat_extractions", [], { c: 0 }).c;

  const recentEpisodes = db
    .prepare(
      `SELECT id, title, status, message_count, total_tokens, llm_provider, updated_at
       FROM chat_episodes ORDER BY updated_at DESC LIMIT 10`,
    )
    .all() as DashboardChat["recentEpisodes"];

  const extractionTypeRows = safeAll<{ key: string; count: number }>(db,
    "SELECT entity_type as key, COUNT(*) as count FROM chat_extractions GROUP BY entity_type",
  );
  const extractionsByType = toRecord(extractionTypeRows);

  const topEntities = safeAll<DashboardChat["topEntities"][number]>(db,
    `SELECT label, entity_type, COUNT(*) as count
     FROM chat_extractions
     WHERE label <> ''
     GROUP BY label, entity_type
     ORDER BY count DESC LIMIT 20`,
  );

  return {
    kpis: { totalEpisodes, activeEpisodes, archivedEpisodes, totalMessages, totalTokens, totalExtractions },
    recentEpisodes,
    extractionsByType,
    topEntities,
  };
}
