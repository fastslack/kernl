// Getting attachment bytes and metadata into the page.
//
// An `<img src>` or `<video src>` cannot carry the bearer token, and the
// kernel only honours `?auth=` on a short allow-list of media routes — which
// is why `/api/chat/images` thumbs break as soon as a token is set. So media
// is fetched (the window.fetch patch adds the token) and shown from a blob:
// URL instead. Thumbs and frames are shared and revoked when the last strip
// or viewer holding them lets go; an original is loaded only when the viewer opens it, and released
// when it closes.
import { apiFetch } from '../api.js';
import { attachmentUrl } from './files.js';
import type { AttachmentMeta } from './types.js';

const blobs = new Map<string, Promise<string>>();
/** Holders per cached URL: the same thumb can sit in two strips at once
 *  (the optimistic bubble and the reloaded history). */
const refs = new Map<string, number>();

/** A fresh, uncached blob: URL — the caller revokes it. */
export async function fetchBlobUrl(url: string): Promise<string> {
	const r = await fetch(url);
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	return URL.createObjectURL(await r.blob());
}

/**
 * A blob: URL for a kernel media path, shared between callers. Each call is
 * one hold; the blob is revoked when every holder has called `releaseMedia`.
 */
export function mediaUrl(url: string): Promise<string> {
	let p = blobs.get(url);
	if (!p) {
		p = fetchBlobUrl(url);
		blobs.set(url, p);
		// A failure must not stick: the next caller tries again.
		p.catch(() => { blobs.delete(url); refs.delete(url); });
	}
	refs.set(url, (refs.get(url) ?? 0) + 1);
	return p;
}

export function releaseMedia(url: string): void {
	const n = (refs.get(url) ?? 0) - 1;
	if (n > 0) { refs.set(url, n); return; }
	refs.delete(url);
	const p = blobs.get(url);
	if (!p) return;
	blobs.delete(url);
	p.then((u) => URL.revokeObjectURL(u), () => {});
}

const metas = new Map<string, Promise<AttachmentMeta>>();

/**
 * One attachment's metadata. Ready and failed answers are final and cached;
 * a `processing` one is not, so a later call asks again.
 */
export function loadAttachmentMeta(id: string): Promise<AttachmentMeta> {
	let p = metas.get(id);
	if (!p) {
		p = apiFetch(attachmentUrl(id)) as Promise<AttachmentMeta>;
		metas.set(id, p);
		p.then((m) => { if (m.status === 'processing') metas.delete(id); }, () => metas.delete(id));
	}
	return p;
}

/** Seed the cache with metas the caller already holds (the composer's, after a send). */
export function rememberAttachmentMeta(meta: AttachmentMeta): void {
	if (meta.status !== 'processing') metas.set(meta.id, Promise.resolve(meta));
}
