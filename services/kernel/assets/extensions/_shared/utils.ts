// Utility functions mirroring app.html helpers

export function fmtTime(iso: string | undefined | null): string {
	if (!iso) return '?';
	try {
		return new Date(iso).toLocaleString(undefined, {
			month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
		});
	} catch {
		return iso;
	}
}

export function fmtDate(iso: string | undefined | null): string {
	if (!iso) return '?';
	try {
		return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
	} catch {
		return iso;
	}
}

export function fmtMins(mins: number | undefined | null): string {
	if (!mins) return '0m';
	if (mins < 60) return mins + 'm';
	return Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm';
}

export function fmtMs(ms: number | undefined | null): string {
	if (!ms) return '—';
	if (ms < 1000) return ms + 'ms';
	if (ms < 60000) return (ms / 1000) + 's';
	return Math.round(ms / 60000) + 'm';
}

export function fmtTimeShort(iso: string | undefined | null): string {
	if (!iso) return '—';
	try {
		return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
	} catch {
		return iso;
	}
}

export function timeAgo(iso: string | undefined | null): string {
	if (!iso) return '?';
	try {
		const diff = Date.now() - new Date(iso).getTime();
		const secs = Math.floor(diff / 1000);
		if (secs < 60) return 'just now';
		const mins = Math.floor(secs / 60);
		if (mins < 60) return mins + 'm ago';
		const hours = Math.floor(mins / 60);
		if (hours < 24) return hours + 'h ago';
		const days = Math.floor(hours / 24);
		return days + 'd ago';
	} catch {
		return '?';
	}
}

export function formatCents(cents: number | undefined | null, currency = 'EUR'): string {
	if (cents == null) return '—';
	return new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: 0 }).format(cents / 100);
}

export function formatFileSize(bytes: number | undefined | null): string {
	if (!bytes || bytes === 0) return '0 B';
	if (bytes < 1024) return bytes + ' B';
	if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
	return (bytes / 1048576).toFixed(1) + ' MB';
}

export function weatherEmoji(code: number): string {
	if (code === 0) return '☀️';
	if (code <= 3) return '⛅';
	if (code <= 48) return '🌫️';
	if (code <= 57) return '🌧️';
	if (code <= 67) return '🌧️';
	if (code <= 77) return '❄️';
	if (code <= 82) return '🌧️';
	if (code <= 86) return '🌨️';
	if (code <= 99) return '⚡';
	return '☁️';
}

export function aqLabel(v: number): { t: string; c: string } {
	if (v <= 20) return { t: 'Good', c: 'var(--green)' };
	if (v <= 40) return { t: 'Fair', c: 'var(--teal)' };
	if (v <= 60) return { t: 'Moderate', c: 'var(--gold)' };
	if (v <= 80) return { t: 'Poor', c: 'var(--orange)' };
	return { t: 'Hazardous', c: 'var(--red)' };
}

export function uvLabel(v: number): { t: string; c: string } {
	if (v <= 2) return { t: 'Low', c: 'var(--green)' };
	if (v <= 5) return { t: 'Moderate', c: 'var(--gold)' };
	if (v <= 7) return { t: 'High', c: 'var(--orange)' };
	if (v <= 10) return { t: 'Very High', c: 'var(--red)' };
	return { t: 'Extreme', c: 'var(--red)' };
}

export function freqLabel(ms: number | undefined | null): string {
	if (!ms) return 'daily';
	if (ms < 300000) return 'real-time';
	if (ms <= 3600000) return 'hourly';
	if (ms <= 21600000) return '6h';
	if (ms <= 43200000) return '12h';
	if (ms <= 86400000) return 'daily';
	return 'weekly';
}

export function freqDisplay(k: string): string {
	const MAP: Record<string, string> = {
		'real-time': '⚡ RT',
		'hourly': '1h',
		'6h': '6h',
		'12h': '12h',
		'daily': '24h',
		'weekly': '7d'
	};
	return MAP[k] || k;
}

export function greeting(): string {
	const h = new Date().getHours();
	if (h < 12) return 'Good morning';
	if (h < 18) return 'Good afternoon';
	return 'Good evening';
}

export function capitalize(s: string): string {
	if (!s) return '';
	return s.charAt(0).toUpperCase() + s.slice(1);
}
