/**
 * graph-query module — agents read the graph (service.ts, gate.ts).
 *
 *   * `kernel_graph_schema` — what the graph holds and how it connects.
 *   * `kernel_graph_query`  — a read-only Cypher statement, checked first.
 *   * `kernel_graph_ask`    — a question in plain words, answered through a
 *     generated query that corrects itself from the checks' errors.
 */

import { z } from "zod";
import type { KernelModule, ModuleContext, ToolDefinition, ToolResult } from "../../core/types.js";
import { errorResult, structuredResult } from "../../core/helpers.js";
import { defineTool, defineToolNoInput } from "../../core/tool-builder.js";
import { llm } from "../../core/llm/client.js";
import { GraphQueryService } from "./service.js";

export function createGraphQueryModule(): KernelModule {
  let service: GraphQueryService | null = null;
  const off = () => errorResult("The graph is off.");

  const tools: ToolDefinition[] = [
    defineToolNoInput({
      name: "kernel_graph_schema",
      description:
        "What Kernl's graph holds: node labels with counts and properties, which relationships connect " +
        "which labels, and the vector and full-text search indexes. Read it before kernel_graph_query.",
      outputSchema: z.unknown(),
      tags: ["graph", "read"],
      cost: { tokens_p50: 0, usd_p50: 0, latency_p50_ms: 200, reversible: true, cacheable: true },
      async handler(): Promise<ToolResult> {
        if (!service) return off();
        try {
          const s = await service.schema();
          return structuredResult({ labels: s.labels, relationships: s.relationships, indexes: s.indexes });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    }),
    defineTool({
      name: "kernel_graph_query",
      description:
        "Run one READ-ONLY Cypher query on Kernl's graph and get rows back. It is checked before it runs: " +
        "no writing, only db.* read procedures, bounded variable-length paths (at most 6 hops), connected " +
        "patterns, and labels and relationship types that exist (wrong ones come back with suggestions). " +
        "Rows are capped by `limit`.",
      schema: z.object({
        cypher: z.string().min(1),
        params: z.record(z.string(), z.unknown()).optional().describe("Query parameters ($name)."),
        limit: z.number().int().positive().max(500).default(50),
      }),
      outputSchema: z.unknown(),
      tags: ["graph", "read"],
      cost: { tokens_p50: 0, usd_p50: 0, latency_p50_ms: 100, reversible: true, cacheable: false },
      async handler(a): Promise<ToolResult> {
        if (!service) return off();
        const out = await service.query(a.cypher, { params: a.params, limit: a.limit });
        return out.ok ? structuredResult(out) : errorResult(`${out.error}${out.hints?.length ? `\nHints: ${out.hints.join(" ")}` : ""}`);
      },
    }),
    defineTool({
      name: "kernel_graph_ask",
      description:
        "Ask Kernl's graph a question in plain words (\"which people did I email most last month?\", " +
        "\"what tasks depend on the report?\"). It writes a read-only query from the graph's schema, runs " +
        "it, fixes it from its own errors, and returns the rows with the query it used.",
      schema: z.object({
        question: z.string().min(3),
        limit: z.number().int().positive().max(200).default(30),
      }),
      outputSchema: z.unknown(),
      tags: ["graph", "read", "llm"],
      cost: { tokens_p50: 1500, usd_p50: 0.002, latency_p50_ms: 3000, reversible: true, cacheable: false },
      async handler(a): Promise<ToolResult> {
        if (!service) return off();
        try {
          const out = await service.ask(
            a.question,
            async (system, user) =>
              (await llm().chat({ system, user, maxTokens: 600, temperature: 0, json: true, caller: "graph-query:ask" })).text,
            { limit: a.limit },
          );
          return out.ok ? structuredResult(out) : errorResult(`Could not answer from the graph after ${out.attempts} tries: ${out.error}${out.cypher ? `\nLast query: ${out.cypher}` : ""}`);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    }),
  ];

  return {
    name: "graph-query",
    async initialize(ctx: ModuleContext) {
      service = new GraphQueryService(() => ctx.graph);
    },
    getTools(): ToolDefinition[] {
      return tools;
    },
    async shutdown() {},
  };
}
