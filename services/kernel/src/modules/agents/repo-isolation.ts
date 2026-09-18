/**
 * The two ways an office's agents can work on a repo.
 *
 * `host` is the historical Office Kit posture: no sandbox, permissions bypassed.
 * The claude_code executor refuses it unless the kernel runs with
 * KERNEL_ALLOW_UNSANDBOXED_AGENTS=1 (agent-advanced/_module/claude-code-executor.ts:550).
 *
 * `sandbox` writes neither variable, which leaves the executor on its own
 * default: bwrap on, permission mode `dontAsk` with allow rules.
 */
import type { RepoIsolation } from "./types.js";

export function applyRepoIsolation(
  vars: Record<string, unknown>,
  isolation: RepoIsolation,
): Record<string, unknown> {
  const next = { ...vars };
  if (isolation === "host") {
    next.__sandbox__ = false;
    next.__permission_mode__ = "bypassPermissions";
  } else {
    delete next.__sandbox__;
    delete next.__permission_mode__;
  }
  return next;
}

/** Whether this kernel lets agents run straight on the host. */
export function hostIsolationAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KERNEL_ALLOW_UNSANDBOXED_AGENTS === "1";
}
