/**
 * Prompt sanitizer — the pure half: the injection catalogue and the check.
 *
 * Defends against indirect prompt injection through agent system prompts,
 * skill markdown, and LLM-proposed prompt rewrites. The audit log and the
 * SKILL.md cache hold state, so they stay in the kernel
 * (`src/core/prompt-sanitizer.ts`), which re-exports everything here.
 */

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
// This catalogue is shared by wrapExternal (flag only) AND by the agent /
// skill / reflection-optimizer gates (which reject), so every pattern must be
// safe for first-party prompts too, not just for third-party text.
//
// Each pattern is intentionally narrow so legitimate skill text does not
// trigger. False positives observed during dogfood drove the constraints.

export const INJECTION_PATTERNS: RegExp[] = [
  // ── Role hijacking (EN) ─────────────────────────────────────────────
  /ignore\s+(all\s+)?(the\s+)?(previous|above|prior)\s+(instructions?|prompts?)/i,
  /disregard\s+(all\s+)?(the\s+)?(previous|above|prior)\s+(instructions?|prompts?)/i,
  /\bnew\s+instructions\s+follow\b/i,
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

  // ── Role hijacking (PT) ─────────────────────────────────────────────
  /(?:ignore|esque[çc]a|desconsidere)\s+(?:todas\s+)?(?:as\s+)?instru[çc][õo]es\s+(?:anteriores|acima|pr[ée]vias)/i,

  // ── Forged element / transcript structure ───────────────────────────
  // A forged closing tag or an opening tag with attributes of the <external>
  // wrapper (wrapExternal has already turned its "<" into "‹"), or a fake chat
  // turn. A bare "<external>" stays legal so prompts can document the wrapper.
  /[<‹]\s*\/\s*external\s*>/i,
  /[<‹]\s*external\s+(?:source|trust|from)\s*=/i,
  /&(?:lt|#0*60|#x0*3c);\s*\/\s*external\b/i,
  /^\s*SYSTEM\s*:\s*(?:[Yy]ou|[Yy]our|[Tt]he\s+user|[Ii]gnore|[Oo]bey|[Dd]isregard|[Ff]rom\s+now|[Oo]verride)\b/m,
  /^#{2,3}\s*Instruction\s*$/m,
  /^(?:Human|User)\s*:[^\n]*\n\s*Assistant\s*:/m,

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
  /(?:send|mand[áa]|envi[áa]|upload|forward)[^\n.]{0,50}(?:~\/\.\w|\.env\b|id_rsa|\/etc\/(?:passwd|shadow))/i,
  /(?:reveal|print|show|reply\s+with|repeat)\s+(?:me\s+)?(?:your|the)\s+(?:hidden\s+)?system\s+prompt/i,
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
