/**
 * The Bandeja: everything that waits on the operator, from the sources that already hold it — drafts and failed
 * sends (outbox), the agents' questions, the tasks the mail and the agents leave, and the reminders that are due.
 * One list, most urgent first. Pure: the page fetches, this sorts.
 */

export type InboxKind = 'approve' | 'answer' | 'task' | 'reminder';

export interface InboxItem {
  key: string;
  kind: InboxKind;
  id: string;
  title: string;
  /** Where it comes from, as a person reads it: the channel, the office, the due date. Filled by the page. */
  sub: string;
  /** The time that orders it inside its rank (creation for decisions, due/trigger time for dated work). */
  at: string;
  urgent: boolean;
  rank: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: any;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface InboxSources {
  outbox?: any[] | null;
  questions?: any[] | null;
  tasks?: any[] | null;
  reminders?: { overdue?: any[]; upcoming24h?: any[] } | null;
}

/**
 * 0 owed questions (the operator said «lo veo yo») · 1 failed sends · 2 overdue reminders · 3 open questions ·
 * 4 drafts · 5 dated work (reminders in the next 24 h, tasks with a due date), soonest first · 6 the rest.
 */
export function buildInbox(src: InboxSources, now = Date.now()): InboxItem[] {
  const out: InboxItem[] = [];
  for (const o of src.outbox ?? []) {
    if (o.status !== 'draft' && o.status !== 'failed') continue;
    out.push({ key: `approve:${o.id}`, kind: 'approve', id: o.id, title: o.preview?.title || o.channel, sub: '', at: o.created_at,
      urgent: o.status === 'failed', rank: o.status === 'failed' ? 1 : 4, raw: o });
  }
  for (const q of src.questions ?? []) {
    if (q.status !== 'pending' && q.status !== 'owed') continue;
    out.push({ key: `answer:${q.id}`, kind: 'answer', id: q.id, title: q.question, sub: '', at: q.created_at,
      urgent: q.status === 'owed', rank: q.status === 'owed' ? 0 : 3, raw: q });
  }
  for (const t of src.tasks ?? []) {
    if (t.status !== 'todo') continue;
    const due = t.due_date ? Date.parse(t.due_date) : NaN;
    out.push({ key: `task:${t.id}`, kind: 'task', id: t.id, title: t.title, sub: '', at: Number.isNaN(due) ? t.created_at : t.due_date,
      urgent: !Number.isNaN(due) && due < now, rank: Number.isNaN(due) ? 6 : 5, raw: t });
  }
  const seen = new Set<string>();
  for (const [list, overdue] of [[src.reminders?.overdue, true], [src.reminders?.upcoming24h, false]] as const) {
    for (const r of list ?? []) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push({ key: `reminder:${r.id}`, kind: 'reminder', id: r.id, title: r.title, sub: '', at: r.trigger_at,
        urgent: overdue, rank: overdue ? 2 : 5, raw: r });
    }
  }
  return out.sort((a, b) => a.rank - b.rank || Date.parse(a.at) - Date.parse(b.at));
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function countByKind(items: InboxItem[]): Record<InboxKind, number> {
  const c: Record<InboxKind, number> = { approve: 0, answer: 0, task: 0, reminder: 0 };
  for (const i of items) c[i.kind]++;
  return c;
}

/** Case- and accent-insensitive search over the title and the source line. */
export function matches(item: InboxItem, q: string): boolean {
  const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const needle = norm(q.trim());
  return !needle || norm(`${item.title} ${item.sub}`).includes(needle);
}
