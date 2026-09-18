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
 *
 * The pattern catalogue and `sanitizePromptText` are pure and live in the
 * extension SDK; the audit log and the SKILL.md cache below hold state, so
 * they stay here.
 */

import { existsSync, readFileSync, mkdirSync, appendFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "./logger.js";
import { sanitizePromptText, type SanitizeResult } from "../sdk/prompt-sanitizer.js";

export { INJECTION_PATTERNS, sanitizePromptText, type SanitizeResult } from "../sdk/prompt-sanitizer.js";

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
