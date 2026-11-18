import { describe, it, expect } from 'bun:test';
import { ageBucket, groupByAge, sortByWaiting, waitingSince, waitParts } from './question-age.js';

const NOW = Date.parse('2026-11-14T12:00:00Z');
const ago = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;

describe('waitingSince', () => {
	it('an owed question waits from when the operator took it on', () => {
		expect(waitingSince({ id: 'a', status: 'owed', created_at: ago(20 * D), owed_at: ago(2 * H) })).toBe(NOW - 2 * H);
	});

	it('a pending question waits from the later of asking and the chief triaging it', () => {
		expect(waitingSince({ id: 'a', status: 'pending', created_at: ago(3 * D), triage_started_at: ago(5 * MIN) })).toBe(NOW - 5 * MIN);
		expect(waitingSince({ id: 'a', status: 'pending', created_at: ago(5 * MIN), triage_started_at: null })).toBe(NOW - 5 * MIN);
	});

	it('owed without owed_at falls back to when it was asked', () => {
		expect(waitingSince({ id: 'a', status: 'owed', created_at: ago(D), owed_at: null })).toBe(NOW - D);
	});
});

describe('ageBucket', () => {
	it('splits at one hour, one day and one week', () => {
		expect(ageBucket(NOW - 9_000, NOW)).toBe('fresh');
		expect(ageBucket(NOW - 59 * MIN, NOW)).toBe('fresh');
		expect(ageBucket(NOW - H, NOW)).toBe('today');
		expect(ageBucket(NOW - 23 * H, NOW)).toBe('today');
		expect(ageBucket(NOW - D, NOW)).toBe('week');
		expect(ageBucket(NOW - 6 * D, NOW)).toBe('week');
		expect(ageBucket(NOW - 7 * D, NOW)).toBe('stale');
	});

	it('an unknown time is stale, and a time in the future is fresh', () => {
		expect(ageBucket(NaN, NOW)).toBe('stale');
		expect(ageBucket(NOW + H, NOW)).toBe('fresh');
	});
});

describe('groupByAge', () => {
	it('puts a 19-day-old owed question below a 9-second-old pending one', () => {
		const old = { id: 'old', status: 'owed', created_at: ago(19 * D), owed_at: ago(19 * D) };
		const fresh = { id: 'new', status: 'pending', created_at: ago(9_000) };
		const g = groupByAge([old, fresh], NOW);
		expect(g.map((x) => [x.bucket, x.questions.map((q) => q.id)])).toEqual([
			['fresh', ['new']],
			['stale', ['old']],
		]);
	});

	it('orders groups newest first, newest first inside each, and skips empty groups', () => {
		const qs = [
			{ id: 'w2', created_at: ago(2 * D) },
			{ id: 'f1', created_at: ago(30 * MIN) },
			{ id: 's1', created_at: ago(30 * D) },
			{ id: 'f2', created_at: ago(1 * MIN) },
			{ id: 'w1', created_at: ago(5 * D) },
			{ id: 's2', created_at: ago(8 * D) },
		];
		const g = groupByAge(qs, NOW);
		expect(g.map((x) => [x.bucket, x.questions.map((q) => q.id)])).toEqual([
			['fresh', ['f2', 'f1']],
			['week', ['w2', 'w1']],
			['stale', ['s2', 's1']],
		]);
	});

	it('an owed question re-taken today sits with today, not with when it was asked', () => {
		const g = groupByAge([{ id: 'o', status: 'owed', created_at: ago(10 * D), owed_at: ago(3 * H) }], NOW);
		expect(g[0].bucket).toBe('today');
	});
});

describe('sortByWaiting', () => {
	it('sends unparseable times last and keeps ties stable by id', () => {
		const out = sortByWaiting([
			{ id: 'x', created_at: 'garbage' },
			{ id: 'b', created_at: ago(H) },
			{ id: 'a', created_at: ago(H) },
		]);
		expect(out.map((q) => q.id)).toEqual(['a', 'b', 'x']);
	});
});

describe('waitParts', () => {
	it('picks the largest whole unit', () => {
		expect(waitParts(NOW - 9_000, NOW)).toEqual({ unit: 's', n: 9 });
		expect(waitParts(NOW - 3 * MIN, NOW)).toEqual({ unit: 'min', n: 3 });
		expect(waitParts(NOW - 5 * H, NOW)).toEqual({ unit: 'h', n: 5 });
		expect(waitParts(NOW - 19 * D - 5 * H, NOW)).toEqual({ unit: 'd', n: 19 });
		expect(waitParts(NaN, NOW)).toBeNull();
	});
});
