/** Pure helpers for Aprobaciones: filters, batch summary, edits and previews of sequence emails. */
export interface ReviewItem { id: string; status: string; channel: string; payload: Record<string, unknown> }
export interface ReviewFilter { paso: string; perfil: string; especialidad: string }

/** A sequence email: a designed HTML mail that goes out as written. */
export const isTemplated = (it: ReviewItem) => it.payload.html_verbatim === true && typeof it.payload.body_html === 'string';

/** A rehearsal draft: the real mail, addressed to the prospect, that the outbox never approves. Only a test copy goes out. */
export const isRehearsal = (it: ReviewItem) => it.payload.rehearsal === true;

const pasoOf = (it: ReviewItem) => (typeof it.payload.paso === 'number' ? String(it.payload.paso) : '');
const perfilOf = (it: ReviewItem) => (typeof it.payload.perfil === 'string' ? it.payload.perfil : '');
const espOf = (it: ReviewItem) => (typeof it.payload.especialidad === 'string' ? it.payload.especialidad : '');
const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es', { numeric: true }));

export function facets(items: ReviewItem[]) {
  return { paso: uniq(items.map(pasoOf)), perfil: uniq(items.map(perfilOf)), especialidad: uniq(items.map(espOf)) };
}

export function matchesFilter(it: ReviewItem, f: ReviewFilter): boolean {
  return (!f.paso || pasoOf(it) === f.paso) && (!f.perfil || perfilOf(it) === f.perfil) && (!f.especialidad || espOf(it) === f.especialidad);
}

const toOf = (it: ReviewItem) => (Array.isArray(it.payload.to) ? (it.payload.to as unknown[]).map(String) : []);

/** What approving these items does: how many, to how many people, and how many reach real prospects. */
export function batchSummary(items: ReviewItem[]) {
  const test = items.filter((i) => typeof i.payload.test_of === 'string' && i.payload.test_of);
  const all = new Set(items.flatMap(toOf).map((x) => x.toLowerCase()));
  const rehearsal = items.filter(isRehearsal).length;
  return {
    count: items.length, recipients: all.size, test: test.length, real: items.length - test.length - rehearsal, rehearsal,
    sendable: items.length - rehearsal, testTo: uniq(test.flatMap(toOf)),
  };
}

/** The payload after editing its text: a designed mail becomes plain text, so what is approved is what was edited. */
export function editedPayload(payload: Record<string, unknown>, key: 'text' | 'body', text: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...payload, [key]: text };
  if (typeof payload.body_html === 'string') { delete out.body_html; delete out.html_verbatim; delete out.preheader; }
  return out;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The srcdoc of the preview frame: the designed mail exactly as it goes out, or its text. */
export function previewDoc(it: ReviewItem, mode: 'design' | 'text'): string {
  const html = it.payload.body_html;
  if (mode === 'design' && typeof html === 'string') {
    return /^\s*<!doctype|^\s*<html/i.test(html) ? html : `<!doctype html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`;
  }
  const text = typeof it.payload.body === 'string' ? it.payload.body : typeof it.payload.text === 'string' ? it.payload.text : '';
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#fff;color:#111}pre{white-space:pre-wrap;padding:16px;margin:0;font:14px/1.55 Arial,sans-serif}</style></head><body><pre>${esc(text)}</pre></body></html>`;
}

/** What a row and the detail need to read a draft at a glance: who asks, what it asks, what approving it does. */
export interface GlanceItem extends ReviewItem {
  account_ref?: string;
  preview?: { title?: string; meta?: Record<string, string>; choice?: { value: string; options: Array<{ value: string; label: string; hint?: string }> } };
}

/** Who asks for it: the area the draft says it comes from (`from`), else the agent that wrote it. */
export function requesterOf(it: GlanceItem, agent: string): string {
  const from = typeof it.payload.from === 'string' ? it.payload.from.trim() : '';
  return from || agent || 'Un agente';
}

/** The ask without the requester's tag in front of it ("[Seguridad] web: …" reads "web: …" under a Seguridad mark). */
export function cleanTitle(title: string, requester: string): string {
  const t = title.trim();
  const m = /^\[([^\]]{1,40})\]\s*/.exec(t);
  return m && m[1].toLowerCase() === requester.toLowerCase() ? t.slice(m[0].length) || t : t;
}

/** What approving it does, in one line: the destination chosen on the draft, its channel's own note, or where it goes out. */
export function intentOf(it: GlanceItem, channelLabel: string, kind: 'post' | 'mail' | 'chat'): string {
  const c = it.preview?.choice;
  const opt = c?.options.find((o) => o.value === c.value);
  if (opt) return opt.hint ? `${opt.label}: ${opt.hint}` : opt.label;
  const note = it.preview?.meta?.canal;
  if (note) return note.charAt(0).toUpperCase() + note.slice(1);
  const meta = it.preview?.meta ?? {};
  const to = Array.isArray(it.payload.to) ? (it.payload.to as unknown[]).map(String).join(', ') : meta.Para ?? meta.para ?? '';
  const from = it.account_ref ? ` desde ${it.account_ref}` : '';
  if (kind === 'mail') return to ? `Sale un mail a ${to}${from}` : `Sale un mail${from}`;
  if (kind === 'chat') return to ? `Sale un mensaje a ${to}${from}` : `Sale un mensaje${from}`;
  return `${channelLabel}${from}`;
}

/** How many items each project has (key '' = all of them): the project filter shows them, so an empty one reads as empty. */
export function countByProject(items: Array<{ project_id: string | null }>): Record<string, number> {
  const out: Record<string, number> = { '': items.length };
  for (const i of items) { const k = i.project_id ?? ''; if (k) out[k] = (out[k] ?? 0) + 1; }
  return out;
}
