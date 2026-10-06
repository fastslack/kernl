/**
 * Attachments → LLM content blocks.
 *
 * The one place that decides what a model sees of an attachment. Chat and
 * agents call it with the capabilities of the model about to answer (rebuilt
 * per link of a fallback chain) and with the age of the turn the attachment
 * belongs to: the last RECENT_TURNS user turns go natively where the model
 * can take it (image / document blocks, video frames); anything older, or
 * anything the model cannot take, goes as text — extracted text, transcript,
 * description, or a one-line `[imagen …]` stand-in.
 *
 * Each attachment is preceded by a header line such as
 * `[Adjunto: informe.pdf · documento · 12 págs]`, so the model knows what it
 * is looking at even when only text survives.
 *
 * A request-wide safety cap (more than MAX_NATIVE_IMAGES native images or
 * MAX_NATIVE_BYTES of native payload, measured base64-encoded) degrades the oldest native attachments
 * to their text form first; `buildRequestAttachmentBlocks` applies it over
 * every turn of a request at once.
 */

import { readFileSync, statSync } from "node:fs";
import type { ContentBlock, ImageBlock } from "../../core/llm/chat-types.js";
import type { InputCaps } from "../../core/llm/input-caps.js";
import { getAttachmentService } from "./index.js";
import type { AttachmentRecord } from "./types.js";

/** turnAge 0 = the current user turn; 0..RECENT_TURNS-1 are "recent". */
export const RECENT_TURNS = 3;
/** Old turns carry at most this much extracted text / transcript per attachment. */
export const OLD_TEXT_LIMIT = 8_000;
export const MAX_NATIVE_IMAGES = 20;
export const MAX_NATIVE_BYTES = 30 * 1024 * 1024;

export type AttachmentCaps = Pick<InputCaps, "vision" | "pdf" | "video">;

export interface BuildOptions {
  /** Resolves a data-dir-relative path. Defaults to the live attachment service. */
  absPath?: (rel: string) => string;
}

export interface AttachmentTurn {
  records: readonly AttachmentRecord[];
  turnAge: number;
}

type ImageMediaType = ImageBlock["source"]["media_type"];
const IMAGE_TYPES = new Set<ImageMediaType>(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** A native part waiting to be read: what file, as what block. */
interface NativePart {
  kind: "image" | "document";
  rel: string;
  mediaType: ImageMediaType | "application/pdf";
  /** Encoded (base64) size — what counts against MAX_NATIVE_BYTES. */
  bytes: number;
}

/** One attachment's plan before the request-wide cap decides. */
interface Plan {
  rec: AttachmentRecord;
  turnAge: number;
  /** Order inside its turn, for "oldest first" ties. */
  index: number;
  native: NativePart[] | null;
  /** Text that goes along with the native parts (a video's transcript). */
  nativeText: string | null;
}

// ── Text forms ─────────────────────────────────────────

const KIND_LABEL: Record<AttachmentRecord["kind"], string> = { image: "imagen", document: "documento", video: "video" };

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** `[Adjunto: informe.pdf · documento · 12 págs]` */
export function attachmentHeader(rec: AttachmentRecord): string {
  const parts = [rec.filename, KIND_LABEL[rec.kind]];
  const d = rec.derived;
  if (rec.kind === "image" && d.width && d.height) parts.push(`${d.width}×${d.height}`);
  if (rec.kind === "document" && d.pages) parts.push(`${d.pages} ${d.pages === 1 ? "pág" : "págs"}`);
  if (rec.kind === "video" && d.duration_s !== undefined) parts.push(formatDuration(d.duration_s));
  return `[Adjunto: ${parts.join(" · ")}]`;
}

/** One line naming several attachments, for prompts that carry past turns as flat text. */
export function attachmentNote(recs: readonly AttachmentRecord[]): string {
  if (recs.length === 0) return "";
  return recs.map((r) => attachmentHeader(r)).join(" ");
}

function imageStandIn(rec: AttachmentRecord): string {
  const d = rec.derived;
  if (d.description) return d.description;
  return d.width && d.height ? `[imagen: ${rec.filename}, ${d.width}×${d.height}]` : `[imagen: ${rec.filename}]`;
}

function truncateOld(text: string): string {
  if (text.length <= OLD_TEXT_LIMIT) return text;
  return `${text.slice(0, OLD_TEXT_LIMIT)}\n[…recortado a ${OLD_TEXT_LIMIT} de ${text.length} caracteres; si hace falta el archivo completo, pedilo]`;
}

function isPdf(rec: AttachmentRecord): boolean {
  return rec.mime === "application/pdf";
}

/** The attachment as text only, for the given turn age. */
function textForm(rec: AttachmentRecord, turnAge: number): string {
  const old = turnAge >= RECENT_TURNS;
  const d = rec.derived;
  switch (rec.kind) {
    case "image":
      return imageStandIn(rec);
    case "document": {
      const text = d.text?.trim() ? d.text : "[el documento no tiene texto extraíble]";
      return old ? truncateOld(text) : text;
    }
    case "video": {
      const transcript = d.transcript?.trim() ? d.transcript : "";
      if (!old) return transcript ? `Transcripción:\n${transcript}` : "[el video no tiene transcripción]";
      const stand = `[video: ${d.duration_s !== undefined ? formatDuration(d.duration_s) : "?"}, ${d.frames?.length ?? 0} cuadros]`;
      return transcript ? `Transcripción:\n${truncateOld(transcript)}\n${stand}` : stand;
    }
  }
}

// ── Planning ───────────────────────────────────────────

function fileSize(abs: string): number | null {
  try {
    return statSync(abs).size;
  } catch {
    return null;
  }
}

function imageMediaType(rel: string, fallback: string): ImageMediaType | null {
  const lower = rel.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return IMAGE_TYPES.has(fallback as ImageMediaType) ? (fallback as ImageMediaType) : null;
}

function part(abs: (rel: string) => string, kind: NativePart["kind"], rel: string, mediaType: NativePart["mediaType"]): NativePart | null {
  let resolved: string;
  try {
    resolved = abs(rel);
  } catch {
    return null;
  }
  const size = fileSize(resolved);
  // What goes over the wire is base64: 4 bytes for every 3.
  return size === null ? null : { kind, rel, mediaType, bytes: Math.ceil(size / 3) * 4 };
}

function plan(rec: AttachmentRecord, turnAge: number, index: number, caps: AttachmentCaps, abs: ((rel: string) => string) | null): Plan {
  const p: Plan = { rec, turnAge, index, native: null, nativeText: null };
  if (!abs || turnAge >= RECENT_TURNS || rec.status !== "ready") return p;

  if (rec.kind === "image" && caps.vision) {
    const rel = rec.derived.normalized ?? rec.path;
    const mediaType = imageMediaType(rel, rec.mime);
    const one = mediaType ? part(abs, "image", rel, mediaType) : null;
    if (one) p.native = [one];
  } else if (rec.kind === "document" && isPdf(rec) && caps.pdf) {
    const one = part(abs, "document", rec.path, "application/pdf");
    if (one) p.native = [one];
  } else if (rec.kind === "video" && caps.vision && rec.derived.frames?.length) {
    const frames = rec.derived.frames.map((rel) => part(abs, "image", rel, "image/jpeg"));
    if (frames.every((f): f is NativePart => f !== null)) {
      p.native = frames;
      p.nativeText = rec.derived.transcript?.trim() ? `Transcripción:\n${rec.derived.transcript}` : "[el video no tiene transcripción]";
    }
  }
  return p;
}

/** Degrade the oldest native attachments until the request fits the caps. */
function applyNativeCap(plans: Plan[]): void {
  const natives = plans.filter((p) => p.native);
  const count = () => natives.reduce((n, p) => n + (p.native ? p.native.filter((x) => x.kind === "image").length : 0), 0);
  const bytes = () => natives.reduce((n, p) => n + (p.native ? p.native.reduce((b, x) => b + x.bytes, 0) : 0), 0);
  // Oldest first: higher turn age, then earlier position inside the turn.
  const order = [...natives].sort((a, b) => b.turnAge - a.turnAge || a.index - b.index);
  for (const p of order) {
    if (count() <= MAX_NATIVE_IMAGES && bytes() <= MAX_NATIVE_BYTES) break;
    p.native = null;
    p.nativeText = null;
  }
}

function materialize(p: Plan, abs: ((rel: string) => string) | null): ContentBlock[] {
  const out: ContentBlock[] = [{ type: "text", text: attachmentHeader(p.rec) }];
  if (p.native && abs) {
    const blocks: ContentBlock[] = [];
    try {
      for (const n of p.native) {
        const data = readFileSync(abs(n.rel)).toString("base64");
        if (n.kind === "document") {
          blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data } });
        } else {
          blocks.push({ type: "image", source: { type: "base64", media_type: n.mediaType as ImageMediaType, data } });
        }
      }
      out.push(...blocks);
      if (p.nativeText) out.push({ type: "text", text: p.nativeText });
      return out;
    } catch {
      // Unreadable since planning: fall through to the text form.
    }
  }
  out.push({ type: "text", text: textForm(p.rec, p.turnAge) });
  return out;
}

function defaultAbs(): ((rel: string) => string) | null {
  const svc = getAttachmentService();
  return svc ? (rel: string) => svc.absPath(rel) : null;
}

// ── Public API ─────────────────────────────────────────

/**
 * Blocks for every attachment-bearing turn of one request, with the
 * request-wide native cap applied across all of them. Returns one block list
 * per turn, in the order given.
 */
export function buildRequestAttachmentBlocks(turns: readonly AttachmentTurn[], caps: AttachmentCaps, opts: BuildOptions = {}): ContentBlock[][] {
  const abs = opts.absPath ?? defaultAbs();
  const plans = turns.map((t) => t.records.map((rec, i) => plan(rec, t.turnAge, i, caps, abs)));
  applyNativeCap(plans.flat());
  return plans.map((ps) => ps.flatMap((p) => materialize(p, abs)));
}

/** Blocks for the attachments of one turn. */
export function buildAttachmentBlocks(atts: readonly AttachmentRecord[], caps: AttachmentCaps, turnAge: number, opts: BuildOptions = {}): ContentBlock[] {
  return buildRequestAttachmentBlocks([{ records: atts, turnAge }], caps, opts)[0];
}

/** True when any block is something only a multimodal model can read. */
export function hasNativeBlocks(blocks: readonly ContentBlock[]): boolean {
  return blocks.some((b) => b.type === "image" || b.type === "document");
}

/**
 * Does this provider error look like a refusal of a native block (size,
 * format, a model without vision)? Callers that sent native blocks retry once
 * with every attachment in text form when it does. Quota, rate-limit, server
 * and network errors are not it — those belong to the fallback chain.
 */
export function looksLikeNativeBlockRejection(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (/\b(429|402|5\d\d)\b|timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|fetch failed|quota|credit balance/i.test(msg)) return false;
  return /\b(400|413|415|422)\b/.test(msg) ||
    /image|document|pdf|media.?type|base64|too large|payload|vision|multimodal|content type|unsupported/i.test(msg);
}

/** The text of a block list (text blocks only), joined by newlines. */
export function blocksText(blocks: readonly ContentBlock[]): string {
  return blocks.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join("\n");
}

/**
 * The same messages with every image / document block swapped for a short
 * note — for state that is persisted (run checkpoints) and must not carry
 * megabytes of base64. Whoever resumes rebuilds the attachments from their ids.
 */
export function withoutNativeBlocks<M extends { content: string | ContentBlock[] }>(messages: readonly M[]): M[] {
  return messages.map((m) => {
    if (typeof m.content === "string" || !hasNativeBlocks(m.content)) return m;
    const content = m.content.map((b): ContentBlock =>
      b.type === "image" || b.type === "document" ? { type: "text", text: `[${b.type === "image" ? "imagen" : "pdf"} adjunto omitido]` } : b);
    return { ...m, content };
  });
}
