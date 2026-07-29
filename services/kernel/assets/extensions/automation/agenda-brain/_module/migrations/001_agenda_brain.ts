export interface Migration { version: number; sql: string; }
export const migrations: Migration[] = [{
  version: 1,
  sql: `CREATE TABLE IF NOT EXISTS agenda_brief_log (
    id TEXT PRIMARY KEY,
    date_key TEXT NOT NULL,
    slot TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT '',
    item_count INTEGER NOT NULL DEFAULT 0,
    UNIQUE(date_key, slot)
  );`,
}];
