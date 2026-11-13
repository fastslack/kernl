import { getClaudeModelLimit, claudeModelMatches } from "../../sdk/claude-limits.js";
import type { getHealth } from "./provider-health.js";
import type { BlockedModel } from "./model-blocklist.js";
import { canonicalSlug } from "./provider-catalog.js";
import type { InFlightLlmCall } from "../../sdk/llm-inflight.js";

type LinkStatus = "active" | "standby" | "no-key" | "quota" | "rate-limit" | "auth" | "degraded";

/** The operator sees the same model and provider restrictions that routing learned. */
export function describeChainLink(
  link: { slug: string; provider: string; model: string; available: boolean },
  isPrimary: boolean,
  health?: ReturnType<typeof getHealth>,
  blockedModel?: Pick<BlockedModel, "reason" | "error_raw">,
) {
  // Limited only once every connected account is: while one still has quota
  // the subscription rotates to it, so the link is not out.
  const limit = /^(claude_code|claude-code)$/.test(link.slug) ? getClaudeModelLimit(link.model, Date.now()) : null;
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

/**
 * Hand each call in flight to the chain link serving it. A call matches the
 * link with its slug and model (exactly, else through a Claude family alias:
 * see claudeModelMatches); a call on a model no link names (the
 * provider's default, an agent's own pick) goes to that slug's model-less
 * link, else its first link. Slugs compare through the catalog because the
 * driver says "claude_code" where the adapters say "claude-code".
 */
export function attachInFlight(
  links: Array<{ slug: string; model: string }>,
  calls: InFlightLlmCall[],
): Array<Array<{ caller?: string; startedAt: number }>> {
  const out = links.map(() => [] as Array<{ caller?: string; startedAt: number }>);
  const slugs = links.map((l) => canonicalSlug(l.slug));
  for (const call of [...calls].sort((a, b) => a.startedAt - b.startedAt)) {
    const slug = canonicalSlug(call.slug);
    let i = call.model ? links.findIndex((l, j) => slugs[j] === slug && l.model === call.model) : -1;
    // A link naming the family alias ("sonnet") serves that family's full ids.
    if (i < 0 && call.model) i = links.findIndex((l, j) => slugs[j] === slug && !!l.model && claudeModelMatches(l.model, call.model!));
    if (i < 0) i = links.findIndex((l, j) => slugs[j] === slug && !l.model);
    if (i < 0) i = slugs.indexOf(slug);
    if (i >= 0) out[i].push({ caller: call.caller, startedAt: call.startedAt });
  }
  return out;
}

type ChainInput = { slug: string; provider: string; model: string; available: boolean };

/**
 * The GET /api/llm/chain body: every link described, with the calls running
 * on it and the slug the call log files it under (the driver's links say
 * "claude_code", the log and usage rollup say "claude-code").
 */
export function buildChainView(
  chain: { primary: ChainInput; fallbacks: ChainInput[] },
  health: Record<string, ReturnType<typeof getHealth> | undefined>,
  blockedModels: Array<Pick<BlockedModel, "slug" | "model" | "reason" | "error_raw">>,
  calls: InFlightLlmCall[],
) {
  const all = [chain.primary, ...chain.fallbacks];
  const inFlight = attachInFlight(all, calls);
  const views = all.map((link, i) => ({
    ...describeChainLink(link, i === 0, health[link.slug], blockedModels.find((b) => b.slug === link.slug && b.model === link.model)),
    logSlug: canonicalSlug(link.slug),
    inFlight: inFlight[i],
  }));
  return { primary: views[0], fallbacks: views.slice(1) };
}
