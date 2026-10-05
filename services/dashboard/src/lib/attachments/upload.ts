// The composer's pending attachments: upload each file as it is added, follow
// it through the kernel's processing, and hand the composer the ids once all
// of them are ready.
//
// Upload is a raw-body POST through XMLHttpRequest — fetch still has no upload
// progress — so the bearer token goes on by hand: the window.fetch patch
// ($lib/auth-fetch) never sees an XHR. Status polls and deletes go through
// fetch and get the token from that patch.
import { writable, type Readable } from 'svelte/store';
import { apiFetch, getAuthToken } from '../api.js';
import { checkFile, attachmentUrl, uploadUrl, type FileCheck } from './files.js';
import { MAX_ATTACHMENTS_PER_MESSAGE, type AttachmentKind, type AttachmentMeta } from './types.js';

export type PendingState = 'uploading' | 'processing' | 'ready' | 'failed';

export interface PendingAttachment {
	/** Local key — stable across retries, unlike the server id. */
	key: string;
	file: File;
	name: string;
	size: number;
	kind: AttachmentKind;
	state: PendingState;
	/** 0..1 while uploading. */
	progress: number;
	/** Server id, once the upload answered. */
	id?: string;
	meta?: AttachmentMeta;
	/** Why it failed — the server's reason when it gave one. */
	error?: string;
	/** Object URL of the local file, for an image thumb before the server has one. */
	preview?: string;
}

export interface Rejection {
	name: string;
	reason: 'type' | 'size' | 'empty' | 'count';
	cap?: number;
}

export interface UploadHandle {
	promise: Promise<AttachmentMeta>;
	abort(): void;
}

/** The three calls the controller makes. Swappable so tests need no network. */
export interface AttachmentTransport {
	upload(file: File, onProgress: (fraction: number) => void): UploadHandle;
	get(id: string): Promise<AttachmentMeta>;
	remove(id: string): Promise<void>;
}

export class UploadAborted extends Error {
	constructor() { super('aborted'); }
}

export const xhrTransport: AttachmentTransport = {
	upload(file, onProgress) {
		const xhr = new XMLHttpRequest();
		const promise = new Promise<AttachmentMeta>((resolve, reject) => {
			xhr.open('POST', uploadUrl(file.name || 'paste'));
			const token = getAuthToken();
			if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
			xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
			xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
			xhr.onload = () => {
				let body: any = null;
				try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
				if (xhr.status >= 200 && xhr.status < 300 && body?.id) resolve(body as AttachmentMeta);
				else reject(new Error(body?.error || `HTTP ${xhr.status}`));
			};
			xhr.onerror = () => reject(new Error('network'));
			xhr.onabort = () => reject(new UploadAborted());
			xhr.send(file);
		});
		return { promise, abort: () => xhr.abort() };
	},
	async get(id) {
		return (await apiFetch(attachmentUrl(id))) as AttachmentMeta;
	},
	async remove(id) {
		await apiFetch(attachmentUrl(id), { method: 'DELETE' });
	},
};

export interface UploaderOptions {
	transport?: AttachmentTransport;
	/** First poll delay; doubles up to `maxPollMs`. */
	pollMs?: number;
	maxPollMs?: number;
	max?: number;
	/** Object URLs for image previews. Off in tests (no URL.createObjectURL there). */
	previews?: boolean;
}

export interface PendingSummary {
	total: number;
	ready: number;
	/** Still uploading or processing. */
	waiting: number;
	failed: number;
	/** Something is attached and every one of them is ready. */
	allReady: boolean;
}

export function summarize(list: PendingAttachment[]): PendingSummary {
	let ready = 0, waiting = 0, failed = 0;
	for (const p of list) {
		if (p.state === 'ready') ready++;
		else if (p.state === 'failed') failed++;
		else waiting++;
	}
	return { total: list.length, ready, waiting, failed, allReady: list.length > 0 && ready === list.length };
}

export interface AttachmentUploader extends Readable<PendingAttachment[]> {
	/** Validate and start uploading. Returns what was refused, and why. */
	add(files: Iterable<File>): Rejection[];
	retry(key: string): void;
	/** Drop one: aborts its upload, stops its poll, DELETEs it on the server. */
	remove(key: string): void;
	/** Ids of the ready ones, in the order they were added. */
	readyIds(): string[];
	/** Forget everything after a send — the server now owns the ids, so no DELETE. */
	clear(): void;
	/** Cancel everything — the composer went away with attachments unsent. */
	reset(): void;
}

let seq = 0;

export function createAttachmentUploader(opts: UploaderOptions = {}): AttachmentUploader {
	const transport = opts.transport ?? xhrTransport;
	const pollMs = opts.pollMs ?? 800;
	const maxPollMs = opts.maxPollMs ?? 4000;
	const max = opts.max ?? MAX_ATTACHMENTS_PER_MESSAGE;
	const previews = opts.previews ?? (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function');

	let items: PendingAttachment[] = [];
	const store = writable<PendingAttachment[]>(items);
	const aborts = new Map<string, () => void>();
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	// Bumped on every (re)start so a late answer from an earlier attempt is ignored.
	const attempt = new Map<string, number>();

	function publish() { store.set(items); }
	function patch(key: string, change: Partial<PendingAttachment>) {
		items = items.map((p) => (p.key === key ? { ...p, ...change } : p));
		publish();
	}
	function find(key: string) { return items.find((p) => p.key === key); }

	function stop(key: string) {
		aborts.get(key)?.();
		aborts.delete(key);
		const t = timers.get(key);
		if (t) clearTimeout(t);
		timers.delete(key);
		attempt.set(key, (attempt.get(key) ?? 0) + 1);
	}

	function settle(key: string, meta: AttachmentMeta) {
		if (meta.status === 'ready') patch(key, { state: 'ready', meta, id: meta.id, progress: 1, error: undefined });
		else if (meta.status === 'failed') patch(key, { state: 'failed', meta, id: meta.id, error: meta.error || undefined });
		else patch(key, { state: 'processing', meta, id: meta.id, progress: 1 });
	}

	function poll(key: string, id: string, delay: number, run: number) {
		timers.set(key, setTimeout(async () => {
			timers.delete(key);
			try {
				const meta = await transport.get(id);
				if (attempt.get(key) !== run || !find(key)) return;
				settle(key, meta);
				if (meta.status === 'processing') poll(key, id, Math.min(delay * 2, maxPollMs), run);
			} catch (e) {
				if (attempt.get(key) !== run || !find(key)) return;
				// A blip while polling is not a verdict on the file: keep asking, slower.
				poll(key, id, maxPollMs, run);
			}
		}, delay));
	}

	function start(key: string) {
		const p = find(key);
		if (!p) return;
		const run = (attempt.get(key) ?? 0) + 1;
		attempt.set(key, run);
		patch(key, { state: 'uploading', progress: 0, error: undefined, id: undefined, meta: undefined });
		const handle = transport.upload(p.file, (f) => {
			if (attempt.get(key) === run) patch(key, { progress: f });
		});
		aborts.set(key, handle.abort);
		handle.promise.then(
			(meta) => {
				if (attempt.get(key) !== run || !find(key)) {
					// Removed mid-flight after the server already stored it.
					if (meta?.id) transport.remove(meta.id).catch(() => {});
					return;
				}
				aborts.delete(key);
				settle(key, meta);
				if (meta.status === 'processing') poll(key, meta.id, pollMs, run);
			},
			(err: unknown) => {
				if (err instanceof UploadAborted || attempt.get(key) !== run) return;
				aborts.delete(key);
				patch(key, { state: 'failed', error: err instanceof Error ? err.message : String(err) });
			},
		);
	}

	function dispose(p: PendingAttachment, deleteRemote: boolean) {
		stop(p.key);
		if (deleteRemote && p.id) transport.remove(p.id).catch(() => {});
		if (p.preview) URL.revokeObjectURL(p.preview);
	}

	return {
		subscribe: store.subscribe,

		add(files) {
			const rejected: Rejection[] = [];
			const added: string[] = [];
			for (const file of files) {
				const check: FileCheck = checkFile(file);
				if (!check.ok) {
					rejected.push({ name: file.name, reason: check.reason, cap: check.reason === 'size' ? check.cap : undefined });
					continue;
				}
				if (items.length >= max) {
					rejected.push({ name: file.name, reason: 'count' });
					continue;
				}
				const key = `att-${++seq}`;
				items = [...items, {
					key, file, name: file.name || 'paste', size: file.size, kind: check.kind,
					state: 'uploading', progress: 0,
					preview: previews && check.kind === 'image' ? URL.createObjectURL(file) : undefined,
				}];
				added.push(key);
			}
			publish();
			for (const key of added) start(key);
			return rejected;
		},

		retry(key) {
			const p = find(key);
			if (!p || p.state !== 'failed') return;
			// A failed server row is useless; drop it before trying again.
			if (p.id) transport.remove(p.id).catch(() => {});
			stop(key);
			start(key);
		},

		remove(key) {
			const p = find(key);
			if (!p) return;
			dispose(p, true);
			items = items.filter((x) => x.key !== key);
			publish();
		},

		readyIds() {
			return items.filter((p) => p.state === 'ready' && p.id).map((p) => p.id as string);
		},

		clear() {
			for (const p of items) dispose(p, false);
			items = [];
			publish();
		},

		reset() {
			for (const p of items) dispose(p, true);
			items = [];
			publish();
		},
	};
}
