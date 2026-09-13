/**
 * Filesystem Commander — HTTP client.
 *
 * Wraps all `/api/fs/*` endpoints. Uses plain fetch (no RPC equivalent
 * exists yet on the Rust bridge). Bearer auth from localStorage.
 */

import { isUnderHostPath } from './host-path.js';

export type FsEntryKind = 'file' | 'dir' | 'symlink' | 'special';

export interface FsEntry {
	name: string;
	kind: FsEntryKind;
	size: number;
	mtime: string;
	permissions?: string;
	target?: string;
	mime?: string;
}

export interface FsListing {
	path: string;
	entries: FsEntry[];
	parent: string | null;
}

export interface FsStat extends FsEntry {
	path: string;
	atime?: string;
	ctime?: string;
}

export interface ProviderInfo {
	id: string;
	kind: 'local' | 'sftp' | 's3' | 'webdav' | 'archive';
	label: string;
	home?: string;
	/** Every path this provider serves. Anything outside these is out of scope. */
	roots?: FsRoot[];
}

export interface FsRoot {
	path: string;
	/** Probed at the kernel: false for :ro mounts, wrong owner, or bad mode. */
	writable: boolean;
}

/**
 * True when `path` sits inside (or is) `root`. Separator- and case-aware for
 * Windows paths: a native Windows kernel reports roots like `C:\Users\me`,
 * which a "/"-prefix check never matched, so every folder read as out of scope.
 */
export function isUnder(path: string, root: string): boolean {
	return isUnderHostPath(path, root);
}

/** True when `path` sits inside any of `roots`. Empty roots means scope unknown. */
export function isInScope(path: string, roots: FsRoot[]): boolean {
	if (!roots.length) return true; // do not pretend to know better than the server
	return roots.some((r) => isUnder(path, r.path));
}

/**
 * Whether `path` can be written to.
 *
 * Unknown scope is treated as writable: refusing operations because the server
 * did not tell us anything would break older backends that report no roots.
 */
export function isWritable(path: string, roots: FsRoot[]): boolean {
	if (!roots.length) return true;
	const owning = roots.filter((r) => isUnder(path, r.path));
	if (!owning.length) return false; // out of scope entirely
	// Nested roots: the most specific one wins.
	owning.sort((a, b) => b.path.length - a.path.length);
	return owning[0].writable;
}

export interface Bookmark {
	id: string;
	label: string;
	provider_id: string;
	path: string;
	sort_order: number;
	created_at: string;
}

export interface HistoryRow {
	id: string;
	pane: 'left' | 'right';
	provider_id: string;
	path: string;
	visited_at: string;
}

export interface TabRow {
	id: string;
	pane: 'left' | 'right';
	provider_id: string;
	path: string;
	title: string;
	sort_order: number;
	created_at: string;
}

export interface OpProgress {
	id: string;
	kind: 'copy' | 'move';
	status: 'pending' | 'running' | 'done' | 'error' | 'cancelled';
	progress: number;
	bytes: number;
	totalBytes: number;
	currentFile: string | null;
	startedAt: string;
	endedAt: string | null;
	errors: string[];
	itemsTotal: number;
	itemsDone: number;
}

/**
 * Structured transport error.
 *
 * The UI must never render a raw `GET /api/fs/list?… → 400 {"error":…}` string
 * at the user: it leaks the transport, is unreadable, and offers no way out.
 * This carries the pieces separately so the pane can show a human headline, a
 * recovery action, and the raw detail folded away for debugging.
 */
export class FsApiError extends Error {
	readonly status: number;
	readonly detail: string;
	readonly url: string;
	readonly method: string;

	constructor(method: string, url: string, status: number, detail: string) {
		super(FsApiError.humanize(status, detail));
		this.name = 'FsApiError';
		this.method = method;
		this.url = url;
		this.status = status;
		this.detail = detail;
	}

	/** Best-effort plain-language headline for a failed FS call. */
	private static humanize(status: number, detail: string): string {
		let inner = detail;
		try {
			const parsed = JSON.parse(detail) as { error?: string; message?: string };
			inner = parsed.error ?? parsed.message ?? detail;
		} catch {
			// detail was not JSON — use it verbatim
		}
		if (/out of allowed scope/i.test(inner)) return 'This path is outside the allowed roots';
		if (status === 401 || status === 403) return 'Not authorised to read this location';
		if (status === 404) return 'This location no longer exists';
		if (status === 0 || status >= 500) return 'The filesystem service is unreachable';
		return inner || `Request failed (${status})`;
	}
}

function authHeaders(): Record<string, string> {
	const headers: Record<string, string> = {};
	if (typeof localStorage !== 'undefined') {
		const token = localStorage.getItem('kernel_auth_token');
		if (token) headers['Authorization'] = `Bearer ${token}`;
	}
	return headers;
}

async function jsonGet<T>(url: string): Promise<T> {
	let r: Response;
	try {
		r = await fetch(url, { headers: authHeaders() });
	} catch (err) {
		throw new FsApiError('GET', url, 0, err instanceof Error ? err.message : String(err));
	}
	if (!r.ok) throw new FsApiError('GET', url, r.status, await r.text());
	return r.json() as Promise<T>;
}

async function jsonSend<T>(url: string, method: string, body?: unknown): Promise<T> {
	let r: Response;
	try {
		r = await fetch(url, {
			method,
			headers: { 'Content-Type': 'application/json', ...authHeaders() },
			body: body === undefined ? undefined : JSON.stringify(body)
		});
	} catch (err) {
		throw new FsApiError(method, url, 0, err instanceof Error ? err.message : String(err));
	}
	if (!r.ok && r.status !== 207) {
		throw new FsApiError(method, url, r.status, await r.text());
	}
	return r.json() as Promise<T>;
}

// ── Providers ────────────────────────────────────────────────────────

export async function listProviders(): Promise<ProviderInfo[]> {
	const r = await jsonGet<{ items: ProviderInfo[] }>('/api/fs/providers');
	return r.items;
}

// ── Listing + stat ──────────────────────────────────────────────────

export async function listDir(provider: string, path: string): Promise<FsListing> {
	const u = `/api/fs/list?provider=${encodeURIComponent(provider)}&path=${encodeURIComponent(path)}`;
	return jsonGet<FsListing>(u);
}

export async function statEntry(provider: string, path: string): Promise<FsStat> {
	const u = `/api/fs/stat?provider=${encodeURIComponent(provider)}&path=${encodeURIComponent(path)}`;
	return jsonGet<FsStat>(u);
}

// ── Mutations ───────────────────────────────────────────────────────

export async function mkdir(provider: string, path: string, recursive = false): Promise<void> {
	await jsonSend('/api/fs/mkdir', 'POST', { provider, path, recursive });
}

export async function rename(provider: string, from: string, to: string): Promise<void> {
	await jsonSend('/api/fs/rename', 'POST', { provider, from, to });
}

export async function remove(
	provider: string,
	paths: string[],
	recursive = false
): Promise<{ success: boolean; deleted: number; errors: Array<{ path: string; error: string }> }> {
	return jsonSend('/api/fs/delete', 'POST', { provider, paths, recursive });
}

export async function startCopy(input: {
	src_provider: string;
	dst_provider: string;
	items: Array<{ from: string; to: string }>;
	overwrite?: boolean;
}): Promise<string> {
	const r = await jsonSend<{ op_id: string }>('/api/fs/ops/copy', 'POST', input);
	return r.op_id;
}

export async function startMove(input: {
	src_provider: string;
	dst_provider: string;
	items: Array<{ from: string; to: string }>;
	overwrite?: boolean;
}): Promise<string> {
	const r = await jsonSend<{ op_id: string }>('/api/fs/ops/move', 'POST', input);
	return r.op_id;
}

export async function cancelOp(id: string): Promise<void> {
	await jsonSend(`/api/fs/ops/${encodeURIComponent(id)}`, 'DELETE');
}

/**
 * Subscribe to SSE progress for an op. Calls `onUpdate` for each event.
 * Returns a close handle.
 */
export function streamOp(id: string, onUpdate: (p: OpProgress) => void): { close: () => void } {
	const es = new EventSource(`/api/fs/ops/${encodeURIComponent(id)}/stream`);
	es.onmessage = (ev) => {
		try {
			onUpdate(JSON.parse(ev.data) as OpProgress);
		} catch {
			// ignore malformed frame
		}
	};
	es.onerror = () => es.close();
	return { close: () => es.close() };
}

// ── Bookmarks ──────────────────────────────────────────────────────

export async function bookmarksList(): Promise<Bookmark[]> {
	const r = await jsonGet<{ items: Bookmark[] }>('/api/fs/bookmarks');
	return r.items;
}

export async function bookmarkAdd(input: {
	label: string;
	provider_id: string;
	path: string;
	sort_order?: number;
}): Promise<Bookmark> {
	const r = await jsonSend<{ item: Bookmark }>('/api/fs/bookmarks', 'POST', input);
	return r.item;
}

export async function bookmarkRemove(id: string): Promise<void> {
	await jsonSend(`/api/fs/bookmarks/${encodeURIComponent(id)}`, 'DELETE');
}

// ── Tabs ───────────────────────────────────────────────────────────

export async function tabsGet(pane: 'left' | 'right'): Promise<TabRow[]> {
	const r = await jsonGet<{ items: TabRow[] }>(`/api/fs/tabs?pane=${pane}`);
	return r.items;
}

export async function tabsSet(
	pane: 'left' | 'right',
	tabs: Array<{ provider_id: string; path: string; title?: string }>
): Promise<TabRow[]> {
	const r = await jsonSend<{ items: TabRow[] }>(`/api/fs/tabs?pane=${pane}`, 'PUT', { tabs });
	return r.items;
}

// ── History ────────────────────────────────────────────────────────

export async function historyList(pane: 'left' | 'right', limit = 100): Promise<HistoryRow[]> {
	const r = await jsonGet<{ items: HistoryRow[] }>(
		`/api/fs/history?pane=${pane}&limit=${limit}`
	);
	return r.items;
}

export async function historyPush(
	pane: 'left' | 'right',
	provider_id: string,
	path: string
): Promise<void> {
	await jsonSend('/api/fs/history', 'POST', { pane, provider_id, path });
}
