/**
 * Recognising "this failed because the LLM isn't set up" so the UI can offer
 * the fix instead of only naming the problem.
 *
 * The kernel already writes the instruction into the error ("Configure a
 * provider that supports tools (Settings → AI)") but prose is not a button:
 * the 3D flow truncates the card preview at 140 characters — exactly where the
 * instruction lives — and nothing anywhere links to the screen.
 *
 * The signatures are the kernel's own strings; see `llm-error.test.ts`, which
 * quotes them verbatim so a reword on the kernel side fails a test here rather
 * than quietly dropping the chip.
 */

/** Deep link to the card that actually configures providers. */
export const LLM_SETTINGS_HREF = "/settings?section=ai&card=providers";

/** Errors that can only mean "no usable LLM is configured". */
const CONFIG_SIGNATURES = [
  /no (?:available )?llm provider/i,
  /no llm provider is configured/i,
  /provider not configured/i,
];

/**
 * Auth and quota failures. On their own these say nothing — a tool calling a
 * third-party API gets 401s all day — so they only count when the same text
 * also names the LLM layer.
 */
const CREDENTIAL_SIGNATURES = [
  /\b401\b/,
  /unauthorized/i,
  /invalid api[_ -]?key/i,
  /insufficient_quota/i,
  /quota exceeded/i,
];

const LLM_CONTEXT = /\b(llm|provider|api[_ -]?key|anthropic|openai|openrouter|gemini|grok|claude_code)\b/i;

/** True when the failure is the LLM configuration, not the work being done. */
export function isLlmConfigError(text: string | null | undefined): boolean {
  if (!text) return false;
  if (CONFIG_SIGNATURES.some((re) => re.test(text))) return true;
  return CREDENTIAL_SIGNATURES.some((re) => re.test(text)) && LLM_CONTEXT.test(text);
}
