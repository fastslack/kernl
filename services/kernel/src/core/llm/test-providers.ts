/**
 * Per-provider "does this actually work?" probe, behind the providers page's
 * Test buttons.
 *
 * It used to delegate to `listModels()` alone. That is a real HTTP call for
 * the OpenAI-shaped providers, but claude-code answers it from a hardcoded
 * array — so the probe reported `ok: true, latencyMs: 0` for a provider it had
 * never contacted, and the page showed a green READY while every agent run
 * failed. Zero milliseconds was the tell.
 *
 * So the catalogue is now just the catalogue, and the verdict comes from a
 * real completion carrying one tool. That answers both questions the page
 * cares about: does it respond, and can it execute a tool call — which is what
 * an agent needs and what a connectivity check can never establish.
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
import { classifyModel, type ModelTraits } from "./model-traits.js";

export interface ProviderTestResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
  models?: string[];
  /**
   * Per-model capability tags, keyed by the ids in `models`.
   *
   * The kernel already classifies every model it lists (vision / reasoning /
   * fast / long-context), and the settings dropdowns — whose only source is
   * this probe — were throwing that away and rendering bare ids. Sent as a
   * separate map rather than changing `models` so older frontends keep working.
   */
  traits?: Record<string, ModelTraits>;
  /**
   * Did a real completion come back? Listing models proves a catalogue exists,
   * not that the provider answers — and for claude-code the catalogue is a
   * hardcoded array, so the old probe returned `ok: true, latencyMs: 0` on a
   * provider it had never contacted.
   */
  answered?: boolean;
  /**
   * Did it execute a tool call? This is the question the providers page is
   * really asking, because an agent is a model plus tools. A provider can
   * answer perfectly and still be useless to every native-executor agent.
   */
  toolCall?: boolean;
}

/** Trivial tool the probe asks the provider to call. */
const PROBE_TOOL = {
  name: "kernl_probe_echo",
  description: "Echo a word back. Call this tool; do not answer in prose.",
  input_schema: {
    type: "object",
    properties: { word: { type: "string", description: "The word to echo back" } },
    required: ["word"],
  },
};

const PROBE_PROMPT = 'Call the kernl_probe_echo tool with word set to "ok". Reply with the tool call only.';

/** claude-code spawns a CLI, so it needs more room than an HTTP round trip. */
function probeTimeout(slug: string): number {
  return slug === "claude-code" || slug === "claude_code" ? 45_000 : 20_000;
}

/** Dashboard-facing ID → registry slug. Add an entry when a new
 *  provider is wired up. Anything not listed here is skipped. */
const PROVIDER_MAP: Array<{ id: string; slug: string; modelFilter?: (id: string) => boolean }> = [
  { id: "anthropic",   slug: "claude",      modelFilter: (m) => m.toLowerCase().includes("claude") },
  // claude-code (Claude Code SDK, host `claude login` OAuth — no API key).
  // The setup wizard tests it by its own slug; without this entry the probe
  // returns nothing and the wizard shows "no test result for claude-code".
  // "opus" / "sonnet" / "haiku" are the CLI's aliases for the newest model of
  // each family. A plain `includes("claude")` filter drops them, which would
  // hide the one choice that never goes stale.
  { id: "claude-code", slug: "claude-code", modelFilter: (m) => /claude|^(opus|sonnet|haiku)$/i.test(m) },
  { id: "openai",    slug: "openai",   modelFilter: (m) => /^(gpt-|o1-|o3-|chatgpt-)/i.test(m) },
  { id: "grok",      slug: "grok",     modelFilter: (m) => m.toLowerCase().includes("grok") },
  { id: "nvidia",    slug: "nvidia"    /* return all NIM models */                              },
  { id: "lmstudio",  slug: "lmstudio"  /* whatever's loaded                                    */ },
  { id: "minimax",   slug: "minimax"   /* OpenAI-compatible /v1/models                         */ },
];

/**
 * Sanity bound on the catalogue each probe carries back, not a display limit.
 *
 * It was 30, applied after an alphabetical sort — which quietly amputated the
 * newest half of a real catalogue: with OpenAI listing 78 chat models, the
 * settings dropdowns (their only source for this list) stopped at
 * `gpt-5-nano-…` and never offered gpt-5-pro, gpt-5.1, gpt-5.2, gpt-5.4 or
 * anything above. Nothing said so; the models simply were not there.
 *
 * The number is here to stop a local runtime that advertises thousands from
 * bloating one JSON response, so it belongs far above any real chat catalogue.
 */
const MAX_MODELS = 200;

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
      // The catalogue, when there is one. Never the verdict on its own: for
      // claude-code `listModels()` returns a constant, so a green light built
      // on it meant nothing had been contacted.
      let models: string[] = [];
      let traits: Record<string, ModelTraits> = {};
      let catalogError = "";
      if (typeof provider.listModels === "function") {
        try {
          const all = await provider.listModels();
          const filtered = modelFilter ? all.filter(modelFilter) : all;
          // Drop non-chat models (embeddings/audio/image/etc) — the
          // /providers page is showing "what can I chat with", not
          // "what does this provider expose".
          const classified = filtered
            .map((m) => [m, classifyModel(slug, m)] as const)
            .filter(([, t]) => t.chat)
            .slice(0, MAX_MODELS);
          models = classified.map(([m]) => m);
          traits = Object.fromEntries(classified);
        } catch (err) {
          catalogError = err instanceof Error ? err.message : String(err);
        }
      }

      // The actual test: one small completion.
      //
      // A provider that declares `tools: false` is asked a plain question
      // instead. Handing it a tool would fail it for refusing something it
      // never claimed — claude-code answers that in 9s with "Reached maximum
      // number of turns (1)" and would show up broken, while it runs agents
      // fine through its own SDK loop. The capability is reported separately;
      // the test only establishes whether it answers at all.
      const declaresTools = status.capabilities?.tools !== false;
      const start = Date.now();
      try {
        const result = await Promise.race([
          provider.chatCompletion(
            [{ role: "user", content: declaresTools ? PROBE_PROMPT : "Reply with the single word: ok" }],
            {
              ...(declaresTools ? { tools: [PROBE_TOOL] } : {}),
              max_tokens: 128,
              extras: { caller: "provider-test" },
            },
          ),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`no response in ${probeTimeout(slug)}ms`)),
              probeTimeout(slug),
            ),
          ),
        ]);
        results[id] = {
          ok: true,
          latencyMs: Date.now() - start,
          models,
          traits,
          answered: true,
          toolCall: declaresTools
            ? (result.tool_calls?.some((c) => c.name === PROBE_TOOL.name) ?? false)
            : false,
        };
      } catch (err) {
        results[id] = {
          ok: false,
          latencyMs: Date.now() - start,
          models,
          traits,
          answered: false,
          error: err instanceof Error ? err.message : String(err) || catalogError,
        };
      }
    }),
  );

  return results;
}
