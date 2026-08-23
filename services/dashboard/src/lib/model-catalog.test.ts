import { describe, it, expect } from 'bun:test';
import { parseModelId, buildCatalog, commonModels, rankModels } from './model-catalog.js';

/** The real OpenAI catalogue from a live account, trimmed to the shapes that matter. */
const OPENAI = [
  'gpt-3.5-turbo', 'gpt-3.5-turbo-0125', 'gpt-3.5-turbo-instruct',
  'gpt-4', 'gpt-4-0613', 'gpt-4-turbo', 'gpt-4-turbo-2024-04-09',
  'gpt-4.1', 'gpt-4.1-2025-04-14', 'gpt-4.1-mini', 'gpt-4.1-nano',
  'gpt-4o', 'gpt-4o-2024-05-13', 'gpt-4o-2024-08-06', 'gpt-4o-mini', 'gpt-4o-mini-2024-07-18',
  'gpt-5', 'gpt-5-2025-08-07', 'gpt-5-chat-latest', 'gpt-5-codex', 'gpt-5-mini', 'gpt-5-nano', 'gpt-5-pro',
  'gpt-5.4', 'gpt-5.4-2026-03-05', 'gpt-5.4-mini', 'gpt-5.4-mini-2026-03-17', 'gpt-5.4-pro',
  'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra',
  'o1-pro', 'o3-mini',
].map((id) => ({ id }));

describe('parseModelId', () => {
  it('splits a dated snapshot into alias + date', () => {
    expect(parseModelId('gpt-5.4-mini-2026-03-17')).toEqual({
      base: 'gpt-5.4-mini', family: 'gpt-5.4', tier: 'mini', date: '2026-03-17',
    });
  });

  it('keeps the 4o family together despite the trailing letter', () => {
    expect(parseModelId('gpt-4o-mini').family).toBe('gpt-4o');
    expect(parseModelId('gpt-4o').family).toBe('gpt-4o');
  });

  it('treats a version-less alias as its own family', () => {
    expect(parseModelId('opus')).toEqual({ base: 'opus', family: 'opus', tier: '', date: '' });
  });

  it('handles the o-series', () => {
    expect(parseModelId('o3-mini')).toEqual({ base: 'o3-mini', family: 'o3', tier: 'mini', date: '' });
  });
});

describe('buildCatalog', () => {
  const groups = buildCatalog(OPENAI);

  it('folds dated snapshots into the alias instead of listing them', () => {
    const rows = groups.flatMap((g) => g.rows);
    expect(rows.some((r) => r.id.endsWith('2026-03-17'))).toBe(false);
    const mini = rows.find((r) => r.id === 'gpt-5.4-mini')!;
    expect(mini.snapshots.map((s) => s.id)).toEqual(['gpt-5.4-mini-2026-03-17']);
  });

  it('collapses the list — 33 ids become 25 rows', () => {
    expect(OPENAI).toHaveLength(33);
    const rows = groups.flatMap((g) => g.rows);
    expect(rows).toHaveLength(25);
    // Nothing is lost: every id is either a row or folded into one.
    const total = rows.length + rows.reduce((n, r) => n + r.snapshots.length, 0);
    expect(total).toBe(OPENAI.length);
  });

  it('puts the newest family first and the oldest last', () => {
    const fams = groups.map((g) => g.family);
    expect(fams[0]).toBe('gpt-5.6');
    expect(fams[fams.length - 1]).toBe('o1');
    // The whole gpt- run precedes the o- run rather than interleaving by number.
    expect(fams.filter((f) => f.startsWith('gpt-')).at(-1)).toBe('gpt-3.5');
    expect(fams.indexOf('gpt-3.5')).toBeLessThan(fams.indexOf('o3'));
  });

  it('this is the regression: gpt-3.5 used to be the first thing you saw', () => {
    expect(groups[0].family).not.toBe('gpt-3.5');
    expect(groups[0].rows[0].id.startsWith('gpt-5.6')).toBe(true);
  });

  it('orders inside a family by specificity', () => {
    const g = groups.find((x) => x.family === 'gpt-5')!;
    expect(g.rows[0].id).toBe('gpt-5');
  });

  it('keeps a dated model whose alias the provider does not offer', () => {
    const only = buildCatalog([{ id: 'gpt-9-2027-01-01' }]);
    expect(only.flatMap((g) => g.rows).map((r) => r.id)).toEqual(['gpt-9-2027-01-01']);
  });

  it('survives an empty list', () => {
    expect(buildCatalog([])).toEqual([]);
  });
});

describe('commonModels', () => {
  const groups = buildCatalog(OPENAI);

  it('leads with what you actually used', () => {
    const out = commonModels(groups, ['gpt-4o-mini'], 4);
    expect(out[0].id).toBe('gpt-4o-mini');
  });

  it('derives the rest from the newest family, never a hardcoded list', () => {
    const out = commonModels(groups, [], 5).map((r) => r.id);
    expect(out[0].startsWith('gpt-5.6')).toBe(true);
    expect(out).not.toContain('gpt-3.5-turbo');
  });

  it('represents a family made only of named variants', () => {
    // gpt-5.6 is luna/sol/terra — no plain member, no traits. It was falling
    // out of the strip entirely, so the newest models went unoffered.
    const only = buildCatalog(['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-4o'].map((id) => ({ id })));
    expect(commonModels(only, [], 2)[0].id.startsWith('gpt-5.6')).toBe(true);
  });

  it('never repeats a model that was already recent', () => {
    const out = commonModels(groups, ['gpt-5.6-luna'], 5).map((r) => r.id);
    expect(new Set(out).size).toBe(out.length);
  });

  it('ignores a recent model the provider no longer offers', () => {
    const out = commonModels(groups, ['gpt-4-vision-preview'], 3).map((r) => r.id);
    expect(out).not.toContain('gpt-4-vision-preview');
    expect(out).toHaveLength(3);
  });
});

describe('rankModels', () => {
  it('an exact id wins outright', () => {
    expect(rankModels(OPENAI, 'gpt-5')[0].id).toBe('gpt-5');
  });

  it('the alias beats its own dated snapshot', () => {
    const ids = rankModels(OPENAI, '5.4').map((m) => m.id);
    expect(ids.indexOf('gpt-5.4')).toBeLessThan(ids.indexOf('gpt-5.4-2026-03-05'));
  });

  it('the newest family comes first for a shared query', () => {
    const ids = rankModels(OPENAI, 'mini').map((m) => m.id);
    expect(ids[0]).toBe('gpt-5.4-mini');
    expect(ids.indexOf('gpt-5.4-mini')).toBeLessThan(ids.indexOf('gpt-4o-mini'));
  });

  it('prefix matches outrank matches from the middle of an id', () => {
    const ids = rankModels(OPENAI, 'gpt-4').map((m) => m.id);
    expect(ids[0]).toBe('gpt-4');
  });

  it('still finds a model when the separators are dropped', () => {
    expect(rankModels(OPENAI, 'gpt54mini').map((m) => m.id)).toContain('gpt-5.4-mini');
  });

  it('marks which results are dated snapshots', () => {
    const hit = rankModels(OPENAI, 'gpt-5.4-2026').find((m) => m.id === 'gpt-5.4-2026-03-05');
    expect(hit?.snapshot).toBe(true);
  });

  it('carries highlight offsets for a literal hit only', () => {
    expect(rankModels(OPENAI, 'codex')[0].hi).toEqual([6, 11]);
    expect(rankModels(OPENAI, 'gpt54mini')[0].hi).toBeUndefined();
  });

  it('an empty query returns everything, untouched', () => {
    expect(rankModels(OPENAI, '  ')).toHaveLength(OPENAI.length);
  });

  it('no match is an empty list, not the whole catalogue', () => {
    expect(rankModels(OPENAI, 'zzzqqq')).toEqual([]);
  });
});
