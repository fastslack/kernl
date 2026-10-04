import { describe, it, expect } from 'bun:test';
import { fillDays, rangeBounds, usageUrl, sumRows, fmtCost, fmtTokens, type UsageRow } from './llm-usage.js';

const NOW = Date.UTC(2026, 9, 3, 15);

const row = (over: Partial<UsageRow>): UsageRow => ({
  key: 'm', calls: 1, fails: 0, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0,
  costUsd: 0, costKind: 'none', ...over,
});

describe('llm usage', () => {
  it('turns a range chip into inclusive UTC days', () => {
    expect(rangeBounds('today', NOW)).toEqual({ from: '2026-10-03', to: '2026-10-03' });
    expect(rangeBounds('7d', NOW)).toEqual({ from: '2026-09-27', to: '2026-10-03' });
    expect(rangeBounds('all', NOW)).toEqual({});
  });

  it('builds the query with the drill-down filter', () => {
    expect(usageUrl('caller', '30d', { slug: 'nvidia', model: 'a/b' }, NOW))
      .toBe('/api/llm/usage?group=caller&from=2026-09-04&to=2026-10-03&slug=nvidia&model=a%2Fb');
  });

  it('sums rows and says where the money comes from', () => {
    expect(sumRows([row({ costKind: 'reported', costUsd: 1 }), row({ costKind: 'reported', costUsd: 2 })]))
      .toMatchObject({ calls: 2, inputTokens: 20, costUsd: 3, costKind: 'reported' });
    expect(sumRows([row({ costKind: 'reported', costUsd: 1 }), row({})]).costKind).toBe('mixed');
    expect(sumRows([row({})]).costKind).toBe('none');
  });

  it('fills the days without calls so the chart axis is time', () => {
    const days = fillDays([row({ key: '2026-10-03' }), row({ key: '2026-09-30' })]);
    expect(days.map((d) => [d.key, d.calls])).toEqual([
      ['2026-09-30', 1], ['2026-10-01', 0], ['2026-10-02', 0], ['2026-10-03', 1],
    ]);
    expect(fillDays([], '2026-10-01', '2026-10-02')).toHaveLength(2);
    expect(fillDays([])).toEqual([]);
  });

  it('formats cost and tokens', () => {
    expect(fmtCost(0, 'none', 'en')).toBe('—');
    expect(fmtCost(12.4, 'reported', 'en')).toBe('$12.40');
    expect(fmtCost(0.004, 'estimated', 'en')).toBe('≈ < $0.01');
    expect(fmtTokens(1_780_000, 'en')).toBe('1.8M');
    expect(fmtTokens(0, 'en')).toBe('0');
  });
});
