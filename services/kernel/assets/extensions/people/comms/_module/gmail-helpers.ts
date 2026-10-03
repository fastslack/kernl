import type { GmailMessagePart } from "@kernl/extension-sdk";
import { sanitizeUserHtml } from "@kernl/extension-sdk/html";
import type { CommMetadata } from "./types.js";

/**
 * Extract "email@example.com" from "John Doe <email@example.com>" or plain address.
 */
export function parseEmailAddress(headerValue: string): string {
  const match = headerValue.match(/<([^>]+)>/);
  return (match ? match[1] : headerValue).trim().toLowerCase();
}

/**
 * Extract display name from "John Doe <email@example.com>". Returns empty string if no name.
 */
export function parseEmailName(headerValue: string): string {
  const match = headerValue.match(/^(.+?)\s*<[^>]+>/);
  return match ? match[1].replace(/^["']|["']$/g, "").trim() : "";
}

/**
 * Extract header value by name from Gmail headers array.
 */
export function extractHeader(
  headers: Array<{ name: string; value: string }>,
  name: string,
): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/**
 * Recursively extract text/plain and text/html body from Gmail message parts.
 * Body data from Gmail is base64url encoded.
 */
export function extractGmailBody(part: GmailMessagePart): { text: string; html: string } {
  let text = "";
  let html = "";

  if (part.body?.data) {
    const decoded = Buffer.from(part.body.data, "base64url").toString("utf-8");
    if (part.mimeType === "text/plain") text = decoded;
    if (part.mimeType === "text/html") html = decoded;
  }

  if (part.parts) {
    for (const sub of part.parts) {
      const result = extractGmailBody(sub);
      if (result.text && !text) text = result.text;
      if (result.html && !html) html = result.html;
    }
  }

  return { text, html };
}

/** Past this, a message's HTML is dropped and the view falls back to its text. */
const MAX_STORED_HTML = 512 * 1024;

/**
 * A message's HTML part as it may be stored and shown: sanitized (no scripts,
 * styles, frames or handlers) and capped — a truncated document would render
 * broken, so an oversized one is dropped whole.
 */
export function storableHtml(html: string): string {
  if (!html) return "";
  const clean = sanitizeUserHtml(html);
  return clean.length > MAX_STORED_HTML ? "" : clean;
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", copy: "©", reg: "®", trade: "™",
  euro: "€", pound: "£", yen: "¥", cent: "¢", hellip: "…", mdash: "—", ndash: "–", laquo: "«", raquo: "»",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", middot: "·", deg: "°", times: "×",
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", Aacute: "Á", Eacute: "É", Iacute: "Í",
  Oacute: "Ó", Uacute: "Ú", ntilde: "ñ", Ntilde: "Ñ", uuml: "ü", Uuml: "Ü", ouml: "ö", auml: "ä", iquest: "¿", iexcl: "¡",
  zwnj: "", zwj: "", shy: "",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[e] ?? m;
  });
}

const BLOCK_END = /<\/(p|div|tr|li|h[1-6]|table|thead|tbody|ul|ol|section|article|header|footer|blockquote|pre|center)\s*>/gi;

/**
 * Plain text from an HTML body — what an HTML-only message shows as its text.
 * Drops what is not content (head, style, script, comments: stripping only the
 * tags put the stylesheet on screen), keeps block and row boundaries as line
 * breaks, and collapses the layout whitespace HTML is full of.
 */
export function stripHtml(html: string): string {
  if (!/<[a-z!/]/i.test(html)) return decodeEntities(html).trim();
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<(head|style|script|noscript|title|template)\b[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/\s+/g, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/t[dh]\s*>/gi, " ")
      .replace(BLOCK_END, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    // Zero-width joiners, soft hyphens and the like: invisible padding that
    // newsletters put after the preview line.
    .replace(/[\u200b-\u200f\u00ad\u034f\u2060\ufeff]/g, "")
    .split("\n")
    .map((l) => l.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Format quoted text for email reply body.
 */
export function quoteBody(body: string, fromName: string, date: string): string {
  const header = `On ${date}, ${fromName} wrote:`;
  const quoted = body
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `${header}\n${quoted}`;
}

/**
 * Parse CommMetadata from the JSON metadata field.
 */
export function parseMetadata(json: string): CommMetadata {
  try {
    return JSON.parse(json) as CommMetadata;
  } catch {
    return {};
  }
}
