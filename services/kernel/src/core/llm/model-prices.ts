/**
 * What each external model costs, so "the cheapest model" means something.
 *
 * No provider API publishes its prices. LiteLLM keeps a public JSON with the
 * per-token price of ~4.5k models across every provider the kernel speaks to
 * (`model_prices_and_context_window.json`), and it is what this reads. For each
 * connected provider the kernel lists its models, prices the ones LiteLLM
 * knows, and keeps them in `llm_model_prices`. A model LiteLLM does not know
 * stays unpriced — it is never guessed.
 *
 * Local runtimes (Ollama, LM Studio) and the Claude Code subscription are not
 * priced at all: they are not billed per token, and "cheapest" deliberately
 * means the cheapest EXTERNAL, metered model.
 *
 * Prices are USD per million tokens, the unit every pricing page uses.
 */

import type { SqliteDb } from "../db/sqlite.js";
import { log } from "../logger.js";

export const LITELLM_PRICES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** Kernel provider slug → LiteLLM's `litellm_provider`. Absent = never priced. */
const LITELLM_PROVIDER: Record<string, string> = {
  openai: "openai",
  claude: "anthropic",
  gemini: "gemini",
  groq: "groq",
  openrouter: "openrouter",
  nvidia: "nvidia_nim",
  deepseek: "deepseek",
  grok: "xai",
  minimax: "minimax",
};

export interface ModelPrice {
  provider: string;
  model: string;
  inputPerMTok: number;
  outputPerMTok: number;
}

type LiteLlmEntry = {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  litellm_provider?: string;
  mode?: string;
};

const perMTok = (perToken: number) => Math.round(perToken * 1e6 * 1e6) / 1e6;

/**
 * Price `modelIds` of the kernel provider `slug` from LiteLLM's table.
 * Only chat models of the matching LiteLLM provider count — the same id under
 * another provider (gpt-4o-mini on OpenRouter) is a different price.
 */
export function matchPrices(data: Record<string, unknown>, slug: string, modelIds: string[]): ModelPrice[] {
  const litellm = LITELLM_PROVIDER[slug];
  if (!litellm) return [];
  const prefix = `${litellm}/`;
  const index = new Map<string, LiteLlmEntry>();
  for (const [key, raw] of Object.entries(data)) {
    const e = raw as LiteLlmEntry;
    if (!e || typeof e !== "object" || e.litellm_provider !== litellm || e.mode !== "chat") continue;
    if (typeof e.input_cost_per_token !== "number" || typeof e.output_cost_per_token !== "number") continue;
    const id = key.startsWith(prefix) ? key.slice(prefix.length) : key;
    index.set(id.toLowerCase(), e);
  }
  const out: ModelPrice[] = [];
  for (const model of modelIds) {
    const e = index.get(model.toLowerCase());
    if (!e) continue;
    out.push({
      provider: slug,
      model,
      inputPerMTok: perMTok(e.input_cost_per_token!),
      outputPerMTok: perMTok(e.output_cost_per_token!),
    });
  }
  return out;
}

export class ModelPriceStore {
  constructor(private readonly db: SqliteDb) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS llm_model_prices (\n" +
        "  provider        TEXT NOT NULL,\n" +
        "  model           TEXT NOT NULL,\n" +
        "  input_per_mtok  REAL NOT NULL,\n" +
        "  output_per_mtok REAL NOT NULL,\n" +
        "  source          TEXT NOT NULL DEFAULT 'litellm',\n" +
        "  updated_at      TEXT NOT NULL,\n" +
        "  PRIMARY KEY (provider, model)\n" +
        ")",
    );
  }

  /** A provider's prices, all at once: models it no longer lists drop out. */
  replace(provider: string, prices: ModelPrice[]): void {
    const now = new Date().toISOString();
    const del = this.db.prepare("DELETE FROM llm_model_prices WHERE provider = ?");
    const ins = this.db.prepare(
      "INSERT OR REPLACE INTO llm_model_prices (provider, model, input_per_mtok, output_per_mtok, source, updated_at) " +
        "VALUES (?, ?, ?, ?, 'litellm', ?)",
    );
    this.db.transaction(() => {
      del.run(provider);
      for (const p of prices) ins.run(provider, p.model, p.inputPerMTok, p.outputPerMTok, now);
    })();
  }

  list(provider?: string): Array<ModelPrice & { updatedAt: string }> {
    const rows = (provider
      ? this.db.prepare("SELECT * FROM llm_model_prices WHERE provider = ? ORDER BY provider, model").all(provider)
      : this.db.prepare("SELECT * FROM llm_model_prices ORDER BY provider, model").all()) as Array<{
      provider: string; model: string; input_per_mtok: number; output_per_mtok: number; updated_at: string;
    }>;
    return rows.map((r) => ({
      provider: r.provider,
      model: r.model,
      inputPerMTok: r.input_per_mtok,
      outputPerMTok: r.output_per_mtok,
      updatedAt: r.updated_at,
    }));
  }

  /** The `limit` cheapest priced models among `providers`, input + output per MTok. */
  cheapest(providers: string[], limit: number): ModelPrice[] {
    if (providers.length === 0 || limit <= 0) return [];
    const marks = providers.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT provider, model, input_per_mtok, output_per_mtok FROM llm_model_prices
         WHERE provider IN (${marks})
         ORDER BY (input_per_mtok + output_per_mtok) ASC, provider, model LIMIT ?`,
      )
      .all(...providers, limit) as Array<{ provider: string; model: string; input_per_mtok: number; output_per_mtok: number }>;
    return rows.map((r) => ({ provider: r.provider, model: r.model, inputPerMTok: r.input_per_mtok, outputPerMTok: r.output_per_mtok }));
  }
}

/** Can this kernel provider be priced at all? (external and known to LiteLLM) */
export function isPriceable(slug: string): boolean {
  return slug in LITELLM_PROVIDER;
}

/**
 * Re-price every running external provider. One download of the LiteLLM
 * table per call; a provider whose model list fails keeps its old prices.
 */
export async function refreshModelPrices(deps: {
  store: ModelPriceStore;
  providers: Array<{ slug: string; listModels: () => Promise<string[]> }>;
  fetchTable?: () => Promise<Record<string, unknown>>;
}): Promise<{ priced: number; providers: string[] }> {
  const external = deps.providers.filter((p) => isPriceable(p.slug));
  if (external.length === 0) return { priced: 0, providers: [] };
  const fetchTable =
    deps.fetchTable ??
    (async () => {
      const r = await fetch(LITELLM_PRICES_URL, { signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`LiteLLM prices: HTTP ${r.status}`);
      return (await r.json()) as Record<string, unknown>;
    });
  const table = await fetchTable();
  let priced = 0;
  const done: string[] = [];
  for (const p of external) {
    try {
      const prices = matchPrices(table, p.slug, await p.listModels());
      deps.store.replace(p.slug, prices);
      priced += prices.length;
      done.push(p.slug);
    } catch (e) {
      log.warn(`model prices: ${p.slug} skipped — ${String(e).slice(0, 160)}`);
    }
  }
  log.info(`model prices: ${priced} model(s) priced across ${done.join(", ") || "no provider"}`);
  return { priced, providers: done };
}
