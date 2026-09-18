import { describe, it, expect } from 'bun:test';
import { parseEvery, checkEvery, everyFor, choiceForInterval, compactEvery, humanEvery } from './cadence.js';

describe('parseEvery', () => {
	it('reads the same grammar as the kernel', () => {
		expect(parseEvery('45m')).toBe(2_700_000);
		expect(parseEvery('6h')).toBe(21_600_000);
		expect(parseEvery('90s')).toBe(90_000);
		expect(parseEvery('1d')).toBe(86_400_000);
		expect(parseEvery('1200000')).toBe(1_200_000);
		expect(parseEvery(' 2 H ')).toBe(7_200_000);
	});

	it('returns null instead of throwing', () => {
		expect(parseEvery('abc')).toBeNull();
		expect(parseEvery('0m')).toBeNull();
		expect(parseEvery('')).toBeNull();
		expect(parseEvery('5 minutes')).toBeNull();
	});
});

describe('checkEvery', () => {
	it('enforces the default 5 minute floor', () => {
		expect(checkEvery('4m')).toBe('too_short');
		expect(checkEvery('5m')).toBe('ok');
		expect(checkEvery('nope')).toBe('invalid');
	});

	it('accepts a custom floor', () => {
		expect(checkEvery('2m', 60)).toBe('ok');
	});
});

describe('everyFor', () => {
	it('maps presets and custom values to Office Kit every strings', () => {
		expect(everyFor('manual', '')).toBeNull();
		expect(everyFor('1h', '')).toBe('1h');
		expect(everyFor('custom', ' 45m ')).toBe('45m');
		expect(everyFor('custom', '   ')).toBeNull();
	});
});

describe('choiceForInterval', () => {
	it('recognizes presets from a schedule interval', () => {
		expect(choiceForInterval(3_600_000)).toEqual({ choice: '1h', custom: '' });
		expect(choiceForInterval(86_400_000)).toEqual({ choice: '1d', custom: '' });
	});

	it('falls back to custom or manual', () => {
		expect(choiceForInterval(2_700_000)).toEqual({ choice: 'custom', custom: '45m' });
		expect(choiceForInterval(0)).toEqual({ choice: 'manual', custom: '' });
		expect(choiceForInterval(null)).toEqual({ choice: 'manual', custom: '' });
	});
});

describe('compactEvery', () => {
	it('uses the largest whole unit', () => {
		expect(compactEvery(5_400_000)).toBe('90m');
		expect(compactEvery(7_200_000)).toBe('2h');
		expect(compactEvery(172_800_000)).toBe('2d');
		expect(compactEvery(1_500)).toBe('1500ms');
	});
});

describe('humanEvery', () => {
	it('speaks Spanish', () => {
		expect(humanEvery('1h', 'es')).toBe('cada hora');
		expect(humanEvery('45m', 'es')).toBe('cada 45 minutos');
		expect(humanEvery('1d', 'es')).toBe('cada día');
		expect(humanEvery('2d', 'es')).toBe('cada 2 días');
	});

	it('speaks English', () => {
		expect(humanEvery('2h', 'en')).toBe('every 2 hours');
		expect(humanEvery('1d', 'en')).toBe('every day');
		expect(humanEvery('15m', 'en')).toBe('every 15 minutes');
	});

	it('returns the raw value when it does not parse', () => {
		expect(humanEvery('nope', 'es')).toBe('nope');
	});
});
