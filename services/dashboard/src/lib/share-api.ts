// Client for the file-lane owner API (/api/transfers). Files go to this Kernl
// in 8 MiB parts — the same size the kernel then uses towards the friend — so
// no single request hits nginx's body cap and a closed tab can resume.
import { apiFetchRaw, readApiError, getAuthToken } from './api.js';

export const CHUNK_SIZE = 8 * 1024 * 1024;

export interface TransferFileView { n: number; name: string; size: number; mime: string; chunks: number; have: string; ready: boolean }
export interface TransferView {
	id: string; direction: 'in' | 'out'; peer_npub: string; peer_name: string; text: string;
	state: string; error: string; total_bytes: number; done_bytes: number;
	created_at: string; updated_at: string; finished_at: string | null; files: TransferFileView[];
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
	const r = await apiFetchRaw(path, init);
	if (!r.ok) throw new Error((await readApiError(r)) ?? `HTTP ${r.status}`);
	return r.json() as Promise<T>;
}

export async function listTransfers(): Promise<TransferView[]> {
	return (await call<{ transfers: TransferView[] }>('/api/transfers')).transfers;
}

export function missingParts(haveB64: string, chunks: number): number[] {
	const bytes = haveB64 ? Uint8Array.from(atob(haveB64), (c) => c.charCodeAt(0)) : new Uint8Array();
	const out: number[] = [];
	for (let k = 0; k < chunks; k++) if (!((bytes[k >> 3] ?? 0) & (1 << (k & 7)))) out.push(k);
	return out;
}

async function partSha(buf: ArrayBuffer): Promise<string | null> {
	// crypto.subtle only exists in secure contexts (localhost, https); over
	// http://<LAN IP> the kernel still verifies the whole file on its side.
	if (!globalThis.crypto?.subtle) return null;
	const d = await crypto.subtle.digest('SHA-256', buf);
	return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function uploadParts(id: string, files: File[], plan: Array<{ n: number; chunks: number; have: string }>, onProgress?: (sent: number, total: number) => void) {
	const total = files.reduce((a, f) => a + f.size, 0);
	let sent = 0;
	for (const p of plan) {
		const file = files[p.n];
		if (!file) continue;
		const missing = new Set(missingParts(p.have, p.chunks));
		for (let k = 0; k < p.chunks; k++) {
			const start = k * CHUNK_SIZE;
			const end = Math.min(start + CHUNK_SIZE, file.size);
			if (missing.has(k)) {
				const buf = await file.slice(start, end).arrayBuffer();
				const sha = await partSha(buf);
				const qs = sha ? `?sha=${sha}` : '';
				const r = await apiFetchRaw(`/api/transfers/${id}/upload/${p.n}/${k}${qs}`, {
					method: 'PUT', body: buf, headers: { 'Content-Type': 'application/octet-stream' },
				});
				if (!r.ok) throw new Error((await readApiError(r)) ?? `HTTP ${r.status}`);
			}
			sent += end - start;
			onProgress?.(sent, total);
		}
	}
}

export async function sendToFriend(npub: string, text: string, files: File[], onProgress?: (sent: number, total: number) => void): Promise<string> {
	const res = await call<{ id: string; files: Array<{ n: number; chunks: number; have: string }> }>('/api/transfers', {
		method: 'POST',
		body: JSON.stringify({ npub, text: text || undefined, files: files.map((f) => ({ name: f.name, size: f.size, mime: f.type })) }),
	});
	await uploadParts(res.id, files, res.files, onProgress);
	return res.id;
}

/** Continue a staging send after the tab was closed: the user re-picks the same files. */
export async function resumeUpload(t: TransferView, files: File[], onProgress?: (sent: number, total: number) => void): Promise<void> {
	const byName = new Map(files.map((f) => [f.name, f]));
	const ordered = t.files.map((tf) => byName.get(tf.name)).filter((f): f is File => !!f);
	if (ordered.length !== t.files.length) throw new Error('pick the same files again to continue');
	await uploadParts(t.id, ordered, t.files, onProgress);
}

const post = (path: string, body: unknown = {}) => call<{ ok: boolean }>(path, { method: 'POST', body: JSON.stringify(body) }).then(() => undefined);
export const acceptTransfer = (id: string, always: boolean) => post(`/api/transfers/${id}/accept`, { always });
export const rejectTransfer = (id: string) => post(`/api/transfers/${id}/reject`);
export const cancelTransfer = (id: string) => post(`/api/transfers/${id}/cancel`);
export const retryTransfer = (id: string) => post(`/api/transfers/${id}/retry`);
/** For `<a download>`: it cannot send headers, so the kernel accepts the token in the query for this route (AUTH_QUERY_PATH_RE). */
export function downloadUrl(id: string, n: number): string {
	const token = getAuthToken();
	return `/api/transfers/${id}/files/${n}${token ? `?auth=${encodeURIComponent(token)}` : ''}`;
}

export interface ShareFriend { npub: string; petname: string; trust: string; last_reach: string; last_error: string; last_seen_at: string | null }

/** done_bytes seen at one poll, and the transfer speed it implies (bytes/s). */
export interface SpeedSample { at: number; done: number; bps: number }

/**
 * Speed from the change of done_bytes between two polls — no kernel API
 * involved. Parts land 8 MiB at a time, so the rate is smoothed; a transfer
 * whose counter went back (a file reset after a bad hash) starts over.
 */
export function nextSpeed(prev: SpeedSample | undefined, done: number, at: number): SpeedSample {
	if (!prev || done < prev.done) return { at, done, bps: 0 };
	const dt = (at - prev.at) / 1000;
	if (dt <= 0) return prev;
	const now = (done - prev.done) / dt;
	return { at, done, bps: prev.bps ? prev.bps * 0.5 + now * 0.5 : now };
}

export function formatBytes(n: number, locale: string): string {
	if (n < 1024) return `${n} B`;
	const units = ['KB', 'MB', 'GB'];
	let v = n / 1024;
	let u = 0;
	while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
	return `${new Intl.NumberFormat(locale, { maximumFractionDigits: v < 10 ? 1 : 0 }).format(v)} ${units[u]}`;
}
