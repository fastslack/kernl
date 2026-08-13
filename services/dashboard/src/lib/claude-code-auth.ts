/**
 * Recognise the one Claude Code failure the operator can actually fix.
 *
 * The provider runs on a subscription rather than an API key, so when its
 * session lapses every agent reply becomes "Not logged in · Please run /login"
 * — an instruction that cannot be followed, because there is no terminal inside
 * the kernel. Surfaces that render agent output use this to turn that dead end
 * into the sign-in dialog.
 *
 * Kept deliberately narrow: it must not match a model merely *talking* about
 * logging in, only the provider's own error envelope.
 */
export function isClaudeCodeAuthError(text: unknown): boolean {
  if (typeof text !== "string" || !text) return false;
  return /not logged in|\bunauthori[sz]ed\b|401 not authenticated|invalid[_ -]?api[_ -]?key/i.test(text)
    && /claude|login|authenticat/i.test(text);
}
