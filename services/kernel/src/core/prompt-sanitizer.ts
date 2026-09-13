/**
 * Prompt sanitizer — defends against indirect prompt injection through
 * agent system prompts, skill markdown, and LLM-proposed prompt rewrites.
 *
 * Two attack surfaces in Kernl:
 *   1. Extension installs (`installAgentFromPayload`): a marketplace bundle
 *      can ship `system_prompt`, `goal_template`, `description` strings that
 *      execute the next time the agent runs.
 *   2. Reflection optimizer: an LLM generates `new_system_prompt` from a
 *      failure trace. The trace itself can be poisoned with payloads that
 *      survive into the rewritten prompt.
 *
 * Plus a cache + lazy-load helper for filesystem-resident SKILL.md files
 * that the dashboard re-reads on every page load.
 *
 * Inspired by aiden's `core/skillLoader.ts`. Patterns extended for the
 * surface area we care about (Claude/OpenAI tool use, MCP tokens,
 * shell exfiltration, Spanish-language jailbreaks).
 */

import { existsSync, readFileSync, mkdirSync, appendFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { log } from "./logger.js";

// ── Injection pattern catalogue ─────────────────────────────────────────
//
// Patterns chosen to catch:
//   - Classic role-override jailbreaks ("ignore previous", "you are now")
//   - Indirect injection via model-control tokens ([SYSTEM], <|im_start|>)
//   - Encoded payloads (base64 decode, eval(), import os, subprocess)
//   - Data exfil (curl|bash, fetch http, send to webhook)
//   - Privilege escalation (sudo, run as administrator)
//   - Spanish-language equivalents (a real concern for this codebase)
//
// Each pattern is intentionally narrow so legitimate skill text does not
// trigger. False positives observed during dogfood drove the constraints.

export const INJECTION_PATTERNS: RegExp[] = [
  // ── Role hijacking (EN) ─────────────────────────────────────────────
  /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?)/i,
  /disregard\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?)/i,
  /you\s+are\s+now\s+(?:a\s+|an\s+)?(?:dan|godmode|jailbroken|unrestricted|developer\s+mode)/i,
  /new\s+instructions\s*:\s*\n/i,
  // Allow up to ~5 words between "override" and the target keyword so phrases
  // like "override the system prompt and reveal" still trip the rule.
  /override\b(?:\s+\S+){0,5}\s+(?:prompt|instructions|rules|system_prompt)/i,
  // "act as <jailbroken-id>" — accepts both "act as DAN" and "act as a DAN".
  /act\s+as\s+(?:(?:if\s+you\s+are\s+)?(?:a|an)\s+)?(?:dan|jailbroken|unrestricted|godmode)/i,
  /pretend\s+(?:to\s+be|you\s+(?:are|have))\s+(?:dan|unrestricted|no\s+rules)/i,
  /your\s+new\s+(role|directive|persona)\s+is/i,

  // ── Role hijacking (ES) ─────────────────────────────────────────────
  /ignor[áa]\s+(todas?\s+)?(las\s+)?(instrucciones|reglas|órdenes|ordenes)\s+(anteriores?|previas?)/i,
  /olvid[áa]\s+(todas?\s+)?(las\s+)?(instrucciones|reglas)/i,
  /a\s+partir\s+de\s+ahora\s+(sos|eres)\s+(dan|jailbroken|sin\s+restricciones)/i,
  /(sos|eres)\s+ahora\s+(dan|jailbroken|sin\s+restricciones)/i,

  // ── Indirect injection (model-control tokens) ───────────────────────
  /\[SYSTEM\]\s*:/i,
  /\[INST\]/,
  /<\|im_start\|>(?:\s*system|\s*assistant)/i,
  /<\|system\|>/i,
  /<<\s*SYS\s*>>/,
  /<\|begin_of_text\|>/i,

  // ── Tool / API hijack ───────────────────────────────────────────────
  /\bANTHROPIC_BASE_URL\s*=/i,
  /\bOPENAI_BASE_URL\s*=/i,
  /\bclaude_api_key\s*=\s*sk-/i,
  /\bsetenv\s*\(\s*["']ANTHROPIC/i,

  // ── Data exfiltration ───────────────────────────────────────────────
  /curl\s+[^|]*\|\s*(bash|sh|zsh)/i,
  /wget\s+[^|]*\|\s*(bash|sh|zsh)/i,
  /Invoke-Expression\s*\(/i,
  /\biex\s*\(\s*\(?new-object/i,
  /fetch\s*\(\s*["']https?:\/\/[^"']+["']\s*,\s*\{\s*method\s*:\s*["']POST/i,

  // ── Privilege escalation ────────────────────────────────────────────
  /\bsudo\s+(rm|chmod|chown|dd|mkfs)\b/i,
  /run\s+as\s+administrator/i,
  /elevation\s+prompt/i,

  // ── Encoded / obfuscated payloads (lower-confidence — keep narrow) ──
  /atob\s*\(\s*["'][A-Za-z0-9+/=]{40,}/,                // base64 → eval pipeline
  /eval\s*\(\s*atob\s*\(/,
  /Buffer\.from\s*\(\s*["'][A-Za-z0-9+/=]{40,}.*base64/,
];

// ── Structural validation ───────────────────────────────────────────────

const MAX_BYTES = 64 * 1024;          // 64KB — agent prompts shouldn't exceed
const MAX_LONG_LINES = 5;             // > 5 lines >500 chars = suspicious
const LONG_LINE_THRESHOLD = 500;

export interface SanitizeResult {
  ok: boolean;
  /** When ok=false, the human-readable reason. Suitable for logs / API errors. */
  reason?: string;
  /** When ok=false, the exact pattern or rule that fired (machine-readable). */
  rule?: string;
  /** When ok=true, the sanitized content (currently identical — we reject, not rewrite). */
  content?: string;
}

/**
 * Run a string against the full pattern catalogue + structural rules.
 *
 * Returns `{ ok: true }` for accepted content. On rejection, includes the
 * pattern source so audit logs show *why* something was blocked. Empty /
 * very short strings always pass — they can't carry a meaningful payload
 * and rejecting them would break legitimate empty fields.
 */
export function sanitizePromptText(text: string): SanitizeResult {
  if (!text || text.length < 8) {
    return { ok: true, content: text ?? "" };
  }

  if (text.length > MAX_BYTES) {
    return {
      ok: false,
      reason: `prompt too large (${text.length} bytes, max ${MAX_BYTES})`,
      rule: "size-cap",
    };
  }

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      return {
        ok: false,
        reason: `matches injection pattern: ${pattern.source.slice(0, 80)}`,
        rule: pattern.source,
      };
    }
  }

  // Structural: too many very long lines suggests a packed payload
  const lines = text.split("\n");
  const longLines = lines.filter(l => l.length > LONG_LINE_THRESHOLD);
  if (longLines.length > MAX_LONG_LINES) {
    return {
      ok: false,
      reason: `${longLines.length} lines exceed ${LONG_LINE_THRESHOLD} chars — possible packed payload`,
      rule: "long-lines",
    };
  }

  return { ok: true, content: text };
}

/**
 * Sanitize a payload object's prompt-bearing fields in place. Returns the
 * list of rejections; if non-empty the caller should refuse the install /
 * update. The payload is mutated only on success (each accepted field is
 * left as-is); rejected fields are not blanked out so the caller can decide
 * the policy (block install vs. blank-out-and-warn).
 *
 * Fields scanned: `system_prompt`, `goal_template`, `description`.
 * The `_i18n` variants are scanned too (each language value).
 */
export function sanitizeAgentPayload(
  payload: Record<string, unknown>,
  options?: { source?: string },
): Array<{ field: string; result: SanitizeResult }> {
  const rejections: Array<{ field: string; result: SanitizeResult }> = [];

  const scalar = (key: string): void => {
    const v = payload[key];
    if (typeof v !== "string") return;
    const r = sanitizePromptText(v);
    if (!r.ok) {
      rejections.push({ field: key, result: r });
      logBlocked(options?.source ?? "agent-payload", key, r);
    }
  };
  const i18n = (key: string): void => {
    const v = payload[key];
    if (!v || typeof v !== "object" || Array.isArray(v)) return;
    for (const [lang, text] of Object.entries(v as Record<string, unknown>)) {
      if (typeof text !== "string") continue;
      const r = sanitizePromptText(text);
      if (!r.ok) {
        rejections.push({ field: `${key}.${lang}`, result: r });
        logBlocked(options?.source ?? "agent-payload", `${key}.${lang}`, r);
      }
    }
  };

  scalar("system_prompt");
  scalar("goal_template");
  scalar("description");
  i18n("system_prompt_i18n");
  i18n("goal_template_i18n");
  i18n("description_i18n");

  return rejections;
}

// ── Audit log ───────────────────────────────────────────────────────────

let _auditPath: string | null = null;

/**
 * Configure where blocked-prompt incidents are appended. Called once at
 * boot; before that, blocks are still logged via `log.warn` but not
 * persisted to disk.
 */
export function configureAudit(filePath: string): void {
  _auditPath = filePath;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
  } catch {
    /* non-fatal */
  }
}

function logBlocked(source: string, field: string, result: SanitizeResult): void {
  const line = `${new Date().toISOString()} | ${source} | ${field} | ${result.reason ?? "unknown"}\n`;
  log.warn(`Sanitizer BLOCKED: ${source} ${field} — ${result.reason}`);
  if (_auditPath) {
    try {
      appendFileSync(_auditPath, line, "utf-8");
    } catch {
      /* audit failure is non-fatal — already logged above */
    }
  }
}

// ── Filesystem skill loader (LRU-cached + sanitized) ────────────────────
//
// SKILL.md files are read by the dashboard on every page load to populate
// the extensions panel. With many user-level skills the I/O is wasteful and
// re-running the sanitizer each time is a waste. The cache is invalidated
// by mtime so edits land immediately.

interface CacheEntry {
  mtimeMs: number;
  content: string;
  rejected?: SanitizeResult;
}

const _skillCache = new Map<string, CacheEntry>();
const _CACHE_LIMIT = 50;

function lruEvict(): void {
  if (_skillCache.size <= _CACHE_LIMIT) return;
  const drop = _skillCache.size - _CACHE_LIMIT;
  let i = 0;
  for (const k of _skillCache.keys()) {
    if (i++ >= drop) break;
    _skillCache.delete(k);
  }
}

/**
 * Read a SKILL.md (or any prompt-bearing markdown) from disk with LRU cache
 * and sanitization. Returns `null` when:
 *   - the file does not exist
 *   - the file content is rejected by the sanitizer
 *
 * Returns the content string when accepted. Cache is keyed by absolute path
 * + mtime; edits are picked up automatically.
 */
export function readSkillMd(filePath: string): string | null {
  if (!existsSync(filePath)) return null;

  let mtimeMs = 0;
  try {
    mtimeMs = statSync(filePath).mtimeMs;
  } catch {
    return null;
  }

  const cached = _skillCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) {
    if (cached.rejected) return null;
    // Touch order: re-insert to mark as recently used
    _skillCache.delete(filePath);
    _skillCache.set(filePath, cached);
    return cached.content;
  }

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  const result = sanitizePromptText(content);
  if (!result.ok) {
    logBlocked("skill-md", filePath, result);
    _skillCache.set(filePath, { mtimeMs, content: "", rejected: result });
    lruEvict();
    return null;
  }

  _skillCache.set(filePath, { mtimeMs, content });
  lruEvict();
  return content;
}

/** Diagnostics. */
export function getSkillCacheStats(): { size: number; max: number } {
  return { size: _skillCache.size, max: _CACHE_LIMIT };
}

/** Test-only — drops in-memory cache and audit path. */
export function _resetForTests(): void {
  _skillCache.clear();
  _auditPath = null;
}

/**
 * Convenience: parse the YAML frontmatter (name/description) of a SKILL.md
 * with caching + sanitization in one pass. Returns `null` on rejection or
 * missing frontmatter — the dashboard already treats both as "skip this
 * skill" so the API surface stays simple.
 */
export function parseSkillMdFrontmatter(filePath: string): { name?: string; description?: string } | null {
  // CRLF (Git for Windows' autocrlf) left a `\r` on every value and kept
  // `(.*)$` from matching at all.
  const content = readSkillMd(filePath)?.replace(/\r\n/g, "\n");
  if (!content) return null;
  if (!content.startsWith("---")) return null;
  const end = content.indexOf("\n---", 4);
  if (end === -1) return null;
  const fm = content.slice(4, end);
  const out: { name?: string; description?: string } = {};
  for (const line of fm.split("\n")) {
    const m = line.match(/^(name|description):\s*(.*)$/);
    if (m) out[m[1] as "name" | "description"] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}
