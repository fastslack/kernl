import { newId, isoNow } from '../../../../../src/core/helpers.js';
import type { TodayPlan } from './types.js';

export function buildBrief(plan: TodayPlan, slot: 'morning' | 'evening'): { title: string; body: string } {
  const top = plan.items.slice(0, 5);
  const lines = top.map((i, n) => `${n + 1}. ${i.title} — _${i.why}_`);
  const head = slot === 'morning' ? '☀️ Your day' : '🌙 End of day';
  const counts = `${plan.counts.overdue} overdue · ${plan.counts.dueToday} due today`;
  const title = slot === 'morning' ? 'What do I do today' : 'Pending and tomorrow';
  const body = `${head} (${plan.date})\n${counts}\n\n${lines.join('\n') || 'Nothing urgent 🎉'}`;
  return { title, body };
}

type Db = { prepare: (s: string) => { get: (...a: unknown[]) => unknown; run: (...a: unknown[]) => unknown } };

export function alreadySent(db: Db, dateKey: string, slot: string): boolean {
  return !!db.prepare(`SELECT 1 FROM agenda_brief_log WHERE date_key=? AND slot=?`).get(dateKey, slot);
}

export function recordSent(db: Db, dateKey: string, slot: string, channel: string, itemCount: number): void {
  db.prepare(`INSERT OR IGNORE INTO agenda_brief_log (id,date_key,slot,sent_at,channel,item_count)
    VALUES (?,?,?,?,?,?)`).run(newId(), dateKey, slot, isoNow(), channel, itemCount);
}
