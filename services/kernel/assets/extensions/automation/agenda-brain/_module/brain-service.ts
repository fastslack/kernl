import { scoreItem } from './scoring.js';
import type { AgendaItem, ScoredItem, TodayPlan } from './types.js';

type Db = { prepare: (sql: string) => { all: (...a: unknown[]) => any[] } };

function daysBetween(fromISO: string, toISO: string): number {
  const a = Date.UTC(+fromISO.slice(0, 4), +fromISO.slice(5, 7) - 1, +fromISO.slice(8, 10));
  const b = Date.UTC(+toISO.slice(0, 4), +toISO.slice(5, 7) - 1, +toISO.slice(8, 10));
  return Math.round((b - a) / 86400000);
}

export function planToday(db: Db, dateISO: string): TodayPlan {
  const horizon = new Date(Date.UTC(+dateISO.slice(0, 4), +dateISO.slice(5, 7) - 1, +dateISO.slice(8, 10) + 7))
    .toISOString().slice(0, 10);
  let evs: Array<{ title: string }> = [];
  try {
    evs = db.prepare(
      `SELECT title FROM calendar_events WHERE status != 'cancelled' AND substr(start_at,1,10) BETWEEN ? AND ?`
    ).all(dateISO, horizon) as Array<{ title: string }>;
  } catch {
    // calendar_events absent or schema mismatch — continue without event boost
  }

  const tasks = db.prepare(
    `SELECT id,title,priority,due_date,tags FROM tasks
     WHERE deleted_at IS NULL AND status IN ('todo','in_progress','blocked')`
  ).all() as Array<{ id: string; title: string; priority: string | null; due_date: string | null; tags: string }>;

  // Collect all unique tags across tasks (original case, just trimmed)
  const allTags = new Set<string>();
  for (const t of tasks) {
    if (t.tags) {
      for (const tag of t.tags.split(',')) {
        const trimmed = tag.trim();
        if (trimmed) allTags.add(trimmed);
      }
    }
  }

  // A tag is "active" if its lowercase value appears as a substring in any upcoming event title
  const eventTitlesLower = evs.map((e) => e.title.toLowerCase());
  const activeTags = new Set<string>();
  for (const tag of allTags) {
    if (eventTitlesLower.some((title) => title.includes(tag.toLowerCase()))) {
      activeTags.add(tag);
    }
  }

  let overdue = 0, dueToday = 0;
  const items: ScoredItem[] = tasks.map((t) => {
    const d = t.due_date ? daysBetween(dateISO, t.due_date) : null;
    if (d !== null && d < 0) overdue++;
    if (d === 0) dueToday++;
    const ai: AgendaItem = {
      id: t.id, type: 'task', title: t.title, daysUntilDue: d,
      priority: (t.priority as AgendaItem['priority']) ?? null, tags: t.tags ?? '',
    };
    return scoreItem(ai, activeTags);
  });
  items.sort((a, b) => {
    const aOver = a.daysUntilDue !== null && a.daysUntilDue < 0 ? 1 : 0;
    const bOver = b.daysUntilDue !== null && b.daysUntilDue < 0 ? 1 : 0;
    if (bOver !== aOver) return bOver - aOver; // overdue always first
    return b.score - a.score;
  });
  return { date: dateISO, items, counts: { overdue, dueToday } };
}
