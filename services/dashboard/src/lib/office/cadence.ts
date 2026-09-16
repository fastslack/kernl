/**
 * "Ritmo del jefe": how often an office's lead runs on its own.
 * The selector offers presets in plain words; Office Kit and the scheduler
 * speak `every` strings ("45m") and milliseconds.
 */
export type CadencePreset = 'manual' | '15m' | '1h' | '1d';
export type CadenceChoice = CadencePreset | 'custom';

export const CADENCE_PRESETS: readonly CadencePreset[] = ['manual', '15m', '1h', '1d'];

const UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
type Unit = keyof typeof UNIT_MS;

/** Same grammar as parseEvery in the kernel's office-kit, without throwing. */
export function parseEvery(every: string): number | null {
	const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?\s*$/i.exec(every);
	if (!m) return null;
	const unit = (m[2] ?? 'ms').toLowerCase() as Unit;
	const ms = Math.round(parseFloat(m[1]) * UNIT_MS[unit]);
	return ms > 0 ? ms : null;
}

export type EveryCheck = 'ok' | 'invalid' | 'too_short';

/** The kernel clamps schedules to KERNEL_AGENT_MIN_SCHEDULE_SECONDS (300 by default). */
export function checkEvery(every: string, minSeconds = 300): EveryCheck {
	const ms = parseEvery(every);
	if (ms === null) return 'invalid';
	return ms < minSeconds * 1_000 ? 'too_short' : 'ok';
}

/** The `cron.every` value Office Kit expects; null means the lead only runs when called. */
export function everyFor(choice: CadenceChoice, custom: string): string | null {
	if (choice === 'manual') return null;
	if (choice === 'custom') return custom.trim() || null;
	return choice;
}

export function compactEvery(ms: number): string {
	if (ms % UNIT_MS.d === 0) return `${ms / UNIT_MS.d}d`;
	if (ms % UNIT_MS.h === 0) return `${ms / UNIT_MS.h}h`;
	if (ms % UNIT_MS.m === 0) return `${ms / UNIT_MS.m}m`;
	if (ms % UNIT_MS.s === 0) return `${ms / UNIT_MS.s}s`;
	return `${ms}ms`;
}

/** What the selector shows for a schedule interval (agent_schedules.interval_ms). */
export function choiceForInterval(ms: number | null | undefined): { choice: CadenceChoice; custom: string } {
	if (!ms || ms <= 0) return { choice: 'manual', custom: '' };
	for (const preset of ['15m', '1h', '1d'] as const) {
		if (parseEvery(preset) === ms) return { choice: preset, custom: '' };
	}
	return { choice: 'custom', custom: compactEvery(ms) };
}

const WORDS = {
	es: { d: ['cada día', 'días'], h: ['cada hora', 'horas'], m: ['cada minuto', 'minutos'], s: ['cada segundo', 'segundos'], each: 'cada' },
	en: { d: ['every day', 'days'], h: ['every hour', 'hours'], m: ['every minute', 'minutes'], s: ['every second', 'seconds'], each: 'every' },
} as const;

/** "cada hora", "every 45 minutes". Returns the input untouched when it does not parse. */
export function humanEvery(every: string, language: 'es' | 'en'): string {
	const ms = parseEvery(every);
	if (ms === null) return every;
	const words = WORDS[language];
	const unit: 'd' | 'h' | 'm' | 's' =
		ms % UNIT_MS.d === 0 ? 'd' : ms % UNIT_MS.h === 0 ? 'h' : ms % UNIT_MS.m === 0 ? 'm' : 's';
	const n = unit === 's' ? Math.max(1, Math.round(ms / UNIT_MS.s)) : ms / UNIT_MS[unit];
	return n === 1 ? words[unit][0] : `${words.each} ${n} ${words[unit][1]}`;
}
