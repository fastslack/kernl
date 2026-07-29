import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { planToday } from '../../assets/extensions/automation/agenda-brain/_module/brain-service.js';

function seed(db: any) {
  db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL,
    priority TEXT, due_date TEXT, tags TEXT NOT NULL DEFAULT '', deleted_at TEXT);`);
  db.exec(`CREATE TABLE calendar_events (id TEXT PRIMARY KEY, title TEXT NOT NULL, start_at TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'confirmed');`);
  const ins = db.prepare(`INSERT INTO tasks (id,title,status,priority,due_date,tags) VALUES (?,?,?,?,?,?)`);
  ins.run('t1', 'Vencida vieja', 'todo', 'low', '2026-06-20', '');
  ins.run('t2', 'Hoy urgente', 'todo', 'urgent', '2026-06-29', '');
  ins.run('t3', 'Valija viaje', 'todo', 'medium', '2026-07-07', 'viaje-argentina');
  ins.run('t4', 'Done ignorar', 'done', 'high', '2026-06-29', '');
  db.prepare(`INSERT INTO calendar_events (id,title,start_at,status) VALUES (?,?,?,?)`)
    .run('e1', 'Vuelo viaje-argentina', '2026-07-01T10:00:00Z', 'confirmed');
}

describe('planToday', () => {
  let db: any;
  beforeEach(() => { db = new Database(':memory:'); seed(db); });

  it('orders by score and excludes done', () => {
    const plan = planToday(db, '2026-06-29');
    const ids = plan.items.map((i: any) => i.id);
    expect(ids).not.toContain('t4');           // done excluida
    expect(ids[0]).toBe('t1');                  // vencida = urgency 100
    expect(plan.counts.overdue).toBe(1);
    expect(plan.counts.dueToday).toBe(1);
  });
});
