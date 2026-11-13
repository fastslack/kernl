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
 *   * `kernel_brain_ask`      — "what do I know about X?": brain, chat
 *     memories, agent learnings and graph entities in one fused answer,
 *     each result with what it is connected to (ask.ts).
 *   * `kernel_facts_assert` / `_retract` / `_query` — facts with two
 *     timelines: when each was true, and when Kernl knew it (facts.ts).
 *   * `kernel_facts_explain` — what Kernl believed at the moment of a
 *     decision against what was true then, who wrote it, and whether a
 *     difference was late information or a wrong fact (explain.ts).
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
import { LocalEmbeddings, type EmbeddingsClient } from "../../core/embeddings/index.js";
import type { DataChangedPayload } from "../../core/kernel-events.js";
import { runMigrations } from "../../core/db/migrations.js";
import { brainMigrations } from "./migrations.js";
import { BrainService } from "./service.js";
import { BrainIndexer, MODULE_TO_KINDS } from "./indexer.js";
import { askMemory, type AskDeps } from "./ask.js";
import { FactStore, type Fact } from "./facts.js";
import { explainBelief } from "./explain.js";
import { getProvenanceService } from "../provenance/service.js";
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
  let embeddingsClient: EmbeddingsClient | null = null;
  // Chat memories are written with the bundled local model (chat/service.ts).
  let chatEmbeddings: EmbeddingsClient | null = null;
  let askDeps: AskDeps | null = null;
  let facts: FactStore | null = null;
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
    embeddingsClient = embeddings;
    tools = buildTools(() => service, () => indexer, () => askDeps, () => facts);

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
      askDeps = {
        db: ctx.sqlite,
        brain: () => service,
        embeddings: () => embeddingsClient,
        chatEmbeddings: () => (chatEmbeddings ??= new LocalEmbeddings()),
        graph: () => ctx.graph,
      };
      facts = new FactStore(ctx.sqlite, () => ctx.graph);
      // Asking works before the embeddings backend is up (text and graph legs).
      tools = buildTools(() => service, () => indexer, () => askDeps, () => facts);
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
    getGraphBackfill() {
      const store = facts;
      // v2: re-projects every fact with native datetimes and ended_at.
      return store ? { name: "facts", version: 2, order: 40, run: (g) => store.backfill(g) } : undefined;
    },
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

const AskInput = z.object({
  query: z.string().min(1).describe("Who or what to ask about, in free text (\"Ada\", \"the Q4 report\", \"deploy failures\")."),
  limit: z.number().int().positive().max(30).default(10),
  related: z.number().int().min(0).max(20).default(5).describe("Neighbours to show per result from the graph; 0 to skip."),
});

const SUBJECT_HELP =
  'Who or what the fact is about. A node reference ("Person:<contact id>", "Task:<id>") links it in the graph; ' +
  '"me" for the user; otherwise a plain name.';

const AssertInput = z.object({
  subject: z.string().min(1).describe(SUBJECT_HELP),
  subject_name: z.string().optional().describe("Readable name of the subject, when `subject` is a reference."),
  predicate: z.string().min(1).describe('What is said about it, short and reusable: "works_at", "lives_in", "prefers", "birthday".'),
  object: z.string().min(1).describe("The value."),
  multi: z.boolean().default(false).describe("Several values can be true at once (speaks, likes). Default: a new value replaces the old one."),
  mode: z.enum(["change", "correction"]).default("change").describe(
    "change: the world changed — the old value stays in the history, true until this one began. " +
    "correction: the old value was wrong — it is replaced over the same span.",
  ),
  valid_from: z.string().optional().describe("When it became true (ISO date or time). Default now."),
  confidence: z.number().min(0).max(1).default(0.8),
  source: z.string().optional().describe("Where it came from: chat, agent, mail, user…"),
  source_ref: z.string().optional().describe("Id of the message, run or row it came from."),
});

const RetractInput = z.object({
  id: z.string().min(1),
  how: z.enum(["ended", "wrong"]).default("ended").describe("ended: it was true until `at`. wrong: it never was."),
  at: z.string().optional().describe("When it stopped being true (ISO). Default now."),
});

const FactsQueryInput = z.object({
  subject: z.string().optional(),
  predicate: z.string().optional(),
  text: z.string().optional().describe("Match in the subject name, predicate or value."),
  as_of: z.string().optional().describe("What was true at this moment (ISO). Default now."),
  known_at: z.string().optional().describe("As Kernl believed it at this moment (ISO). Default now."),
  history: z.boolean().default(false).describe("Every value ever recorded, including ended and corrected ones."),
  limit: z.number().int().positive().max(500).default(50),
});

const ExplainInput = z.object({
  subject: z.string().optional().describe('A fact subject, e.g. "Person:<id>".'),
  name: z.string().optional().describe("Or a name to find the subject by."),
  predicate: z.string().optional().describe("Only this predicate (works_at, email…)."),
  at: z.string().optional().describe("The moment of the decision (ISO)."),
  action_ref: z.string().optional().describe("Or the id of what the action produced or touched; its first recorded call gives the moment."),
});

function factView(f: Fact) {
  return {
    id: f.id,
    subject: f.subject,
    subject_name: f.subject_name || undefined,
    predicate: f.predicate,
    object: f.object,
    valid_from: f.valid_from,
    valid_to: f.valid_to ?? undefined,
    recorded_at: f.recorded_at,
    superseded_at: f.superseded_at ?? undefined,
    status: f.superseded_at ? "corrected" : f.valid_to ? "ended" : "current",
    confidence: f.confidence,
    source: f.source || undefined,
  };
}

const DecayInput = z.object({
  rate: z.number().min(0).max(1).default(0.1),
});

function buildTools(
  getSvc: () => BrainService | null,
  getIndexer: () => BrainIndexer | null,
  getAskDeps: () => AskDeps | null,
  getFacts: () => FactStore | null,
): ToolDefinition[] {
  return [
    defineTool({
      name: "kernel_facts_assert",
      description:
        "Record a fact about a person, thing or the user — subject, predicate, value — with when it " +
        "became true. A new value for the same subject and predicate ends the old one (mode change) " +
        "or replaces it as a mistake (mode correction); the history is kept, so the memory does not " +
        "hold two contradicting answers. Saying the same thing again changes nothing.",
      schema: AssertInput,
      outputSchema: z.unknown(),
      tags: ["brain", "memory", "facts"],
      sideEffects: ["facts.recorded:1"],
      cost: { tokens_p50: 0, usd_p50: 0, latency_p50_ms: 10, reversible: true, cacheable: false },
      async handler(a): Promise<ToolResult> {
        const store = getFacts();
        if (!store) return errorResult("facts not available");
        const out = store.assert({
          subject: a.subject, subjectName: a.subject_name, predicate: a.predicate, object: a.object,
          multi: a.multi, mode: a.mode, validFrom: a.valid_from, confidence: a.confidence,
          source: a.source, sourceRef: a.source_ref,
        });
        return structuredResult({
          status: out.status,
          fact: factView(out.fact),
          ended: out.ended.map(factView),
          corrected: out.superseded.map(factView),
        });
      },
    }),
    defineTool({
      name: "kernel_facts_retract",
      description: "A fact no longer holds (how=ended, from `at`) or never did (how=wrong). It stays in the history.",
      schema: RetractInput,
      outputSchema: z.unknown(),
      tags: ["brain", "memory", "facts"],
      sideEffects: ["facts.retracted:1"],
      cost: { tokens_p50: 0, usd_p50: 0, latency_p50_ms: 10, reversible: false, cacheable: false },
      async handler(a): Promise<ToolResult> {
        const store = getFacts();
        if (!store) return errorResult("facts not available");
        const f = store.retract(a.id, a.how, a.at);
        return f ? structuredResult({ fact: factView(f) }) : errorResult(`unknown fact: ${a.id}`);
      },
    }),
    defineTool({
      name: "kernel_facts_query",
      description:
        "Facts that are true now — or were true at `as_of`, or as Kernl believed them at `known_at`. " +
        "`history` lists every value ever recorded with when it held and whether it was corrected.",
      schema: FactsQueryInput,
      outputSchema: z.unknown(),
      tags: ["brain", "memory", "facts"],
      cost: { tokens_p50: 0, usd_p50: 0, latency_p50_ms: 10, reversible: true, cacheable: false },
      async handler(a): Promise<ToolResult> {
        const store = getFacts();
        if (!store) return errorResult("facts not available");
        const rows = store.query({
          subject: a.subject, predicate: a.predicate, text: a.text,
          asOf: a.as_of, knownAt: a.known_at, history: a.history, limit: a.limit,
        });
        return structuredResult({ facts: rows.map(factView) });
      },
    }),
    defineTool({
      name: "kernel_facts_explain",
      description:
        "Why did Kernl (or an agent) act that way? Give the person or thing (subject ref or name) and the " +
        "moment of the decision — `at`, or `action_ref`, the id of what the action produced or touched " +
        "(an email, a task…). Returns what Kernl believed then against what is now known to have been " +
        "true then, fact by fact, who wrote each belief and from what source, and a verdict: consistent, " +
        "late_information (the world changed but Kernl learned it after the decision) or wrong_belief " +
        "(the stored fact was later corrected as a mistake).",
      schema: ExplainInput,
      outputSchema: z.unknown(),
      tags: ["brain", "memory", "facts", "audit", "provenance"],
      cost: { tokens_p50: 0, usd_p50: 0, latency_p50_ms: 10, reversible: true, cacheable: false },
      async handler(a): Promise<ToolResult> {
        const store = getFacts();
        if (!store) return errorResult("facts not available");
        try {
          return structuredResult(explainBelief(store, getProvenanceService(), {
            subject: a.subject, name: a.name, predicate: a.predicate, at: a.at, actionRef: a.action_ref,
          }));
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    }),
    defineTool({
      name: "kernel_brain_ask",
      description:
        "What do I know about X? Searches every memory at once — indexed tasks, " +
        "notes, contacts and mail (brain), past chat messages, what agents have " +
        "learned, and the people, tasks, mail, events and products in the graph — " +
        "by meaning and by words, merges the findings into one ranked list, and " +
        "shows what each result is connected to. Use it before answering a " +
        "question about a person, project or topic.",
      schema: AskInput,
      outputSchema: z.unknown(),
      tags: ["brain", "memory", "search", "graph"],
      cost: { tokens_p50: 0, usd_p50: 0, latency_p50_ms: 150, reversible: true, cacheable: false },
      async handler(a): Promise<ToolResult> {
        const deps = getAskDeps();
        if (!deps) return errorResult("brain not initialised");
        return structuredResult(await askMemory(deps, { query: a.query, limit: a.limit, related: a.related }));
      },
    }),
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
