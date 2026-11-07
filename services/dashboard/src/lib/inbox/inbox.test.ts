import { describe, expect, test } from 'bun:test';
import { buildInbox, countByKind, matches } from './inbox';

const NOW = Date.parse('2026-11-07T12:00:00Z');
const ago = (h: number) => new Date(NOW - h * 3600_000).toISOString();
const ahead = (h: number) => new Date(NOW + h * 3600_000).toISOString();

const outbox = [
  { id: 'd1', status: 'draft', channel: 'email', created_at: ago(5), preview: { title: 'Mail a Ana' }, project_id: 'p1' },
  { id: 'f1', status: 'failed', channel: 'web_change', created_at: ago(30), preview: { title: 'Pedido a Desarrollo' }, error: '403' },
  { id: 's1', status: 'sent', channel: 'email', created_at: ago(1), preview: { title: 'ya salió' } },
];
const questions = [
  { id: 'q1', status: 'pending', question: '¿Mergeo?', created_at: ago(2), from_agent_id: 'a1', flow_id: 'f' },
  { id: 'q2', status: 'owed', question: 'Lo ves vos', created_at: ago(40), from_agent_id: 'a1', flow_id: 'f' },
];
const tasks = [
  { id: 't1', status: 'todo', title: 'Sin fecha', created_at: ago(100), due_date: null },
  { id: 't2', status: 'todo', title: 'Vence mañana', created_at: ago(3), due_date: ahead(20) },
  { id: 't3', status: 'done', title: 'Hecha', created_at: ago(3), due_date: null },
];
const reminders = { overdue: [{ id: 'r1', title: 'Pagar', trigger_at: ago(1), status: 'active' }], upcoming24h: [{ id: 'r2', title: 'Llamar', trigger_at: ahead(3), status: 'active' }] };

describe('buildInbox', () => {
  const items = buildInbox({ outbox, questions, tasks, reminders }, NOW);

  test('keeps only what waits on the operator', () => {
    expect(items.map((i) => i.key).sort()).toEqual(['answer:q1', 'answer:q2', 'approve:d1', 'approve:f1', 'reminder:r1', 'reminder:r2', 'task:t1', 'task:t2']);
  });

  test('most urgent first: owed, failed, overdue, pending questions, drafts, then dated work, then the rest', () => {
    expect(items.map((i) => i.key)).toEqual(['answer:q2', 'approve:f1', 'reminder:r1', 'answer:q1', 'approve:d1', 'reminder:r2', 'task:t2', 'task:t1']);
  });

  test('says why an item is urgent', () => {
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(byKey['approve:f1'].urgent).toBe(true);
    expect(byKey['reminder:r1'].urgent).toBe(true);
    expect(byKey['answer:q2'].urgent).toBe(true);
    expect(byKey['approve:d1'].urgent).toBe(false);
    expect(byKey['approve:f1'].title).toBe('Pedido a Desarrollo');
  });

  test('a missing source is just empty', () => {
    expect(buildInbox({ outbox: null, questions: undefined, tasks: [], reminders: null }, NOW)).toEqual([]);
  });

  test('counts per kind and text search', () => {
    expect(countByKind(items)).toEqual({ approve: 2, answer: 2, task: 2, reminder: 2 });
    expect(items.filter((i) => matches(i, 'desarrollo')).map((i) => i.key)).toEqual(['approve:f1']);
    expect(items.filter((i) => matches(i, '')).length).toBe(items.length);
  });
});
