/**
 * How long a question has been waiting on the operator, and the age groups the
 * chief's Questions tab shows: fresh ones first and loud, stale ones at the
 * bottom and folded.
 *
 * "Waiting since" is the last time the question landed on the operator, not
 * when the agent first asked:
 * - owed (the operator chose an option that left them work): owed_at;
 * - pending: when the chief let go of it. The kernel keeps no escalation time,
 *   but triage starts right before it escalates, so the later of created_at and
 *   triage_started_at is the closest it records.
 * Reminders (reminded_at) are not a new need: they do not make a question fresh.
 */

export interface AgedQuestion {
	id: string;
	created_at: string;
	status?: string;
	owed_at?: string | null;
	triage_started_at?: string | null;
}

export type AgeBucket = 'fresh' | 'today' | 'week' | 'stale';

/** Display order, newest group first. */
export const AGE_BUCKETS: readonly AgeBucket[] = ['fresh', 'today', 'week', 'stale'];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Under this a question is "nueva". */
export const FRESH_MS = HOUR;
/** From this on a question is "antigua": folded, at the bottom. */
export const STALE_MS = 7 * DAY;

const ms = (iso: string | null | undefined): number => {
	if (!iso) return NaN;
	return new Date(iso).getTime();
};

/** Epoch ms of the last time the question needed the operator (NaN when unknown). */
export function waitingSince(q: AgedQuestion): number {
	if (q.status === 'owed') {
		const owed = ms(q.owed_at);
		if (!isNaN(owed)) return owed;
	}
	const created = ms(q.created_at);
	const triage = ms(q.triage_started_at);
	if (isNaN(triage)) return created;
	if (isNaN(created)) return triage;
	return Math.max(created, triage);
}

/** The group for a wait that started at `since`. An unknown time counts as stale: it cannot claim to be new. */
export function ageBucket(since: number, now: number): AgeBucket {
	if (isNaN(since)) return 'stale';
	const age = Math.max(0, now - since);
	if (age < FRESH_MS) return 'fresh';
	if (age < DAY) return 'today';
	if (age < STALE_MS) return 'week';
	return 'stale';
}

export interface AgeGroup<Q extends AgedQuestion> {
	bucket: AgeBucket;
	questions: Q[];
}

/** Newest wait first; an unknown time sorts last, ties keep the id order stable. */
export function sortByWaiting<Q extends AgedQuestion>(questions: Q[]): Q[] {
	return questions
		.map((q) => ({ q, t: waitingSince(q) }))
		.sort((a, b) => {
			const at = isNaN(a.t) ? -Infinity : a.t;
			const bt = isNaN(b.t) ? -Infinity : b.t;
			return bt - at || a.q.id.localeCompare(b.q.id);
		})
		.map((x) => x.q);
}

/** The non-empty age groups, newest group first, newest question first inside each. */
export function groupByAge<Q extends AgedQuestion>(questions: Q[], now: number): AgeGroup<Q>[] {
	const by = new Map<AgeBucket, Q[]>();
	for (const q of sortByWaiting(questions)) {
		const b = ageBucket(waitingSince(q), now);
		by.set(b, [...(by.get(b) ?? []), q]);
	}
	return AGE_BUCKETS.filter((b) => by.has(b)).map((bucket) => ({ bucket, questions: by.get(bucket)! }));
}

/** A wait as a unit and a count, for an i18n string: { unit: 'min', n: 3 }. */
export function waitParts(since: number, now: number): { unit: 's' | 'min' | 'h' | 'd'; n: number } | null {
	if (isNaN(since)) return null;
	const d = Math.max(0, now - since);
	if (d < 60_000) return { unit: 's', n: Math.max(1, Math.round(d / 1000)) };
	if (d < HOUR) return { unit: 'min', n: Math.round(d / 60_000) };
	if (d < DAY) return { unit: 'h', n: Math.round(d / HOUR) };
	return { unit: 'd', n: Math.floor(d / DAY) };
}
