// Chat attachments — the shapes the kernel's /api/attachments returns.
// Mirrors the design (docs/superpowers/specs/2026-10-04-chat-attachments-design.md §1);
// keep the two in step.

export type AttachmentKind = 'image' | 'document' | 'video';
export type AttachmentStatus = 'processing' | 'ready' | 'failed';

export interface AttachmentDerived {
	width?: number;
	height?: number;
	/** pdf */
	pages?: number;
	/** documents: extracted text (≤100k chars, with a truncation marker) */
	text?: string;
	/** image: short description, when a vision model is configured */
	description?: string;
	/** video: "[mm:ss] text" lines */
	transcript?: string;
	/** video: relative frame paths, in order — fetch them by index via /frames/:n */
	frames?: string[];
	duration_s?: number;
	/** image: relative path of the resized copy actually sent to models */
	normalized?: string;
	/** non-fatal problems ("whisper not available …") */
	warnings?: string[];
}

export interface AttachmentMeta {
	id: string;
	kind: AttachmentKind;
	mime: string;
	filename: string;
	size_bytes: number;
	status: AttachmentStatus;
	error?: string | null;
	derived: AttachmentDerived;
	created_at: string;
}

/** Defaults of the kernel's caps. The server is the authority (they are
 *  configurable there); these only spare a doomed upload. */
export const ATTACHMENT_CAPS: Record<AttachmentKind, number> = {
	image: 20 * 1024 * 1024,
	document: 30 * 1024 * 1024,
	video: 100 * 1024 * 1024,
};

export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
export const MAX_VIDEO_SECONDS = 180;

/** `ChatComposer`'s `send` event detail. `attachments` holds the metas behind
 *  `attachmentIds`, same order, so a parent can draw its optimistic bubble
 *  without asking the server again. */
export interface ComposerSendDetail {
	text: string;
	attachmentIds: string[];
	attachments: AttachmentMeta[];
}
