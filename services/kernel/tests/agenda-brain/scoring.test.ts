import { describe, it, expect } from 'bun:test';
import { urgency, priorityWeight, scoreItem } from '../../assets/extensions/automation/agenda-brain/_module/scoring.js';

describe('urgency', () => {
  it('ranks overdue highest and no-date lowest', () => {
    expect(urgency(-2)).toBe(100);
    expect(urgency(0)).toBe(80);
    expect(urgency(1)).toBe(60);
    expect(urgency(3)).toBe(40);
    expect(urgency(7)).toBe(20);
    expect(urgency(30)).toBe(10);
    expect(urgency(null)).toBe(5);
  });
});

describe('scoreItem', () => {
  const base = { id: 'a', type: 'task' as const, title: 'X', daysUntilDue: 1, priority: 'high' as const, tags: '' };

  it('deadline dominates priority', () => {
    const overdueLatest = scoreItem({ ...base, daysUntilDue: -1, priority: 'low' }, new Set());
    const soonUrgent = scoreItem({ ...base, daysUntilDue: 7, priority: 'urgent' }, new Set());
    expect(overdueLatest.score).toBeGreaterThan(soonUrgent.score);
  });

  it('adds project boost when a tag is active', () => {
    const off = scoreItem({ ...base, tags: 'viaje-argentina,casa' }, new Set());
    const on = scoreItem({ ...base, tags: 'viaje-argentina,casa' }, new Set(['viaje-argentina']));
    expect(on.score - off.score).toBe(20);
    expect(on.why).toContain('viaje');
  });

  it('why names the dominant factors', () => {
    const s = scoreItem({ ...base, daysUntilDue: 0, priority: 'urgent' }, new Set());
    expect(s.why.toLowerCase()).toContain('urgent');
    expect(s.why.toLowerCase()).toContain('today');
  });
});
