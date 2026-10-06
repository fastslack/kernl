/**
 * What a file is, decided by its bytes.
 *
 * The browser's Content-Type and the file's name are both whatever the sender
 * says they are; only the magic bytes are checked here. The name counts for
 * exactly two things: plain-text formats have no magic (txt/md/csv/json are
 * accepted by extension, then validated as UTF-8 once the whole file is in),
 * and a .docx is a zip like any other, so the zip signature alone is not
 * enough to call it one.
 *
 * SVG is not accepted under any name: it is a document that can carry script.
 */

import type { AttachmentKind } from "./types.js";

export interface DetectedType {
  kind: AttachmentKind;
  mime: string;
  /** Extension of the stored original, without the dot. */
  ext: string;
  /** Plain text: the whole file still has to pass `isCleanUtf8`. */
  text: boolean;
}

/** Bytes needed to decide. ftyp brands and the webm doctype sit in the first few dozen. */
export const DETECT_HEAD_BYTES = 4096;

const TEXT_TYPES: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  json: "application/json",
};

/** ISO-BMFF brands that are still images or audio, not video. */
const NON_VIDEO_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1", "avif", "avis", "m4a ", "m4b ", "m4p "]);

function startsWith(buf: Buffer, bytes: number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false;
  return bytes.every((b, i) => buf[offset + i] === b);
}

function ascii(buf: Buffer, start: number, end: number): string {
  return buf.subarray(start, Math.min(end, buf.length)).toString("latin1");
}

export function extensionOf(filename: string): string {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(filename.trim());
  return m ? m[1].toLowerCase() : "";
}

/** Detect from the first bytes of the file. Null = not an accepted type. */
export function detectType(head: Buffer, filename: string): DetectedType | null {
  const ext = extensionOf(filename);

  if (startsWith(head, [0xff, 0xd8, 0xff])) return { kind: "image", mime: "image/jpeg", ext: "jpg", text: false };
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: "image", mime: "image/png", ext: "png", text: false };
  if (ascii(head, 0, 6) === "GIF87a" || ascii(head, 0, 6) === "GIF89a") return { kind: "image", mime: "image/gif", ext: "gif", text: false };
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WEBP") return { kind: "image", mime: "image/webp", ext: "webp", text: false };
  if (ascii(head, 0, 5) === "%PDF-") return { kind: "document", mime: "application/pdf", ext: "pdf", text: false };

  if (ascii(head, 4, 8) === "ftyp") {
    const brand = ascii(head, 8, 12).toLowerCase();
    if (NON_VIDEO_BRANDS.has(brand)) return null;
    if (brand === "qt  ") return { kind: "video", mime: "video/quicktime", ext: "mov", text: false };
    return { kind: "video", mime: "video/mp4", ext: "mp4", text: false };
  }
  // EBML header: Matroska and WebM share it; the doctype tells them apart.
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) {
    return ascii(head, 0, 64).includes("webm") ? { kind: "video", mime: "video/webm", ext: "webm", text: false } : null;
  }

  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) {
    return ext === "docx"
      ? { kind: "document", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: "docx", text: false }
      : null;
  }

  const textMime = TEXT_TYPES[ext];
  if (textMime && !head.includes(0)) {
    return { kind: "document", mime: textMime, ext: ext === "markdown" ? "md" : ext, text: true };
  }
  return null;
}

/** Valid UTF-8 with no NUL bytes — what a text attachment must be. */
export function isCleanUtf8(buf: Buffer): boolean {
  if (buf.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/** The original name, safe to show: no path, no control characters, bounded. */
export function displayFilename(raw: string, fallbackExt: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200);
  return clean || `adjunto.${fallbackExt}`;
}
