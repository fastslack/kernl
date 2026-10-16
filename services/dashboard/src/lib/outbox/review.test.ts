import { describe, it, expect } from 'bun:test';
import { isTemplated, isRehearsal, facets, matchesFilter, batchSummary, editedPayload, previewDoc } from './review.js';

const t = (id: string, p: Record<string, unknown>) => ({ id, status: 'draft', channel: 'email', payload: p });
const A = t('a', { to: ['operator@example.com'], test_of: 'x@x.ar', subject: 's', body: 'b', body_html: '<!doctype html><html><head><style>.x{color:red}</style></head><body>h</body></html>', html_verbatim: true, paso: 1, perfil: 'cronico', especialidad: 'Cardiología' });
const B = t('b', { to: ['operator@example.com'], test_of: 'y@y.ar', subject: 's', body: 'b', body_html: '<p>h</p>', html_verbatim: true, paso: 1, perfil: 'centros', especialidad: 'Centro médico' });
const C = t('c', { to: ['real@z.ar'], subject: 's', body: 'b', body_html: '<p>h</p>', html_verbatim: true, paso: 2, perfil: 'agenda', especialidad: 'Pediatría' });
const plain = t('d', { to: ['q@q.ar'], subject: 's', body: 'hola' });

describe('outbox review', () => {
  it('knows a sequence email', () => {
    expect(isTemplated(A)).toBe(true);
    expect(isTemplated(plain)).toBe(false);
  });

  it('builds filters from what the drafts carry, and applies them', () => {
    expect(facets([A, B, C, plain])).toEqual({ paso: ['1', '2'], perfil: ['agenda', 'centros', 'cronico'], especialidad: ['Cardiología', 'Centro médico', 'Pediatría'] });
    expect(matchesFilter(C, { paso: '2', perfil: '', especialidad: '' })).toBe(true);
    expect(matchesFilter(A, { paso: '2', perfil: '', especialidad: '' })).toBe(false);
    expect(matchesFilter(plain, { paso: '', perfil: '', especialidad: '' })).toBe(true);
  });

  it('summarizes a batch: test sends vs real prospects, and distinct recipients', () => {
    expect(batchSummary([A, B, C])).toEqual({ count: 3, recipients: 2, test: 2, real: 1, rehearsal: 0, sendable: 3, testTo: ['operator@example.com'] });
  });

  it('editing a designed draft drops its HTML so what is approved is what was edited', () => {
    const e = editedPayload(A.payload, 'body', 'nuevo');
    expect(e).toMatchObject({ body: 'nuevo', paso: 1 });
    expect(e.body_html).toBeUndefined();
    expect(e.html_verbatim).toBeUndefined();
    expect(editedPayload(plain.payload, 'body', 'x')).toEqual({ to: ['q@q.ar'], subject: 's', body: 'x' });
  });

  it('previews the full designed mail as sent, or the text escaped', () => {
    expect(previewDoc(A, 'design')).toBe(A.payload.body_html as string);
    expect(previewDoc(B, 'design')).toContain('<p>h</p>');
    expect(previewDoc(t('e', { body: '<b>x</b> & y' }), 'text')).toContain('&lt;b&gt;x&lt;/b&gt; &amp; y');
  });

  it('a rehearsal draft is the real mail that never goes out: not real, not sendable', () => {
    const R = t('r', { to: ['real@z.ar'], subject: 's', body: 'b', body_html: '<p>h</p>', html_verbatim: true, paso: 1, rehearsal: true });
    expect(isRehearsal(R)).toBe(true);
    expect(isRehearsal(C)).toBe(false);
    expect(batchSummary([R, C])).toMatchObject({ count: 2, real: 1, rehearsal: 1, sendable: 1 });
  });
});

