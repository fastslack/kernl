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
