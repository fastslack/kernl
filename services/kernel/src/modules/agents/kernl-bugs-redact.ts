/**
 * What may leave the machine in a Kernl bug report, and how two reports are
 * recognised as the same bug.
 *
 * Redaction runs on everything the report stores, before it is stored: a
 * report is meant to be published, and a tool output is the likeliest place
 * for a secret to sit (a token echoed by a shell step, an address in a mail).
 */
import { createHash } from "node:crypto";

// Order matters: a JWT is also a long base64 run, a key can look like hex.
const PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer ‹redacted›"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "‹redacted-jwt›"],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g, "‹redacted-key›"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "‹redacted-key›"],
  // Fine-grained PATs — the kind GitHub recommends, and the kind this feature asks for.
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "‹redacted-key›"],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/g, "‹redacted-key›"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "‹redacted-key›"],
  [/\b[A-Fa-f0-9]{40,}\b/g, "‹redacted-secret›"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "‹email›"],
  [/\/home\/[^/\s"'`]+/g, "~"],
  [/\/Users\/[^/\s"'`]+/g, "~"],
];

export function redactForReport(text: string): string {
  let out = String(text ?? "");
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

/** Tools whose output is someone's message content: keep the name, drop the body. */
const PRIVATE_TOOL = /^(?:mcp__.+?__)?kernel_(?:email|gmail|mail|comms|whatsapp|telegram|slack|discord|crm|contacts)_/;
export function isPrivateTool(name: string): boolean {
  return PRIVATE_TOOL.test(String(name ?? ""));
}

/** The error with what changes between occurrences blanked out. */
export function normalizeError(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "#")
    .replace(/\d{4}-\d{2}-\d{2}t[\d:.]+z?/g, "#")
    .replace(/(['"`])[^'"`]*\1/g, "'#'")
    .replace(/\d+(\.\d+)?/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

export function bugFingerprint(area: string, error: string): string {
  return createHash("sha256").update(`${area.trim().toLowerCase()}\n${normalizeError(error)}`).digest("hex");
}
