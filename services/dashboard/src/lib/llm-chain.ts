// The configured LLM chain as /api/llm/chain reports it, and the labels the
// header's LIVE pill renders for it. Pure so the wording is testable without
// mounting the shell.

export interface ChainLink {
	slug: string; provider: string; model: string;
	status: 'active' | 'standby' | 'no-key' | 'quota' | 'rate-limit' | 'auth' | 'degraded';
	reason?: string;
	latencyMs?: number;
	blockedForMs?: number;
	lastSuccessAt?: number;
	failures: number;
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
