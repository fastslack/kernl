import { describe, it, expect } from 'bun:test';
import { normalizePhone, toEpochMs, isSessionStatus, editAllowedCsv } from './whatsapp.js';

describe('normalizePhone', () => {
  it('strips formatting and keeps a valid international number', () => {
    expect(normalizePhone('+54 9 11 2345-6789')).toBe('5491123456789');
  });

  it('allows dots as formatting too', () => {
    expect(normalizePhone('(54) 911.2345.6789')).toBe('5491123456789');
  });

  it('rejects a leading zero (no country code)', () => {
    expect(normalizePhone('012345678')).toBeNull();
  });

  it('rejects a number that is too short', () => {
    expect(normalizePhone('12345')).toBeNull();
  });

  // Any character outside digits/spaces/"+ - ( ) ." rejects the whole input
  // outright, same as the kernel's normalizePhone/normalizeWhatsAppPhone.
  it('rejects a number with embedded letters instead of dropping them', () => {
    expect(normalizePhone('54911abc6789')).toBeNull();
  });
});

describe('toEpochMs', () => {
  it('converts a Unix-seconds timestamp (the bridge\'s pairing_expires_at) to milliseconds', () => {
    expect(toEpochMs(1_800_000_000)).toBe(1_800_000_000_000);
  });

  it('leaves an already-millisecond timestamp alone', () => {
    expect(toEpochMs(1_800_000_000_000)).toBe(1_800_000_000_000);
  });

  it('returns undefined for anything that is not a finite number', () => {
    expect(toEpochMs(undefined)).toBeUndefined();
    expect(toEpochMs('1800000000')).toBeUndefined();
    expect(toEpochMs(Number.NaN)).toBeUndefined();
  });
});

describe('isSessionStatus', () => {
  it('accepts the session states', () => {
    for (const state of ['idle', 'linking', 'connected', 'disconnected', 'logged_out', 'unknown']) {
      expect(isSessionStatus({ state, bridge_connected: true })).toBe(true);
    }
  });

  it('drops acks, errors and the old ready/paired events', () => {
    for (const state of ['ack', 'error', 'ready', 'paired']) {
      expect(isSessionStatus({ state })).toBe(false);
    }
    expect(isSessionStatus(null)).toBe(false);
    expect(isSessionStatus({})).toBe(false);
  });
});

describe('editAllowedCsv', () => {
  it('adds to the stored list, keeping what is already there', () => {
    expect(editAllowedCsv('5491123456789', 'add', '34600000000')).toEqual(['5491123456789', '34600000000']);
    expect(editAllowedCsv(' 5491123456789 ,', 'add', '5491123456789')).toEqual(['5491123456789']);
    expect(editAllowedCsv(undefined, 'add', '34600000000')).toEqual(['34600000000']);
  });

  it('removes only the given entry', () => {
    expect(editAllowedCsv('5491123456789,34600000000', 'remove', '34600000000')).toEqual(['5491123456789']);
    expect(editAllowedCsv('', 'remove', 'x')).toEqual([]);
  });
});
