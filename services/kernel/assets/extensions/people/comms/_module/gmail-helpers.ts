import type { GmailMessagePart } from "../../../../../src/core/integrations/google-types.js";
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

/**
 * Strip HTML tags and decode common entities to produce plain text.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
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
