/**
 * Losing access to the Claude subscription, as opposed to hitting its limit.
 *
 * A usage limit is per model and lifts on its own: another model of the same
 * subscription can take the run (see claude-limits.ts). Access is lost for
 * the whole CLI session — the organization turned subscription access off,
 * the OAuth session expired, nobody is logged in — so every model of the
 * subscription fails the same way until someone reconnects it. The run can
 * only go on through another provider, and until then failing it again every
 * 15 minutes must not auto-pause the agent: nothing about the agent is wrong.
 */

const ACCESS_PATTERNS = [
  /disabled Claude subscription access/i,
  /organization has been disabled/i,
  /failed to authenticate/i,
  /oauth (?:session|token) (?:has )?expired/i,
  /could not be refreshed/i,
  /not logged in/i,
  /please run \/login/i,
  /invalid api key/i,
];

/** True when the CLI cannot use the subscription at all (not a limit, not a refusal). */
export function isClaudeAccessError(message: string): boolean {
  if (!message) return false;
  return ACCESS_PATTERNS.some((re) => re.test(message));
}

/**
 * Prefix of a run that stopped because Claude access is gone and the agent
 * had nowhere safe to go. The breaker reads it to leave the agent unpaused,
 * the dashboard to offer the reconnection.
 */
export const CLAUDE_ACCESS_WAITING = "Claude access lost — waiting for reconnection:";

/** Same, for a coding agent whose subscription is over its usage limit: it waits for the reset. */
export const CLAUDE_LIMIT_WAITING = "Claude usage limit — waiting for the reset:";

export class ClaudeAccessError extends Error {
  /** Work was already streamed or done before access failed — a retry would repeat it. */
  partial = false;

  constructor(readonly detail: string, readonly model: string) {
    super(`claude_code: subscription access lost on ${model}. ${detail}`.trim());
    this.name = "ClaudeAccessError";
  }
}
