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
 * The routes that actually call a model.
 *
 * This list used to be its inverse: everything was refused except a handful of
 * exempt paths. The condition being enforced is narrow — "can some provider run
 * an agent tool loop" — but the enforcement was the whole API, so twenty
 * extension categories (crm, finance, health, home, automation) plus the life
 * view, the calendar and notifications went unreachable because a *different*
 * subsystem had no key. All of that is CRUD over local SQLite with no model in
 * the path.
 *
 * Worse, the verdict is a live probe demanding a real completion *and* a tool
 * call, so the same refusal fires on an exhausted quota, a provider outage or a
 * lapsed OAuth session. A personal-data app should not put its own local data
 * behind somebody else's uptime.
 *
 * So the gate now names what it protects. Under-listing is cheap: a route that
 * calls a model without being listed still fails on its own, with its own
 * error. Over-listing breaks features that never needed a model at all.
 *
 * Matched exactly, or as a path prefix ending in `/` — `/api/chat/message`
 * must not swallow `/api/chat/messages`, which is how you read a conversation
 * you already have.
 */
export const LLM_GATED_ROUTES = [
  // Chat: sending is the only part that calls a model. Reading your own
  // history, its attachments and its distilled facts is local data, and stays
  // readable when no provider is configured.
  "/api/chat/message",
  // Agents: running one, and authoring one from a prompt.
  "/api/agents/run",
  "/api/agents/trigger",
  "/api/agents/generate-from-prompt",
  "/api/offices/create",
];

/** Exact match, or a prefix that ends at a path segment boundary. */
export function isLlmGated(pathname: string): boolean {
  return LLM_GATED_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`));
}

export function createLlmReadinessGate(): Precondition {
  return (pathname) => {
    if (!isLlmGated(pathname)) return null;

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
