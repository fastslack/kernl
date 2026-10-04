import { describe, it, expect } from 'bun:test';
import { withRead, withAllRead } from './notifications.js';
import type { DashboardNotification } from './stores.js';

const n = (id: string, read = 0): DashboardNotification => ({
  id, title: id, body: '', priority: 'normal', source: 'test', read, created_at: '',
});

describe('withRead', () => {
  it('marks only the matching notification', () => {
    expect(withRead([n('a'), n('b')], 'b').map((x) => x.read)).toEqual([0, 1]);
  });
  it('does not mutate the list it is given', () => {
    const list = [n('a')];
    withRead(list, 'a');
    expect(list[0].read).toBe(0);
  });
  it('leaves the list alone for an unknown id', () => {
    expect(withRead([n('a')], 'zz').map((x) => x.read)).toEqual([0]);
  });
});

describe('withAllRead', () => {
  it('marks every notification', () => {
    expect(withAllRead([n('a'), n('b', 1)]).map((x) => x.read)).toEqual([1, 1]);
  });
});
