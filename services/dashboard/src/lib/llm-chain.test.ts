import { describe, it, expect } from 'bun:test';
import {
  statusLabel, fmtSince, fmtCountdown, fmtElapsed, oldestInFlight, inFlightTotal, chainPollMs,
  modelMatches, callsForLink, usageForLink, utcDay, fmtTokens, fmtCost, type ChainLink,
} from './llm-chain.js';

describe('statusLabel', () => {
  it('names every chain status', () => {
    expect(statusLabel('active')).toBe('ACTIVE');
    expect(statusLabel('standby')).toBe('STANDBY');
    expect(statusLabel('no-key')).toBe('NO KEY');
    expect(statusLabel('quota')).toBe('NO CREDIT');
    expect(statusLabel('rate-limit')).toBe('RATE LIMITED');
    expect(statusLabel('auth')).toBe('AUTH FAILED');
    expect(statusLabel('degraded')).toBe('DEGRADED');
  });
});

describe('fmtSince', () => {
  const now = 1_000_000_000;
  it('is an em dash when there was no success', () => {
    expect(fmtSince(undefined, now)).toBe('—');
    expect(fmtSince(0, now)).toBe('—');
  });
  it('picks seconds, minutes or hours', () => {
    expect(fmtSince(now - 12_000, now)).toBe('12s ago');
    expect(fmtSince(now - 4 * 60_000, now)).toBe('4m ago');
    expect(fmtSince(now - 2 * 3_600_000, now)).toBe('2h ago');
  });
});

describe('fmtCountdown', () => {
  it('is empty with no backoff left', () => {
    expect(fmtCountdown(undefined)).toBe('');
    expect(fmtCountdown(0)).toBe('');
    expect(fmtCountdown(-5)).toBe('');
  });
  it('picks seconds, minutes or hours', () => {
    expect(fmtCountdown(30_000)).toBe('30s');
    expect(fmtCountdown(5 * 60_000)).toBe('5m');
    expect(fmtCountdown(3_600_000)).toBe('1h');
  });
});

const link = (over: Partial<ChainLink> = {}): ChainLink => ({ slug: 'openai', provider: 'openai', model: '', status: 'active', failures: 0, ...over });

describe('calls in flight', () => {
  it('ticks as m:ss, then h:mm:ss, never negative', () => {
    expect(fmtElapsed(0)).toBe('0:00');
    expect(fmtElapsed(7_400)).toBe('0:07');
    expect(fmtElapsed(83_000)).toBe('1:23');
    expect(fmtElapsed(3_723_000)).toBe('1:02:03');
    expect(fmtElapsed(-500)).toBe('0:00');
  });
  it('finds the oldest call and counts across the chain', () => {
    const a = link({ inFlight: [{ caller: 'x', startedAt: 50 }, { startedAt: 20 }] });
    const b = link({ inFlight: [] });
    expect(oldestInFlight(a)).toBe(20);
    expect(oldestInFlight(b)).toBeUndefined();
    expect(oldestInFlight(link())).toBeUndefined();
    expect(inFlightTotal([a, b, link()])).toBe(2);
  });
  it('polls every 2 s only while open with something running', () => {
    expect(chainPollMs(true, 1)).toBe(2000);
    expect(chainPollMs(true, 0)).toBe(5000);
    expect(chainPollMs(false, 3)).toBe(5000);
  });
});

describe('details of a link', () => {
  it('matches the model exactly; a link with no model takes every model', () => {
    expect(modelMatches('', 'anything')).toBe(true);
    expect(modelMatches('gpt-5', 'gpt-5')).toBe(true);
    expect(modelMatches('gpt-5', 'gpt-5-mini')).toBe(false);
    expect(modelMatches('gpt-5', 'gpt-4o')).toBe(false);
  });
  it('lets a Claude family alias take the full ids of that family only', () => {
    expect(modelMatches('sonnet', 'claude-sonnet-5-5')).toBe(true);
    expect(modelMatches('sonnet', 'claude-opus-5-5')).toBe(false);
    expect(modelMatches('opus', 'claude-opus-4-1')).toBe(true);
    expect(modelMatches('fable', 'claude-fable-5-1')).toBe(true);
    expect(modelMatches('gpt-5', 'gpt-5-mini')).toBe(false);
  });
  it('fills a sonnet link with its calls and usage', () => {
    const l = link({ slug: 'claude_code', model: 'sonnet' });
    const calls = [
      { slug: 'claude-code', model: 'claude-sonnet-5-5', ok: true, latencyMs: 1, startedAt: 1 },
      { slug: 'claude-code', model: 'claude-opus-5-5', ok: true, latencyMs: 1, startedAt: 2 },
    ];
    expect(callsForLink(calls, l).map((c) => c.model)).toEqual(['claude-sonnet-5-5']);
    const rows = [
      { key: 'claude-sonnet-5-5', calls: 4, fails: 0, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.5, costKind: 'reported' },
      { key: 'claude-opus-5-5', calls: 9, fails: 0, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 1, costKind: 'reported' },
    ];
    expect(usageForLink(rows, l)).toMatchObject({ calls: 4, costUsd: 0.5 });
  });
  it('keeps the newest calls of the link, at most n', () => {
    const calls = [
      { slug: 'openai', model: 'gpt-5', ok: true, latencyMs: 1, startedAt: 1 },
      { slug: 'openai', model: 'gpt-4o', ok: true, latencyMs: 1, startedAt: 3 },
      { slug: 'openai', model: 'gpt-5-mini', ok: false, latencyMs: 1, startedAt: 2 },
      { slug: 'openai', model: 'gpt-5', ok: false, latencyMs: 1, startedAt: 2.5 },
      { slug: 'openai', model: 'gpt-5', ok: true, latencyMs: 1, startedAt: 4 },
    ];
    expect(callsForLink(calls, link({ model: 'gpt-5' }), 2).map((c) => c.startedAt)).toEqual([4, 2.5]);
    expect(callsForLink(calls, link({ model: 'gpt-5' }), 8).map((c) => c.model)).not.toContain('gpt-5-mini');
    expect(callsForLink(calls, link(), 8)).toHaveLength(5);
  });
  it("sums today's usage rows of the link's model", () => {
    const rows = [
      { key: 'gpt-5', calls: 2, fails: 1, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01, costKind: 'estimated' },
      { key: 'gpt-5-mini', calls: 1, fails: 0, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.002, costKind: 'estimated' },
      { key: 'gpt-4o', calls: 9, fails: 0, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, costKind: 'none' },
    ];
    const u = usageForLink(rows, link({ model: 'gpt-5' }));
    expect(u).toEqual({ calls: 2, fails: 1, inputTokens: 100, outputTokens: 50, costUsd: 0.01, priced: true });
    expect(usageForLink(rows, link()).calls).toBe(12);
    expect(usageForLink([], link()).calls).toBe(0);
    expect(usageForLink([rows[2]], link()).priced).toBe(false);
  });
  it('names the UTC day', () => {
    expect(utcDay(Date.UTC(2026, 9, 31, 23, 59))).toBe('2026-10-31');
  });
  it('shortens tokens and dollars', () => {
    expect(fmtTokens(950)).toBe('950');
    expect(fmtTokens(12_345)).toBe('12.3k');
    expect(fmtTokens(2_500_000)).toBe('2.5M');
    expect(fmtCost(0)).toBe('$0');
    expect(fmtCost(0.0123)).toBe('$0.012');
    expect(fmtCost(4.567)).toBe('$4.57');
  });
});
