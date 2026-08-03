/**
 * The precondition that keeps the product out of reach until an LLM can
 * actually run an agent.
 *
 * Split from `readiness.ts` so the verdict and the enforcement can be read and
 * tested apart: one answers "can an agent run", the other decides what a
 * request should get when the answer is no.
 */

import type { Precondition } from "../http-server.js";
import { readinessForGate } from "./readiness.js";

/**
 * Paths that stay open while the gate is closed.
 *
 * Everything here exists to *fix* the condition being enforced. Gate them and
 * the install becomes unrecoverable through its own UI: the operator gets a
 * blocking screen whose every button 428s.
 *
 * Prefixes, matched against the start of the pathname.
 */
export const READINESS_EXEMPT_PREFIXES = [
  // Liveness and session — never gated, or the dashboard cannot even discover
  // that it is blocked.
  "/api/health",
  "/api/metrics",
  "/api/auth/",
  // The verdict itself, and the manual re-check button.
  "/api/llm/readiness",
  // Provider configuration: keys, models, schema, start/stop, chain probe, and
  // the claude-code sign-in flow.
  "/api/llm/",
  "/api/llm-providers",
  // The setup wizard's own writes.
  "/api/config/ai",
];

export function isReadinessExempt(pathname: string): boolean {
  return READINESS_EXEMPT_PREFIXES.some((p) => pathname.startsWith(p));
}

/**
 * Build the precondition.
 *
 * Before the first probe resolves there is no verdict yet. That window opens
 * at boot and closes a second later, and the honest answer for it is the same
 * as a failure — letting requests through "just until we know" is how a gate
 * turns into a suggestion.
 */
export function createLlmReadinessGate(): Precondition {
  return (pathname) => {
    if (isReadinessExempt(pathname)) return null;

    const verdict = readinessForGate();
    if (verdict?.ok) return null;

    return {
      // 428 Precondition Required: the request is well-formed and the server
      // refuses it until the install satisfies a condition. Not 401 (the
      // caller is authenticated) and not 503 (nothing is temporarily down).
      status: 428,
      body: {
        error: "llm_not_configured",
        reason: verdict?.reason ?? "unknown",
        detail:
          verdict?.detail ??
          "Checking which LLM providers can run agents. Retry in a moment.",
        provider: verdict?.provider,
        checkedAt: verdict?.checkedAt,
      },
    };
  };
}
