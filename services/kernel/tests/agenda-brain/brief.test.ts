import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrations } from '../../assets/extensions/automation/agenda-brain/_module/migrations/001_agenda_brain.js';
import { buildBrief, alreadySent, recordSent } from '../../assets/extensions/automation/agenda-brain/_module/brief.js';

function mkDb() {
  const db: any = new Database(':memory:');
  for (const m of migrations) db.exec(m.sql);
  return db;
}

describe('brief', () => {
  it('morning brief lists top items with why', () => {
    const plan = { date: '2026-06-29', counts: { overdue: 1, dueToday: 1 }, items: [
      { id: 't2', type: 'task', title: 'Urgent today', daysUntilDue: 0, priority: 'urgent', tags: '', score: 120, why: 'urgent · due today' },
    ] as any };
    const b = buildBrief(plan, 'morning');
    expect(b.title.toLowerCase()).toContain('today');
    expect(b.body).toContain('Urgent today');
    expect(b.body).toContain('urgent');
  });

  it('dedup: alreadySent flips after recordSent', () => {
    const db = mkDb();
    expect(alreadySent(db, '2026-06-29', 'morning')).toBe(false);
    recordSent(db, '2026-06-29', 'morning', 'telegram', 3);
    expect(alreadySent(db, '2026-06-29', 'morning')).toBe(true);
    expect(alreadySent(db, '2026-06-29', 'evening')).toBe(false);
  });
});
