import { describe, it, expect } from 'bun:test';
import { statusLabel, fmtSince, fmtCountdown } from './llm-chain.js';

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
