// The configured LLM chain as /api/llm/chain reports it, and the labels the
// header's LIVE pill renders for it. Pure so the wording is testable without
// mounting the shell.

export interface ChainLink {
	slug: string; provider: string; model: string;
	status: 'active' | 'standby' | 'no-key' | 'quota' | 'rate-limit' | 'auth' | 'degraded';
	reason?: string;
	latencyMs?: number;
	blockedForMs?: number;
	resetsAt?: number;
	lastSuccessAt?: number;
	failures: number;
	/** The link's slug in /api/llm/calls and /api/llm/usage (the driver says "claude_code", the log "claude-code"). */
	logSlug?: string;
	/** Calls running on this link right now, oldest first. */
	inFlight?: InFlightCall[];
}

export interface InFlightCall { caller?: string; startedAt: number }

/** A row of GET /api/llm/calls. */
export interface LlmCall {
	slug: string; model: string; ok: boolean; latencyMs: number; startedAt: number;
	inputTokens?: number; outputTokens?: number; costUsd?: number;
	errorKind?: string; errorMsg?: string; caller?: string;
}

/** A row of GET /api/llm/usage?group=model. */
export interface UsageRow {
	key: string; calls: number; fails: number; inputTokens: number; outputTokens: number;
	cacheReadTokens: number; cacheWriteTokens: number; costUsd: number; costKind: string;
}

export interface ChainData {
	primary: ChainLink;
	fallbacks: ChainLink[];
}

export function statusLabel(s: ChainLink['status']): string {
	switch (s) {
		case 'active':     return 'ACTIVE';
		case 'standby':    return 'STANDBY';
		case 'no-key':     return 'NO KEY';
		case 'quota':      return 'NO CREDIT';
		case 'rate-limit': return 'RATE LIMITED';
		case 'auth':       return 'AUTH FAILED';
		case 'degraded':   return 'DEGRADED';
	}
}

/** "12s ago" / "4m ago" / "2h ago" since `epoch`; an em dash when never. */
export function fmtSince(epoch?: number, now = Date.now()): string {
	if (!epoch) return '—';
	const s = Math.round((now - epoch) / 1000);
	if (s < 60)   return `${s}s ago`;
	if (s < 3600) return `${Math.round(s / 60)}m ago`;
	return `${Math.round(s / 3600)}h ago`;
}

/** Remaining backoff as "30s" / "5m" / "1h"; empty when there is none. */
export function fmtCountdown(ms?: number): string {
	if (!ms || ms <= 0) return '';
	const s = Math.round(ms / 1000);
	if (s < 60)   return `${s}s`;
	if (s < 3600) return `${Math.round(s / 60)}m`;
	return `${Math.round(s / 3600)}h`;
}

/** Running time of a call, as a clock: "0:07", "1:23", "1:02:03". */
export function fmtElapsed(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
	const pad = (n: number) => String(n).padStart(2, '0');
	return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** Start of the longest-running call on the link, if any. */
export function oldestInFlight(link: ChainLink): number | undefined {
	const calls = link.inFlight ?? [];
	return calls.length ? Math.min(...calls.map((c) => c.startedAt)) : undefined;
}

export function inFlightTotal(links: ChainLink[]): number {
	return links.reduce((n, l) => n + (l.inFlight?.length ?? 0), 0);
}

/** Chain refresh period: fast only while someone watches calls run. */
export function chainPollMs(open: boolean, running: number): number {
	return open && running > 0 ? 2000 : 5000;
}

/**
 * Whether a logged model belongs to a link: the same id, or — for a link
 * naming a bare Claude family alias — a full id of that family ("sonnet" takes
 * "claude-sonnet-5-5", never "claude-opus-5-5"). Mirrors claudeModelMatches in
 * the kernel's sdk/claude-limits.ts. `gpt-5` never takes `gpt-5-mini`; a link
 * with no model takes every model of its provider.
 */
export function modelMatches(linkModel: string, model: string): boolean {
	if (!linkModel || model === linkModel) return true;
	return /^(sonnet|opus|haiku|fable)$/.test(linkModel) && (model ?? '').startsWith(`claude-${linkModel}-`);
}

/** The link's latest `n` calls, newest first. */
export function callsForLink(calls: LlmCall[], link: ChainLink, n = 8): LlmCall[] {
	return calls
		.filter((c) => modelMatches(link.model, c.model))
		.sort((a, b) => b.startedAt - a.startedAt)
		.slice(0, n);
}

export interface LinkUsage { calls: number; fails: number; inputTokens: number; outputTokens: number; costUsd: number; priced: boolean }

/** Sum of the usage rows (grouped by model) that belong to the link. */
export function usageForLink(rows: UsageRow[], link: ChainLink): LinkUsage {
	const out: LinkUsage = { calls: 0, fails: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, priced: false };
	for (const r of rows) {
		if (!modelMatches(link.model, r.key)) continue;
		out.calls += r.calls; out.fails += r.fails;
		out.inputTokens += r.inputTokens; out.outputTokens += r.outputTokens;
		out.costUsd += r.costUsd;
		if (r.costKind !== 'none') out.priced = true;
	}
	out.costUsd = Math.round(out.costUsd * 1e6) / 1e6;
	return out;
}

/** YYYY-MM-DD in UTC — the day key of the usage rollup. */
export function utcDay(epoch = Date.now()): string {
	return new Date(epoch).toISOString().slice(0, 10);
}

export function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
	return String(n);
}

export function fmtCost(usd: number): string {
	if (!usd) return '$0';
	return usd < 1 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;
}
