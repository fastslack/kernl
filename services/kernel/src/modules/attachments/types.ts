/**
 * Chat attachments — the shapes shared by the store, the processing queue,
 * the HTTP routes and whoever turns attachments into LLM content.
 */

export type AttachmentKind = "image" | "document" | "video";
export type AttachmentStatus = "processing" | "ready" | "failed";

/** What processing learned about a file. Every field is optional: a missing
 *  tool or an unreadable part leaves its field out and adds a warning. */
export interface AttachmentDerived {
  /** image / video */
  width?: number;
  height?: number;
  /** pdf */
  pages?: number;
  /** documents: extracted text, ≤100k chars, with a truncation marker when cut */
  text?: string;
  /** image: short description from the vision model in `attachments.describe_model` */
  description?: string;
  /** video: "[mm:ss] text" lines */
  transcript?: string;
  /** video: paths relative to the data dir, `attachments/<id>/frame-NN.jpg` */
  frames?: string[];
  /** video */
  duration_s?: number;
  /** image: path relative to the data dir of the resized, metadata-free copy sent to models */
  normalized?: string;
  /** non-fatal problems ("whisper no está disponible…") */
  warnings?: string[];
}

/** What the API returns. */
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

/** The full row. `path` is relative to the data dir; resolve it with
 *  `AttachmentService.absPath()`, never by joining it yourself. */
export interface AttachmentRecord extends AttachmentMeta {
  path: string;
  error: string | null;
  bound_at: string | null;
}
