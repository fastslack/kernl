import { describe, it, expect } from 'bun:test';
import { sortBugs, statusTone, type KernlBug } from './kernl-bugs.js';

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
