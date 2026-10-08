import { describe, it, expect } from 'vitest';
import { byUsage, foldUsage, fmtUses } from './model-usage.js';
import { priceKey } from './model-prices.js';

describe('foldUsage', () => {
  it('sums calls per model and per provider', () => {
    const u = foldUsage([
      { key: 'claude-opus-5', slug: 'claude-code', calls: 10 },
      { key: 'claude-sonnet-5', slug: 'claude-code', calls: 5 },
      { key: 'kimi', slug: 'nvidia', calls: 7 },
      { key: 'orphan', calls: 99 },
    ]);
    expect(u.byModel.get(priceKey('claude-code', 'claude-opus-5'))).toBe(10);
    expect(u.bySlug.get('claude-code')).toBe(15);
    expect(u.bySlug.get('nvidia')).toBe(7);
    expect(u.byModel.size).toBe(3);
  });
});

describe('byUsage', () => {
  it('puts the most used first and keeps the given order for ties', () => {
    const calls: Record<string, number> = { b: 3, d: 9 };
    expect(byUsage(['a', 'b', 'c', 'd', 'e'], (x) => calls[x] ?? 0)).toEqual(['d', 'b', 'a', 'c', 'e']);
  });
});

describe('fmtUses', () => {
  it('shortens big counts', () => {
    expect(fmtUses(42)).toBe('42');
    expect(fmtUses(2680)).toBe('2,7k');
    expect(fmtUses(12_400)).toBe('12k');
    expect(fmtUses(1_500_000)).toBe('1,5M');
  });
});
