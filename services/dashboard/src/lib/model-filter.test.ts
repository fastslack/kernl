/**
 * Run with `bun test src/lib/model-filter.test.ts` from services/dashboard.
 * (The dashboard has no test script wired up; bun is already the kernel's
 * runner and needs no dependency here.)
 */
import { test, expect } from 'bun:test';
import { filterProviderModels, countModels, squash, matchLabel, filterLabels } from './model-filter.js';

const OPENAI = {
  slug: 'openai',
  name: 'OpenAI',
  ready: true,
  models: [
    'gpt-3.5-turbo', 'gpt-4', 'gpt-4-turbo', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano',
    'gpt-4o', 'gpt-4o-mini', 'gpt-5', 'gpt-5-chat-latest', 'gpt-5-codex', 'gpt-5-mini',
    'gpt-5-nano',
  ],
};
const XAI = { slug: 'grok', name: 'xAI Grok', ready: true, models: ['grok-4', 'grok-4-fast-non-reasoning'] };
const OFFLINE = { slug: 'nvidia', name: 'NVIDIA NIM', ready: false, models: [] };
const ALL = [OPENAI, XAI, OFFLINE];

test('an empty query lists every provider, offline included', () => {
  const groups = filterProviderModels(ALL, '');
  expect(groups.map((g) => g.provider.slug)).toEqual(['openai', 'grok', 'nvidia']);
  expect(countModels(groups)).toBe(15);
});

// The regression this whole extraction exists for.
test('a query that is a substring of the provider name still narrows', () => {
  // "o" appears in "OpenAI"; the old filter returned all 13 openai models.
  const groups = filterProviderModels(ALL, 'o');
  const models = groups.flatMap((g) => g.items.map((it) => it.model));
  expect(models.length).toBeLessThan(15);
  expect(models).toContain('gpt-4o');
  expect(models).not.toContain('gpt-5');
});

test('"nano" reaches only the nano models', () => {
  const groups = filterProviderModels(ALL, 'nano');
  expect(groups.flatMap((g) => g.items.map((it) => it.model)).sort())
    .toEqual(['gpt-4.1-nano', 'gpt-5-nano']);
});

test('separators are ignored on both sides', () => {
  const models = filterProviderModels(ALL, 'gpt41mini').flatMap((g) => g.items.map((it) => it.model));
  expect(models).toEqual(['gpt-4.1-mini']);
});

test('a literal match carries highlight offsets, a squashed one does not', () => {
  const [g] = filterProviderModels([OPENAI], 'gpt-5-co');
  expect(g.items[0].model).toBe('gpt-5-codex');
  expect(g.items[0].hi).toEqual([0, 8]);

  const [g2] = filterProviderModels([OPENAI], 'gpt5codex');
  expect(g2.items[0].model).toBe('gpt-5-codex');
  expect(g2.items[0].hi).toBeUndefined();
});

test('offline providers are dropped once a query is typed', () => {
  expect(filterProviderModels(ALL, 'gpt').map((g) => g.provider.slug)).toEqual(['openai']);
});

test('a provider name is a fallback, not a widener', () => {
  // No model id contains "xai" — so the query resolves to the provider.
  const groups = filterProviderModels(ALL, 'xai');
  expect(groups.map((g) => g.provider.slug)).toEqual(['grok']);
  expect(countModels(groups)).toBe(2);
  // ...but it must not fire while model ids still match: "grok" hits both.
  expect(countModels(filterProviderModels(ALL, 'grok'))).toBe(2);
  expect(filterProviderModels(ALL, 'grok')[0].items.every((it) => it.model !== '')).toBe(true);
});

test('no match yields no groups rather than everything', () => {
  expect(filterProviderModels(ALL, 'zzzqqq')).toEqual([]);
});

test('an all-separator query is treated as empty, not as match-all', () => {
  expect(countModels(filterProviderModels(ALL, '---'))).toBe(15);
});

test('squash normalises the way ids are punctuated', () => {
  expect(squash('GPT-4.1-Mini')).toBe('gpt41mini');
});

// ── The flat-list matcher the settings dropdowns use ──────────────

test('matchLabel reports literal offsets and squashed hits differently', () => {
  expect(matchLabel('gpt-5-codex', 'codex')).toEqual({ hi: [6, 11] });
  expect(matchLabel('gpt-5-codex', 'gpt5codex')).toEqual({});
  expect(matchLabel('gpt-5-codex', 'claude')).toBeNull();
});

test('matchLabel treats an empty or all-separator query as a match', () => {
  expect(matchLabel('anything', '')).toEqual({});
  expect(matchLabel('anything', '  ')).toEqual({});
  expect(matchLabel('anything', '---')).toEqual({});
});

test('filterLabels narrows a flat option list and carries the offsets', () => {
  const opts = [
    { value: 'a', label: 'gpt-4o-mini' },
    { value: 'b', label: 'gpt-5-pro' },
    { value: 'c', label: 'claude-opus-5' },
  ];
  expect(filterLabels(opts, 'gpt5').map((o) => o.value)).toEqual(['b']);
  expect(filterLabels(opts, 'opus')[0].hi).toEqual([7, 11]);
  expect(filterLabels(opts, '')).toHaveLength(3);
  expect(filterLabels(opts, 'zzz')).toHaveLength(0);
});
