/**
 * brain module.
 *
 * Wires the unified semantic memory (BrainService + BrainIndexer) into the
 * kernel and exposes:
 *   * `kernel_brain_recall`   — ONE cross-module semantic search.
 *   * `kernel_brain_index`    — (re)index sources incrementally by watermark.
 *   * `kernel_brain_feedback` — apply a usage signal (autoaprendizaje).
 *   * `kernel_brain_decay`    — pull learned weights back toward baseline.
 *   * `kernel_brain_stats`    — coverage: items per kind + watermarks.
 *
 * Embeddings are built late (in services.ts), same as tool-memory — the
 * factory promise is awaited with a short race so boot never blocks.
 *
 * Auto-indexing safety: indexing embeds row text through the embeddings
 * backend, which can be thousands of rows. To avoid hammering a local
 * model unsupervised, event-driven + boot backfill indexing is OFF unless
 * `BRAIN_AUTO_INDEX=1`. The manual `kernel_brain_index` tool always works,
 * so a human can backfill one module at a time and watch it.
 */

import { z } from "zod";
import type {
  KernelModule,
  ModuleContext,
  ToolDefinition,
  ToolResult,
} from "../../core/types.js";
import { structuredResult, errorResult, fireAndForget } from "../../core/helpers.js";
import { log } from "../../core/logger.js";
import type { EmbeddingsClient } from "../../core/embeddings/index.js";
import type { DataChangedPayload } from "../../core/kernel-events.js";
import { runMigrations } from "../../core/db/migrations.js";
import { brainMigrations } from "./migrations.js";
import { BrainService } from "./service.js";
import { BrainIndexer, MODULE_TO_KINDS } from "./indexer.js";
import { defineTool, defineToolNoInput } from "../../core/tool-builder.js";

export interface BrainModule extends KernelModule {
  getService(): BrainService | null;
  getIndexer(): BrainIndexer | null;
}

export function createBrainModule(
  embeddingsFactory: () => Promise<EmbeddingsClient>,
): BrainModule {
  let service: BrainService | null = null;
  let indexer: BrainIndexer | null = null;
  let tools: ToolDefinition[] = [];
  const autoIndex = process.env.BRAIN_AUTO_INDEX === "1";

  // Coalesce data.changed storms: collect kinds, flush on a short timer.
  const pendingKinds = new Set<string>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleIndex(kinds: string[]): void {
    if (!autoIndex || !indexer) return;
    for (const k of kinds) pendingKinds.add(k);
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const batch = [...pendingKinds];
      pendingKinds.clear();
      if (indexer) fireAndForget(indexer.indexAll(batch).then(() => {}), "brain:auto-index");
    }, 2000);
  }

  function wireService(ctx: ModuleContext, embeddings: EmbeddingsClient): void {
    service = new BrainService(ctx.sqlite, embeddings);
    indexer = new BrainIndexer(ctx.sqlite, service);
    tools = buildTools(() => service, () => indexer);

    ctx.events.on(
      "data.changed",
      (payload: DataChangedPayload) => {
        const kinds = MODULE_TO_KINDS[payload.module];
        scheduleIndex(kinds ?? []); // unmapped → empty → full watermark rescan only if you pass all; keep cheap
      },
      { module: "brain", description: "incremental re-index on data change" },
    );

    if (autoIndex) {
      log.info("brain: BRAIN_AUTO_INDEX=1 → running initial backfill in background");
      fireAndForget(indexer.indexAll().then((r) => log.info(`brain: backfill indexed ${r.indexed} items`)), "brain:backfill");
    } else {
      log.info("brain: auto-index off (set BRAIN_AUTO_INDEX=1 to enable). Use kernel_brain_index to backfill.");
    }
  }

  return {
    name: "brain",
    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "brain", brainMigrations);
      let embeddings: EmbeddingsClient | null = null;
      try {
        const timeout = new Promise<null>((res) => setTimeout(() => res(null), 250));
        embeddings = await Promise.race([embeddingsFactory(), timeout]);
      } catch {
        embeddings = null;
      }
      if (embeddings) {
        wireService(ctx, embeddings);
      } else {
        // Late hookup — embeddings model still loading. Same factory, no race.
        embeddingsFactory()
          .then((late) => wireService(ctx, late))
          .catch(() => {
            log.debug("brain: embeddings never came online — recall disabled");
          });
      }
    },
    getTools(): ToolDefinition[] { return tools; },
    getService(): BrainService | null { return service; },
    getIndexer(): BrainIndexer | null { return indexer; },
    async shutdown() {
      if (flushTimer) clearTimeout(flushTimer);
    },
  };
}

// ── Tools ────────────────────────────────────────────────────────────

const RecallInput = z.object({
  query: z.string().min(1).describe("Free-text query. Searches the unified space across all modules."),
  kinds: z.array(z.string()).optional().describe("Restrict to item kinds: task, note, contact, comm, reminder, event."),
  limit: z.number().int().positive().max(50).default(8),
  min_similarity: z.number().min(0).max(1).default(0.25),
  resolve_rows: z.boolean().default(true).describe("Also fetch the exact source row for each hit."),
  hybrid: z.boolean().default(true).describe("Blend dense embedding similarity with lexical overlap (rescues exact-term matches the embedding misses)."),
  cosine_weight: z.number().min(0).max(1).default(0.7).describe("Hybrid weight on the dense leg; lexical gets 1 − this."),
});

const IndexInput = z.object({
  kinds: z.array(z.string()).optional().describe("Restrict indexing to these kinds. Omit to index all sources."),
});

const FeedbackInput = z.object({
  item_id: z.string().min(1),
  signal: z.enum(["open", "co_open", "correct", "ignore"]).describe("Usage signal driving the weight nudge."),
});

const DecayInput = z.object({
  rate: z.number().min(0).max(1).default(0.1),
});

function buildTools(
  getSvc: () => BrainService | null,
  getIndexer: () => BrainIndexer | null,
): ToolDefinition[] {
  return [
    defineTool({
      name: "kernel_brain_recall",
      description:
        "Unified semantic recall across ALL modules — tasks, notes, contacts, " +
        "communications, reminders, calendar events — in one ranked result. " +
        "Use this to surface everything related to a topic regardless of which " +
        "module it lives in. Ranking blends embedding similarity with a learned " +
        "per-item weight that adapts to how you use results.",
      schema: RecallInput,
      outputSchema: z.unknown(),
      tags: ["brain", "memory", "search", "semantic"],
      cost: { tokens_p50: 0, usd_p50: 0, latency_p50_ms: 60, reversible: true, cacheable: false },
      async handler(a): Promise<ToolResult> {
        const svc = getSvc();
        if (!svc) return structuredResult({ enabled: false, results: [] });
        const hits = await svc.recall({
          query: a.query,
          kinds: a.kinds,
          limit: a.limit,
          minSimilarity: a.min_similarity,
          resolveRows: a.resolve_rows,
          hybrid: a.hybrid,
          cosineWeight: a.cosine_weight,
        });
        return structuredResult({
          enabled: true,
          results: hits.map((h) => ({
            item_id: h.item.id,
            kind: h.item.kind,
            source_table: h.item.source_table,
            source_id: h.item.source_id,
            text: h.item.text,
            similarity: Number(h.similarity.toFixed(4)),
            score: Number(h.score.toFixed(4)),
            weight: h.item.weight,
            row: h.row ?? undefined,
          })),
        });
      },
    }),
    defineTool({
      name: "kernel_brain_index",
      description:
        "Index (or incrementally refresh) module rows into the unified semantic " +
        "space. Only rows changed since the last run are touched (watermark). " +
        "Pass `kinds` to backfill one module at a time. Embeds row text, so run " +
        "it deliberately when the embeddings backend is healthy.",
      schema: IndexInput,
      outputSchema: z.object({
        indexed: z.number().int(),
        removed: z.number().int(),
        per_kind: z.record(z.string(), z.number()),
      }),
      tags: ["brain", "memory", "index"],
      sideEffects: ["brain.items.indexed:N"],
      cost: { tokens_p50: 0, usd_p50: 0, latency_p50_ms: 500, reversible: true, cacheable: false },
      async handler(a): Promise<ToolResult> {
        const idx = getIndexer();
        if (!idx) return errorResult("brain not available (embeddings offline)");
        const res = await idx.indexAll(a.kinds);
        return structuredResult({ indexed: res.indexed, removed: res.removed, per_kind: res.perKind });
      },
    }),
    defineTool({
      name: "kernel_brain_feedback",
      description:
        "Record a usage signal for a recalled item to teach the brain. " +
        "`open`/`correct` promote it, `ignore` demotes it. This is the " +
        "autoaprendizaje loop — future recalls rank adapted to your behaviour.",
      schema: FeedbackInput,
      outputSchema: z.object({ item_id: z.string(), weight: z.number().nullable() }),
      tags: ["brain", "memory", "learning"],
      sideEffects: ["brain.item.reinforced:1"],
      cost: { tokens_p50: 0, usd_p50: 0, latency_p50_ms: 10, reversible: false, cacheable: false },
      async handler(a): Promise<ToolResult> {
        const svc = getSvc();
        if (!svc) return errorResult("brain not available");
        const weight = svc.reinforce(a.item_id, a.signal);
        if (weight === null) return errorResult(`unknown item_id: ${a.item_id}`);
        return structuredResult({ item_id: a.item_id, weight });
      },
    }),
    defineTool({
      name: "kernel_brain_decay",
      description:
        "Maintenance: pull every learned weight a fraction back toward the 1.0 " +
        "baseline so stale boosts/penalties fade. Run periodically.",
      schema: DecayInput,
      outputSchema: z.object({ adjusted: z.number().int() }),
      tags: ["brain", "memory", "maintenance"],
      cost: { tokens_p50: 0, usd_p50: 0, latency_p50_ms: 20, reversible: false, cacheable: false },
      async handler(a): Promise<ToolResult> {
        const svc = getSvc();
        if (!svc) return errorResult("brain not available");
        return structuredResult({ adjusted: svc.decayWeights(a.rate) });
      },
    }),
    defineToolNoInput({
      name: "kernel_brain_stats",
      description: "Coverage of the unified space: total items, count per kind, and per-source watermarks.",
      outputSchema: z.unknown(),
      tags: ["brain", "memory", "stats"],
      cost: { tokens_p50: 0, usd_p50: 0, latency_p50_ms: 10, reversible: true, cacheable: true },
      async handler(): Promise<ToolResult> {
        const svc = getSvc();
        if (!svc) return structuredResult({ enabled: false });
        return structuredResult({ enabled: true, ...svc.stats() });
      },
    }),
  ];
}
