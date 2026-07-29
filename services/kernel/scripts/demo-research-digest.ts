#!/usr/bin/env bun
/**
 * demo-research-digest.ts — real-case verification of `kernel_research_digest`.
 *
 *   bun scripts/demo-research-digest.ts
 *
 * Feature S1 added `kernel_research_digest`: it summarizes a large source (a
 * kernel tool's output OR an inline `items` list) WITHOUT loading the raw rows
 * into the model's context — it ranks to top-k, chunks, runs a bounded
 * map-reduce, and returns `{ digest, citations[], chunks_processed,
 * chunks_failed, items_truncated, degraded, tokens }`.
 *
 * The tool is registered in the meta module ONLY when a chat completer is
 * available at bootstrap (graceful degradation). Per the project's
 * `feedback_real_test_first` rule, this is a miniature REAL-case demo that
 * boots the digest tool exactly like `core-modules.ts` does (real config, real
 * provider resolution, real RankingService, real embeddings when present) and
 * runs it against the REAL rss inventory (data/kernel.db has ~30k rss_items).
 *
 * What it proves end-to-end:
 *   1. Completer gating — if no provider/API key is healthy, the tool is NOT
 *      registered (clean skip, exit 0). This is expected in a keyless env.
 *   2. The map-reduce path runs over a real inventory.
 *   3. GROUNDING — every `#<id>` the digest cites must exist in the returned
 *      `citations[]` (citations come from real source rows, so a well-behaved
 *      run is PASS; a fabricated id is a genuine hallucination finding).
 *
 * Bootstrap note: we do NOT call the full `bootstrap()` (it stands up HTTP/MCP
 * servers + a network rss scheduler). Instead we reproduce the exact meta-module
 * wiring from `src/core/bootstrap/core-modules.ts` over a read-only handle to
 * the real DB — same completer-gating, same RankingService, same catalog shape.
 */

import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

import { loadConfig } from "../src/core/config.js";
import { createMetaModule } from "../src/modules/meta/index.js";
import {
  createChatProviders,
  resolveProvider,
} from "../src/modules/chat/llm-adapter.js";
import { RssRegistryService } from "../assets/extensions/integration/rss-registry/_module/service.js";
import { rssRegistryTools } from "../assets/extensions/integration/rss-registry/_module/tools.js";
import type { ToolDefinition, ToolResult } from "../src/core/types.js";

// ── 0. Open a read-only handle to the real kernel DB ──────────────────────
// bun:sqlite exposes the same prepare()/all()/get()/run() surface the kernel's
// SqliteDb interface expects (see scripts/cli/run.ts for the same wrapper).
const dbPath = process.env.SQLITE_PATH || resolve(process.cwd(), "data/kernel.db");
if (!existsSync(dbPath)) {
  console.error(`No DB at ${dbPath} — set SQLITE_PATH to a kernel.db.`);
  process.exit(1);
}
const bunDb = new Database(dbPath, { readonly: true });
const sqlite = {
  prepare: (sql: string) => {
    const stmt = bunDb.prepare(sql);
    return {
      all: (...params: unknown[]) => stmt.all(...params),
      get: (...params: unknown[]) => stmt.get(...params),
      run: (...params: unknown[]) => stmt.run(...params),
    };
  },
} as any;

function teardown(): void {
  try {
    bunDb.close();
  } catch {
    /* ignore */
  }
}

async function main(): Promise<number> {
  const config = loadConfig();

  // ── 1. Build a live catalog: the real rss tools + the meta module ────────
  // We construct RssRegistryService directly (no module.initialize → no rss
  // scheduler, no migrations, no seeding, no writes to the prod DB) so we get
  // a real `kernel_rss_items` over the real inventory.
  const rssService = new RssRegistryService(sqlite, null, null);
  const rssTools = rssRegistryTools(rssService);

  // Late-bound catalog ref so the meta tools (search/digest) see everything.
  let catalog: ToolDefinition[] = [];
  const getCatalog = () => catalog;

  // Reproduce core-modules.ts completer gating EXACTLY: same provider factory,
  // same default-provider resolution, same one-shot completer shape.
  const digestProviders = createChatProviders({
    anthropicApiKey: config.webIntel.anthropicApiKey,
    openaiApiKey: config.webIntel.openaiApiKey,
    lmstudioBaseUrl: config.webIntel.lmstudioBaseUrl,
    grokApiKey: config.webIntel.grokApiKey,
    grokDefaultModel: config.webIntel.grokDefaultModel,
    nvidiaApiKey: config.webIntel.nvidiaApiKey,
    nvidiaDefaultModel: config.webIntel.nvidiaDefaultModel,
  });
  const digestDefaultProvider =
    config.agents?.defaultProvider || config.chat.defaultProvider || "claude";

  const metaModule = createMetaModule({
    getCatalog,
    getEmbeddings: () => null, // embeddings come online later in real boot; lexical ranking degrades gracefully
    getCompleter: () => {
      const provider = resolveProvider(digestProviders, digestDefaultProvider);
      if (!provider || !provider.available()) return undefined;
      return async (system, user) => {
        const res = await provider.chatCompletion(
          [{ role: "user", content: user }],
          { system, max_tokens: 1024 },
        );
        return { text: res.content, tokens: res.tokens_used };
      };
    },
  });
  await metaModule.initialize?.({ sqlite, neo4j: null, events: null, config } as any);

  catalog = [...rssTools, ...metaModule.getTools()];

  // ── 2. Find kernel_research_digest ───────────────────────────────────────
  const digest = catalog.find((t) => t.name === "kernel_research_digest");
  if (!digest) {
    console.log(
      "kernel_research_digest not registered — no chat provider/API key " +
        "configured; skipping live digest demo.",
    );
    console.log(
      `(default provider tried: "${digestDefaultProvider}"; this is the ` +
        "expected graceful-degradation path in a keyless dev environment.)",
    );
    return 0;
  }
  console.log(`✓ kernel_research_digest is registered (default provider: "${digestDefaultProvider}").`);

  // ── 3. Pick a source: prefer real rss, fall back to inline ───────────────
  const QUERY = "AI";
  const MAP = "List the 1-line gist of each item with its #id.";
  const REDUCE = "Merge into at most 5 grouped bullet points; keep #id citations.";

  // First, see whether kernel_rss_items returns any rows for our query.
  const rssItemsTool = catalog.find((t) => t.name === "kernel_rss_items");
  let rssHasRows = false;
  if (rssItemsTool) {
    try {
      const probe = await rssItemsTool.handler({ query: QUERY, limit: 200 });
      const text = probe.content?.map((c) => c.text).join("\n") ?? "";
      rssHasRows = !probe.isError && !/^\s*No items\s*$/i.test(text.trim());
      console.log(
        `· kernel_rss_items probe: ${rssHasRows ? "has rows" : "empty"} ` +
          `(first line: ${text.split("\n")[0]?.slice(0, 60) ?? ""})`,
      );
    } catch (err) {
      console.log(`· kernel_rss_items probe threw: ${(err as Error).message}`);
    }
  }

  // FINDING (real-case): kernel_rss_items returns a markdown textResult, NOT a
  // structuredContent rows array — so `source: { tool: "kernel_rss_items" }`
  // would let the digest's extractItems() fall back to the text-content array,
  // yielding synthetic `idx-N` ids (no real per-item #id grounding). To get a
  // MEANINGFUL grounding check over the REAL inventory, we read the same rows
  // the tool would and pass them as an inline `items` source with real id+title.
  // (If rss has no rows at all, we use a small hand-written inline fallback.)
  let source: { items: unknown[] } | { tool: string; args: Record<string, unknown> };
  let path: "rss-inline" | "inline-fallback";

  if (rssHasRows) {
    const rows = rssService
      .listItems({ search: QUERY, limit: 60 })
      .map((r) => ({ id: r.id, title: r.title, feed: r.feed_name }));
    if (rows.length > 0) {
      source = { items: rows };
      path = "rss-inline";
      console.log(`· Using REAL rss inventory as inline source: ${rows.length} item(s).`);
    } else {
      source = { items: inlineFallbackRows() };
      path = "inline-fallback";
      console.log("· rss listItems returned 0 after filter — using inline fallback.");
    }
  } else {
    source = { items: inlineFallbackRows() };
    path = "inline-fallback";
    console.log("· rss inventory empty — using inline fallback rows.");
  }

  // ── 4. Run the digest ────────────────────────────────────────────────────
  console.log("\n─ Running kernel_research_digest … (real map-reduce + LLM calls)\n");
  let res: ToolResult;
  try {
    res = await digest.handler({
      source,
      query: QUERY,
      map_instruction: MAP,
      reduce_instruction: REDUCE,
      // keep the live run small/cheap: few chunks, low concurrency
      k: 24,
      chunk_size: 12,
      concurrency: 2,
      cooldown_ms: 800,
    });
  } catch (err) {
    console.error("✗ kernel_research_digest threw:", err);
    return 1;
  }

  if (res.isError) {
    const msg = res.content?.map((c) => c.text).join("\n") ?? "(no message)";
    console.error(`✗ kernel_research_digest returned isError:\n${msg}`);
    return 1;
  }

  const out = (res.structuredContent ?? {}) as {
    digest?: string;
    citations?: string[];
    chunks_processed?: number;
    chunks_failed?: number;
    items_truncated?: number;
    degraded?: boolean;
    tokens?: number;
  };
  const digestText = out.digest ?? "";
  const citations = out.citations ?? [];

  // ── 5. Print digest + counts ─────────────────────────────────────────────
  console.log("─ DIGEST ─────────────────────────────────────────────────────");
  console.log(digestText.trim() || "(empty digest)");
  console.log("─ COUNTS ─────────────────────────────────────────────────────");
  console.log(`  path:            ${path}`);
  console.log(`  citations:       ${citations.length}`);
  console.log(`  chunks_processed:${out.chunks_processed ?? 0}`);
  console.log(`  chunks_failed:   ${out.chunks_failed ?? 0}`);
  console.log(`  items_truncated: ${out.items_truncated ?? 0}`);
  console.log(`  degraded:        ${out.degraded ?? false}`);
  console.log(`  tokens:          ${out.tokens ?? 0}`);

  // ── 6. GROUNDING CHECK ───────────────────────────────────────────────────
  // Every `#<id>` token the digest references must be a real citation.
  //
  // We only judge tokens that LOOK like a source id (the real shape is the
  // citation shape — uuid-like or >=6 char alnum/hyphen). Pure-numeric tokens
  // (e.g. "#179" from a title) and the literal "#id" (echoed from the
  // instruction "keep #id citations") are reported as NOISE, not failures —
  // they are not the model claiming a citation. An id-SHAPED token that is not
  // in citations[] is a genuine hallucination and fails the check.
  const citationSet = new Set(citations.map(String));
  const idShaped = new Set<string>();
  const noise = new Set<string>();
  for (const m of digestText.matchAll(/#([A-Za-z0-9][A-Za-z0-9-]*)/g)) {
    const tok = m[1];
    const looksLikeId =
      /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(tok) || // uuid-like
      (/[A-Za-z]/.test(tok) && /[0-9]/.test(tok) && tok.length >= 6) || // mixed alnum id
      citationSet.has(tok); // matches a real citation exactly
    if (tok === "id" || /^\d+$/.test(tok) || !looksLikeId) noise.add(tok);
    else idShaped.add(tok);
  }
  const hallucinated = [...idShaped].filter((id) => !citationSet.has(id));

  console.log("─ GROUNDING ──────────────────────────────────────────────────");
  console.log(`  id-shaped #refs in digest: ${idShaped.size}`);
  if (noise.size > 0) {
    console.log(`  (non-citation #tokens ignored: ${[...noise].map((n) => `#${n}`).join(", ")})`);
  }
  if (idShaped.size === 0) {
    // No id-shaped refs is not a hallucination, but flag it for visibility.
    console.log("  GROUNDING: PASS (no id-shaped #references in digest to verify)");
    return 0;
  }
  if (hallucinated.length === 0) {
    console.log("  GROUNDING: PASS — every referenced #id exists in citations[]");
    return 0;
  }
  console.log(`  GROUNDING: FAIL — fabricated ids: ${hallucinated.map((h) => `#${h}`).join(", ")}`);
  return 1;
}

/** Six realistic hand-written rows so the demo always exercises map-reduce. */
function inlineFallbackRows(): Array<{ id: string; title: string }> {
  return [
    { id: "n1", title: "OpenAI releases GPT-5 with a 1M-token context window" },
    { id: "n2", title: "Anthropic ships Claude Opus 4 with extended thinking" },
    { id: "n3", title: "Google DeepMind's Gemini hits state-of-the-art on math benchmarks" },
    { id: "n4", title: "Meta open-sources Llama 4 under a permissive license" },
    { id: "n5", title: "EU AI Act enforcement begins for general-purpose models" },
    { id: "n6", title: "Mistral debuts a fast on-device model for edge inference" },
  ];
}

main()
  .then((code) => {
    teardown();
    process.exit(code);
  })
  .catch((err) => {
    console.error("Unexpected failure:", err);
    teardown();
    process.exit(1);
  });
