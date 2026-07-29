/**
 * Per-provider "is this key still good?" probe — used by the dashboard's
 * /providers page on mount to render a green/red dot per configured
 * provider. Delegates to each provider's `listModels()` (which already
 * hits the upstream `/v1/models` endpoint) instead of duplicating the
 * fetch logic per call site.
 *
 * The response keys match the dashboard's `AI_PROVIDERS` IDs
 * (`anthropic`, `openai`, `grok`, `nvidia`, `lmstudio`) — note that the
 * registry uses "claude" internally for Anthropic, so we map. This keeps
 * the existing UI working unchanged.
 *
 * Cheap: one HTTP call per provider, all in parallel, 10s timeout each.
 * Always returns 200 with per-provider {ok, latencyMs, error?, models?}.
 */

import type { LlmProviderRegistry } from "./provider-registry.js";
import { classifyModel } from "./model-traits.js";

export interface ProviderTestResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
  models?: string[];
}

/** Dashboard-facing ID → registry slug. Add an entry when a new
 *  provider is wired up. Anything not listed here is skipped. */
const PROVIDER_MAP: Array<{ id: string; slug: string; modelFilter?: (id: string) => boolean }> = [
  { id: "anthropic",   slug: "claude",      modelFilter: (m) => m.toLowerCase().includes("claude") },
  // claude-code (Claude Code SDK, host `claude login` OAuth — no API key).
  // The setup wizard tests it by its own slug; without this entry the probe
  // returns nothing and the wizard shows "no test result for claude-code".
  { id: "claude-code", slug: "claude-code", modelFilter: (m) => m.toLowerCase().includes("claude") },
  { id: "openai",    slug: "openai",   modelFilter: (m) => /^(gpt-|o1-|o3-|chatgpt-)/i.test(m) },
  { id: "grok",      slug: "grok",     modelFilter: (m) => m.toLowerCase().includes("grok") },
  { id: "nvidia",    slug: "nvidia"    /* return all NIM models */                              },
  { id: "lmstudio",  slug: "lmstudio"  /* whatever's loaded                                    */ },
  { id: "minimax",   slug: "minimax"   /* OpenAI-compatible /v1/models                         */ },
];

const MAX_MODELS = 30;

export async function testAllProviders(
  registry: LlmProviderRegistry,
): Promise<Record<string, ProviderTestResult>> {
  const statuses = registry.getStatuses();
  const statusBySlug = new Map(statuses.map((s) => [s.slug, s] as const));
  const results: Record<string, ProviderTestResult> = {};

  await Promise.all(
    PROVIDER_MAP.map(async ({ id, slug, modelFilter }) => {
      const status = statusBySlug.get(slug);
      const provider = registry.getProvider(slug);
      if (!status?.ready || !provider) {
        results[id] = {
          ok: false,
          latencyMs: 0,
          error: status?.error ?? "Provider not configured",
        };
        return;
      }
      if (typeof provider.listModels !== "function") {
        // Some providers (claude-code SDK) don't expose a catalog endpoint.
        // Treat as "ok, no list" rather than failure.
        results[id] = { ok: true, latencyMs: 0, models: [] };
        return;
      }
      const start = Date.now();
      try {
        const all = await provider.listModels();
        const filtered = modelFilter ? all.filter(modelFilter) : all;
        // Drop non-chat models (embeddings/audio/image/etc) — the
        // /providers page is showing "what can I chat with", not
        // "what does this provider expose".
        const chatOnly = filtered.filter((m) => classifyModel(slug, m).chat);
        results[id] = {
          ok: true,
          latencyMs: Date.now() - start,
          models: chatOnly.slice(0, MAX_MODELS),
        };
      } catch (err) {
        results[id] = {
          ok: false,
          latencyMs: Date.now() - start,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  return results;
}
