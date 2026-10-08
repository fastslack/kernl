import { describe, it, expect } from 'bun:test';
import { sortBugs, statusTone, filterBugs, bugCounts, bugClipboardText, type KernlBug } from './kernl-bugs.js';

const b = (id: string, status: KernlBug['status'], last: string) => ({ id, status, last_seen_at: last }) as KernlBug;

describe('sortBugs', () => {
  it('puts what needs a decision first, newest activity within a status', () => {
    const out = sortBugs([b('1', 'dismissed', '3'), b('2', 'published', '9'), b('3', 'new', '1'), b('4', 'new', '5'), b('5', 'fixed', '7')]);
    expect(out.map((x) => x.id)).toEqual(['4', '3', '2', '5', '1']);
  });
});

describe('statusTone', () => {
  it('maps each status', () => {
    expect([statusTone('new'), statusTone('published'), statusTone('fixed'), statusTone('dismissed')]).toEqual(['warn', 'info', 'ok', 'muted']);
  });
});

const full = (over: Partial<KernlBug>) => ({
  id: 'x', status: 'new', title: 't', area: '', diagnosis: '', last_seen_at: '1', ...over,
}) as KernlBug;

describe('filterBugs', () => {
  const list = [
    full({ id: 'n', status: 'new', title: 'Pipeline sin paginación', area: 'tools/career' }),
    full({ id: 'p', status: 'published', title: 'outbox rechaza cuenta' }),
    full({ id: 'f', status: 'fixed', title: 'arreglado' }),
    full({ id: 'd', status: 'dismissed', title: 'descartado' }),
  ];

  it('hides fixed and dismissed by default: open = new + published', () => {
    expect(filterBugs(list, 'open', '').map((b) => b.id)).toEqual(['n', 'p']);
  });

  it('shows one status, or everything', () => {
    expect(filterBugs(list, 'fixed', '').map((b) => b.id)).toEqual(['f']);
    expect(filterBugs(list, 'dismissed', '').map((b) => b.id)).toEqual(['d']);
    expect(filterBugs(list, 'all', '').map((b) => b.id)).toEqual(['n', 'p', 'f', 'd']);
  });

  it('searches title, area and diagnosis, ignoring case and accents', () => {
    expect(filterBugs(list, 'all', 'PAGINACION').map((b) => b.id)).toEqual(['n']);
    expect(filterBugs(list, 'all', 'career').map((b) => b.id)).toEqual(['n']);
    expect(filterBugs(list, 'open', 'arreglado')).toEqual([]);
  });

  it('keeps the open report visible even when the filter would hide it', () => {
    expect(filterBugs(list, 'open', '', 'f').map((b) => b.id)).toEqual(['n', 'p', 'f']);
  });
});

describe('bugCounts', () => {
  it('counts per filter', () => {
    const list = ['new', 'new', 'published', 'fixed', 'dismissed'].map((s, i) => full({ id: String(i), status: s as KernlBug['status'] }));
    expect(bugCounts(list)).toEqual({ open: 3, fixed: 1, dismissed: 1, all: 5 });
  });
});

describe('bugClipboardText', () => {
  it('is the title, the area and the diagnosis', () => {
    expect(bugClipboardText(full({ title: 'T', area: 'tools/career', diagnosis: 'D' }))).toBe('T\nArea: tools/career\n\nD');
    expect(bugClipboardText(full({ title: 'T' }))).toBe('T');
  });
});
