import { getClaudeModelLimit } from "../../sdk/claude-limits.js";
import type { getHealth } from "./provider-health.js";
import type { BlockedModel } from "./model-blocklist.js";

type LinkStatus = "active" | "standby" | "no-key" | "quota" | "rate-limit" | "auth" | "degraded";

/** The operator sees the same model and provider restrictions that routing learned. */
export function describeChainLink(
  link: { slug: string; provider: string; model: string; available: boolean },
  isPrimary: boolean,
  health?: ReturnType<typeof getHealth>,
  blockedModel?: Pick<BlockedModel, "reason" | "error_raw">,
) {
  const limit = /^(claude_code|claude-code)$/.test(link.slug) ? getClaudeModelLimit(link.model) : null;
  let status: LinkStatus = isPrimary ? "active" : "standby";
  let reason: string | undefined;
  if (!link.available) {
    status = "no-key";
    reason = "No credentials configured";
  } else if (limit) {
    status = limit.kind === "billing" ? "quota" : "rate-limit";
    reason = limit.detail;
  } else if (blockedModel) {
    status = "degraded";
    reason = blockedModel.error_raw || `Model blocked: ${blockedModel.reason}`;
  } else if (health?.blocked) {
    switch (health.lastFailureKind) {
      case "exhausted": status = "quota"; reason = "Credits exhausted / billing required"; break;
      case "rate-limit": status = "rate-limit"; reason = "Rate-limited by provider"; break;
      case "auth": status = "auth"; reason = "Authentication rejected (bad key / forbidden)"; break;
      default: status = "degraded"; reason = "Blocked after repeated transient failures";
    }
  } else if ((health?.failures ?? 0) > 0) {
    status = "degraded";
    reason = `${health?.failures} recent failure(s)${health?.lastFailureKind ? ` (${health.lastFailureKind})` : ""}`;
  }
  return {
    slug: link.slug, provider: link.provider, model: link.model, status, reason,
    latencyMs: health?.ewmaMs,
    blockedForMs: limit ? Math.max(0, limit.blockedUntil - Date.now()) : health?.blockedFor,
    resetsAt: limit?.resetsAt,
    lastSuccessAt: health?.lastSuccessAt,
    failures: health?.failures ?? 0,
  };
}
