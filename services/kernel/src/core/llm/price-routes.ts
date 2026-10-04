/**
 * Model prices and the one thing that uses them today: translating a text
 * with the cheapest external model.
 *
 *   GET  /api/llm/prices          what each priced model costs (USD / MTok)
 *   POST /api/llm/prices/refresh  re-download LiteLLM's table and re-price
 *   POST /api/llm/translate       { text, to? } → { text, provider, model, cached }
 *
 * Prices refresh on boot, once a day, and whenever a provider is connected or
 * reconfigured (see `refreshSoon`, wired into bootstrap's refreshLlmConsumers).
 */

import { createHash } from "node:crypto";
import { HttpError, type KernelHttpServer } from "../http-server.js";
import type { SqliteDb } from "../db/sqlite.js";
import { log } from "../logger.js";
import type { LlmProviderRegistry } from "./provider-registry.js";
import { ModelPriceStore, refreshModelPrices, isPriceable } from "./model-prices.js";
import { createChainLlmClient } from "./client.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TRANSLATE_CHARS = 8000;
/** How many priced links the cheapest client carries (primary + fallbacks). */
const CHEAPEST_LINKS = 4;
const LANGS: Record<string, string> = { es: "Spanish (Rioplatense, neutral register)", en: "English" };

export function registerPriceRoutes(
  server: KernelHttpServer,
  deps: { db: SqliteDb; registry: LlmProviderRegistry },
): { refreshSoon: (why: string) => void; stop: () => void } {
  const store = new ModelPriceStore(deps.db);
  deps.db.exec(
    "CREATE TABLE IF NOT EXISTS llm_translations (\n" +
      "  key        TEXT PRIMARY KEY,\n" +
      "  text       TEXT NOT NULL,\n" +
      "  provider   TEXT NOT NULL,\n" +
      "  model      TEXT NOT NULL,\n" +
      "  created_at TEXT NOT NULL\n" +
      ")",
  );

  let running: Promise<unknown> | null = null;
  let lastRefresh: { at: string; priced: number; error?: string } | null = null;

  const runningExternal = () =>
    deps.registry
      .getRunningSlugs()
      .filter(isPriceable)
      .map((slug) => ({ slug, provider: deps.registry.getProvider(slug) }))
      .filter((p) => typeof p.provider?.listModels === "function")
      .map((p) => ({ slug: p.slug, listModels: () => p.provider!.listModels!() }));

  const refresh = (why: string): Promise<unknown> => {
    if (running) return running;
    running = refreshModelPrices({ store, providers: runningExternal() })
      .then((r) => { lastRefresh = { at: new Date().toISOString(), priced: r.priced }; return r; })
      .catch((e) => {
        lastRefresh = { at: new Date().toISOString(), priced: 0, error: String(e) };
        log.warn(`model prices: refresh (${why}) failed — ${String(e).slice(0, 200)}`);
      })
      .finally(() => { running = null; });
    return running;
  };

  // A connect fires several reloads in a row; one refresh after they settle.
  let debounce: ReturnType<typeof setTimeout> | null = null;
  const refreshSoon = (why: string) => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => { debounce = null; void refresh(why); }, 5_000);
  };
  // Boot: providers start asynchronously, so give them a moment.
  const boot = setTimeout(() => void refresh("boot"), 30_000);
  const daily = setInterval(() => void refresh("daily"), DAY_MS);

  server.route("GET", "/api/llm/prices", () => ({
    prices: store.list(),
    last_refresh: lastRefresh,
    source: "litellm",
  }));

  server.route("POST", "/api/llm/prices/refresh", async () => {
    await refresh("manual");
    return { prices: store.list(), last_refresh: lastRefresh };
  });

  server.route<{ text?: unknown; to?: unknown }>("POST", "/api/llm/translate", async ({ body }) => {
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) throw new HttpError(400, "text required");
    if (text.length > MAX_TRANSLATE_CHARS) throw new HttpError(413, `text longer than ${MAX_TRANSLATE_CHARS} characters`);
    const to = typeof body?.to === "string" && body.to in LANGS ? body.to : "es";

    const key = createHash("sha256").update(`${to}\n${text}`).digest("hex");
    const hit = deps.db.prepare("SELECT text, provider, model FROM llm_translations WHERE key = ?").get(key) as
      | { text: string; provider: string; model: string }
      | undefined;
    if (hit) return { ...hit, cached: true };

    // A running provider is not necessarily a usable one (no key, not
    // connected): rank widely and try the first CHEAPEST_LINKS that can run.
    const ranked = store.cheapest(deps.registry.getRunningSlugs().filter(isPriceable), 40);
    if (ranked.length === 0) {
      throw new HttpError(503, "No priced external model yet — connect a cloud provider, or refresh the prices.");
    }
    // Cheapest first, one link at a time. The chain client would fail over on
    // an error but not on an EMPTY reply — which is what a small reasoning
    // model (gpt-5-nano) returns when its thinking eats the token budget.
    let r: { text: string; model: string } | null = null;
    let used = ranked[0];
    const failures: string[] = [];
    let tried = 0;
    for (const link of ranked) {
      if (tried >= CHEAPEST_LINKS) break;
      const client = createChainLlmClient([{ provider: link.provider, model: link.model }]);
      if (!client) continue;
      tried++;
      try {
        const res = await client.chat({
          system:
            `Translate the user's text into ${LANGS[to]}. Keep meaning, tone, formatting, ` +
            "markdown, code, identifiers, product names and quoted strings as they are. " +
            "Reply with the translation only — no preface, no notes.",
          user: text,
          // Reasoning models spend part of this before writing a word.
          maxTokens: Math.min(8192, Math.max(2048, Math.ceil(text.length / 2) + 512)),
          caller: "translate:cheapest",
        });
        if (res.text.trim()) { r = res; used = link; break; }
        failures.push(`${link.provider}/${link.model}: empty reply`);
      } catch (e) {
        failures.push(`${link.provider}/${link.model}: ${String(e).slice(0, 120)}`);
      }
    }
    if (!r) {
      throw new HttpError(
        tried === 0 ? 503 : 502,
        tried === 0
          ? "None of the priced models belongs to a connected provider — connect a cloud provider, or refresh the prices."
          : `Translation failed on every cheap model — ${failures.join("; ")}`,
      );
    }
    const out = r.text.trim();
    const row = { text: out, provider: used.provider, model: r.model || used.model };
    deps.db
      .prepare("INSERT OR REPLACE INTO llm_translations (key, text, provider, model, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(key, row.text, row.provider, row.model, new Date().toISOString());
    return { ...row, cached: false };
  });

  return {
    refreshSoon,
    stop: () => { clearTimeout(boot); clearInterval(daily); if (debounce) clearTimeout(debounce); },
  };
}
