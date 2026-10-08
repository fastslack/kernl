/**
 * "Check for new mail" on /mail: runs the IMAP Fetcher agent now instead of
 * waiting for its cron, and follows the run until it ends.
 *
 * It runs the agent rather than calling a fetch endpoint on purpose: the run
 * is what the office shows (the fetcher at its desk, the delivery truck), what
 * History records, and what the circuit breaker counts — a manual check is the
 * same work as a scheduled one and should look the same everywhere.
 */

import { apiFetchRaw } from './api.js';

/** The driver handler the comms extension registers for the IMAP Fetcher. */
export const FETCHER_HANDLER = 'comms:inbox-fetch';

/** The fetcher among the listed agents, or null when this install has none. */
export function pickFetcher(agents: unknown): string | null {
	const list = Array.isArray(agents)
		? agents
		: Array.isArray((agents as { agents?: unknown })?.agents)
			? (agents as { agents: unknown[] }).agents
			: [];
	const hit = list.find(
		(a): a is { id: string } =>
			!!a && typeof a === 'object' && (a as { builtin_handler?: unknown }).builtin_handler === FETCHER_HANDLER
	);
	return hit?.id ?? null;
}

/** A run that has not reached a final state yet. */
export function runStillGoing(status: unknown): boolean {
	return status === 'running' || status === 'pending' || status === 'queued';
}

/** How many messages the run brought in, from the fetcher's summary line; null if it did not say. */
export function newCountFrom(text: string): number | null {
	const m = /Inbox fetch\s*[—-]\s*(\d+)\s+new/i.exec(text);
	return m ? Number(m[1]) : null;
}

async function json(r: Response): Promise<any> {
	const body = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(String(body?.error ?? `HTTP ${r.status}`));
	return body;
}

export interface FetchOutcome {
	status: string;
	/** The fetcher's own summary ("x@y: 3 new"), or the error it ended with. */
	text: string;
}

/**
 * Start the fetcher and wait for it, calling `onTick` every couple of seconds
 * so the page can reload the list as mail lands. Gives up waiting (not the
 * run) after `timeoutMs`.
 */
export async function runInboxFetch(
	onTick: () => void | Promise<void>,
	opts: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<FetchOutcome> {
	const intervalMs = opts.intervalMs ?? 2500;
	const timeoutMs = opts.timeoutMs ?? 180_000;

	const agentId = pickFetcher(await json(await apiFetchRaw('/api/agents')));
	if (!agentId) throw new Error('No IMAP Fetcher agent on this Kernl.');

	const started = await json(
		await apiFetchRaw('/api/agents/run', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ agent_id: agentId })
		})
	);
	const runId = String(started?.run_id ?? '');
	if (!runId) throw new Error('The fetcher did not start.');

	const deadline = Date.now() + timeoutMs;
	for (;;) {
		await new Promise((r) => setTimeout(r, intervalMs));
		await onTick();
		const detail = await json(await apiFetchRaw(`/api/agents/runs/${encodeURIComponent(runId)}`)).catch(() => null);
		const run = detail?.run;
		if (run && !runStillGoing(run.status)) {
			return { status: String(run.status), text: String(run.error || run.result || '') };
		}
		if (Date.now() > deadline) return { status: 'running', text: '' };
	}
}
