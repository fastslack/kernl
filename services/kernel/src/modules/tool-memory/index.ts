/**
 * tool-memory module.
 *
 * Wires the ToolMemoryService into the kernel and exposes three tools:
 *   * `kernel_memory_search` — semantic search ("what did I do similar
 *     to this before?").
 *   * `kernel_memory_purge`  — GDPR-style cleanup, scoped to one owner.
 *   * `kernel_memory_export` — pull every row for an owner as JSON.
 *
 * The server-side index hook lives in `src/server.ts`'s `executeToolCall`
 * — it calls `service.record(...)` after a successful tool dispatch.
 * Surfaces in `_meta.mtw.memory.similar_past_calls` when matches exist.
 */

import { z } from "zod";
import type {
  KernelModule,
  ModuleContext,
  ToolDefinition,
  ToolResult,
} from "../../core/types.js";
import { errorResult, structuredResult } from "../../core/helpers.js";
import { getRequestContext } from "../../core/request-context.js";
import { runMigrations } from "../../core/db/migrations.js";
import { toolMemoryMigrations } from "./migrations.js";
import { ToolMemoryService } from "./service.js";
import type { EmbeddingsClient } from "../../core/embeddings/index.js";
import { defineTool } from "../../core/tool-builder.js";

export interface ToolMemoryModule extends KernelModule {
  getService(): ToolMemoryService | null;
}

export function createToolMemoryModule(embeddingsFactory: () => Promise<EmbeddingsClient>): ToolMemoryModule {
  let service: ToolMemoryService | null = null;
  let tools: ToolDefinition[] = [];

  return {
    name: "tool-memory",
    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "tool-memory", toolMemoryMigrations);
      // The embeddings client is constructed AFTER registry.initializeAll()
      // returns (see bootstrap() in src/index.ts), so the factory's promise
      // would never resolve during init — that used to deadlock the whole
      // kernel boot. We race against a short timeout: if embeddings come in
      // late, the service is wired lazily on the first .getService() that
      // re-checks. If they never come, tool-memory degrades to a no-op
      // exactly like the catch path was meant to.
      let embeddings: EmbeddingsClient | null = null;
      try {
        const timeout = new Promise<null>((res) => setTimeout(() => res(null), 250));
        embeddings = await Promise.race([embeddingsFactory(), timeout]);
      } catch {
        embeddings = null;
      }
      if (embeddings) {
        service = new ToolMemoryService(ctx.sqlite, embeddings);
        tools = buildTools(() => service);
      } else {
        // Embeddings weren't ready in time — schedule a late hookup. Same
        // factory, no timeout this time. Whatever wires the dashboard / chat
        // service still gets a working tool-memory once the model loads.
        service = null;
        embeddingsFactory()
          .then((late) => {
            service = new ToolMemoryService(ctx.sqlite, late);
            // Note: tools[] stays empty here — it was captured at boot and
            // downstream consumers (chat/agents) read getService() directly.
          })
          .catch(() => {
            // Embeddings genuinely failed — degrade silently.
            service = null;
          });
      }
    },
    getTools(): ToolDefinition[] { return tools; },
    getService(): ToolMemoryService | null { return service; },
    async shutdown() {},
  };
}

function buildTools(get: () => ToolMemoryService | null): ToolDefinition[] {
  return [buildSearch(get), buildPurge(get), buildExport(get)];
}

const SearchInput = z.object({
  tool: z.string().describe("Tool name to bias the search toward (still matches across tools)."),
  args: z.record(z.string(), z.unknown()).default({}).describe("Same args you'd pass to the tool — searches by their semantic shape."),
  limit: z.number().int().positive().max(50).default(5),
  min_similarity: z.number().min(0).max(1).default(0.85),
});

function buildSearch(get: () => ToolMemoryService | null): ToolDefinition {
  return defineTool({
    name: "kernel_memory_search",
    description:
      "Search past tool calls by semantic similarity (tool + args). Returns " +
      "ranked matches with input/output JSON and the per-call receipt id when " +
      "attestation was on. Scoped to the calling agent/user — never leaks " +
      "across owners.",
    schema: SearchInput,
    outputSchema: z.unknown(),
    tags: ["meta", "memory", "search"],
    cost: { tokens_p50: 0, usd_p50: 0, latency_p50_ms: 50, reversible: true, cacheable: false },
    async handler({ tool, args: input, limit, min_similarity }): Promise<ToolResult> {
      const svc = get();
      if (!svc) return structuredResult({ enabled: false, results: [] });
      const ctx = getRequestContext();
      const results = await svc.findSimilar({
        tool,
        input,
        ownerAgentId: ctx.callerAgentId,
        limit,
        minSimilarity: min_similarity,
      });
      return structuredResult({
        enabled: true,
        results: results.map((r) => ({
          tool: r.record.tool,
          similarity: r.record.similarity,
          input: tryParse(r.record.input_json),
          output: tryParse(r.record.output_json),
          receipt_id: r.record.receipt_id,
          succeeded: r.record.succeeded === 1,
          created_at: r.record.created_at,
        })),
      });
    },
  });
}

const PurgeInput = z.object({
  owner_agent_id: z.string().default(""),
  confirm: z.literal(true).describe("Must be true. Acknowledges the deletion is irreversible."),
});

function buildPurge(get: () => ToolMemoryService | null): ToolDefinition {
  return defineTool({
    name: "kernel_memory_purge",
    description:
      "Delete every tool-memory row for an owner_agent_id. GDPR-compliant: " +
      "no soft-delete, no recovery. Pass `confirm: true` to acknowledge.",
    schema: PurgeInput,
    outputSchema: z.object({ deleted: z.number().int() }),
    tags: ["meta", "memory", "privacy"],
    sideEffects: ["memory.rows.deleted:N"],
    cost: { tokens_p50: 0, usd_p50: 0, latency_p50_ms: 20, reversible: false, cacheable: false },
    async handler({ owner_agent_id }): Promise<ToolResult> {
      const svc = get();
      if (!svc) return errorResult("memory service not available");
      const deleted = svc.purge(owner_agent_id);
      return structuredResult({ deleted });
    },
  });
}

const ExportInput = z.object({
  owner_agent_id: z.string().default(""),
});

function buildExport(get: () => ToolMemoryService | null): ToolDefinition {
  return defineTool({
    name: "kernel_memory_export",
    description:
      "Export every tool-memory row for an owner_agent_id as JSON. " +
      "Embeddings are NOT included — they're recoverable from input_json " +
      "by re-embedding.",
    schema: ExportInput,
    outputSchema: z.unknown(),
    tags: ["meta", "memory", "export", "privacy"],
    cost: { tokens_p50: 0, usd_p50: 0, latency_p50_ms: 30, reversible: true, cacheable: false },
    async handler({ owner_agent_id }): Promise<ToolResult> {
      const svc = get();
      if (!svc) return errorResult("memory service not available");
      const rows = svc.export(owner_agent_id);
      return structuredResult({ rows, total: rows.length });
    },
  });
}

function tryParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}
