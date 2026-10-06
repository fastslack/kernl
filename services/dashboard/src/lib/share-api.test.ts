// services/dashboard/src/lib/share-api.test.ts
import { describe, it, expect } from 'bun:test';
import { missingParts, formatBytes, nextSpeed } from './share-api.js';

describe('share-api helpers', () => {
	it('reads the parts bitmap the kernel sends', () => {
		// bits 0 and 2 set → 0b00000101 → "BQ=="
		expect(missingParts('BQ==', 4)).toEqual([1, 3]);
		expect(missingParts('', 0)).toEqual([]);
	});

	it('formats sizes for humans', () => {
		expect(formatBytes(0, 'en')).toBe('0 B');
		expect(formatBytes(240 * 1024 * 1024, 'en')).toBe('240 MB');
		expect(formatBytes(1536, 'es')).toBe('1,5 KB');
	});

	it('derives speed from done_bytes between polls', () => {
		const a = nextSpeed(undefined, 0, 0);
		expect(a.bps).toBe(0);
		const b = nextSpeed(a, 16 * 1024 * 1024, 1000);
		expect(b.bps).toBe(16 * 1024 * 1024);
		// smoothed: half the old rate, half the new one
		expect(nextSpeed(b, 16 * 1024 * 1024, 2000).bps).toBe(8 * 1024 * 1024);
		// same instant: keep the sample; counter going back: start over
		expect(nextSpeed(b, 20, 1000)).toEqual({ at: 1000, done: 20, bps: 0 });
		expect(nextSpeed(b, b.done, 1000)).toBe(b);
	});
});
