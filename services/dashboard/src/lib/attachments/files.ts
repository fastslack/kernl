// Pure helpers for attachments: classify a picked file, check it against the
// caps, and format what the chips and the strip show. No DOM, no fetch.
import { ATTACHMENT_CAPS, type AttachmentKind, type AttachmentMeta } from './types.js';

const BY_EXT: Record<string, AttachmentKind> = {
	jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image',
	pdf: 'document', docx: 'document', txt: 'document', md: 'document', csv: 'document', json: 'document',
	mp4: 'video', mov: 'video', webm: 'video',
};

const BY_MIME: Record<string, AttachmentKind> = {
	'image/jpeg': 'image', 'image/png': 'image', 'image/gif': 'image', 'image/webp': 'image',
	'application/pdf': 'document',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document',
	'text/plain': 'document', 'text/markdown': 'document', 'text/x-markdown': 'document',
	'text/csv': 'document', 'application/json': 'document',
	'video/mp4': 'video', 'video/quicktime': 'video', 'video/webm': 'video',
};

/** The `accept` attribute for the file picker: every accepted extension. */
export const ACCEPT_ATTR = Object.keys(BY_EXT).map((e) => '.' + e).join(',');

export function fileExtension(name: string): string {
	const i = name.lastIndexOf('.');
	return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

/**
 * The kind a file would be stored as, or null when the kernel would refuse it.
 *
 * The extension decides when it is a known one: browsers leave `type` empty
 * for .md and .csv, and report .csv as an Excel type on Windows. The MIME type
 * is the fallback for names without one — a pasted screenshot arrives as
 * "image.png" on some browsers and as a bare blob on others. SVG is refused
 * either way (script in an image).
 */
export function classifyFile(name: string, mime: string): AttachmentKind | null {
	const ext = fileExtension(name);
	if (ext === 'svg' || mime === 'image/svg+xml') return null;
	if (ext && BY_EXT[ext]) return BY_EXT[ext];
	if (ext) return null;
	return BY_MIME[mime.toLowerCase().split(';')[0].trim()] ?? null;
}

export type FileCheck =
	| { ok: true; kind: AttachmentKind }
	| { ok: false; reason: 'type' }
	| { ok: false; reason: 'size'; kind: AttachmentKind; cap: number }
	| { ok: false; reason: 'empty' };

export function checkFile(f: { name: string; type: string; size: number }, caps = ATTACHMENT_CAPS): FileCheck {
	const kind = classifyFile(f.name, f.type);
	if (!kind) return { ok: false, reason: 'type' };
	if (f.size === 0) return { ok: false, reason: 'empty' };
	if (f.size > caps[kind]) return { ok: false, reason: 'size', kind, cap: caps[kind] };
	return { ok: true, kind };
}

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
	const mb = n / (1024 * 1024);
	return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** 75 → "1:15". */
export function formatDuration(seconds: number): string {
	const s = Math.max(0, Math.round(seconds));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Short uppercase type label for a document chip: "PDF", "DOCX", "MD". */
export function docTypeLabel(meta: Pick<AttachmentMeta, 'filename' | 'mime'>): string {
	const ext = fileExtension(meta.filename);
	if (ext) return ext.toUpperCase();
	return (meta.mime.split('/')[1] ?? meta.mime).toUpperCase().slice(0, 5);
}

/** What the model read, for "ver lo que leyó el modelo": one block of text
 *  per kind, or null when there is nothing derived to show. */
export function derivedText(meta: Pick<AttachmentMeta, 'kind' | 'derived'>): string | null {
	const d = meta.derived ?? {};
	if (meta.kind === 'video') return d.transcript?.trim() || null;
	if (meta.kind === 'image') return d.description?.trim() || null;
	return d.text?.trim() || null;
}

export const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function attachmentUrl(id: string): string {
	return `/api/attachments/${encodeURIComponent(id)}`;
}
export function attachmentFileUrl(id: string): string {
	return `${attachmentUrl(id)}/file`;
}
/** Images: the resized, EXIF-stripped copy (falls back to the original server-side). */
export function attachmentThumbUrl(id: string): string {
	return `${attachmentFileUrl(id)}?variant=normalized`;
}
export function attachmentFrameUrl(id: string, n: number): string {
	return `${attachmentUrl(id)}/frames/${n}`;
}
export function uploadUrl(filename: string): string {
	return `/api/attachments?filename=${encodeURIComponent(filename)}`;
}
