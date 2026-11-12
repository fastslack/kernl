/**
 * graph-analytics module — PageRank, communities, components and betweenness
 * on whatever graph engine is active (service.ts says where each one runs).
 *
 *   * `kernel_graph_analyze` — run one over the labels you name and write the
 *     result onto the nodes, so graph queries and the dashboard can use it.
 */
import { z } from "zod";
import type { KernelModule, ModuleContext, ToolDefinition, ToolResult } from "../../core/types.js";
import { errorResult, structuredResult } from "../../core/helpers.js";
import { defineTool } from "../../core/tool-builder.js";
import { ALGORITHMS, GraphAnalytics, MAX_NODES, PROPERTY } from "./service.js";

export function createGraphAnalyticsModule(): KernelModule {
  let service: GraphAnalytics | null = null;
  const tools: ToolDefinition[] = [
    defineTool({
      name: "kernel_graph_analyze",
      description:
        "Graph analytics over the labels you name (and, optionally, only some relationship types): " +
        "`pagerank` (who is central), `communities` (Louvain groups), `components` (what is connected at all), " +
        "`betweenness` (who bridges groups). The result is written on each node as " +
        Object.entries(PROPERTY).map(([a, p]) => `${p} (${a})`).join(", ") +
        " — use it afterwards in kernel_graph_query, e.g. ORDER BY p.pageRank DESC. " +
        `Runs on Graph Data Science when the graph has it or GDS_REMOTE_URI points at one (only numbered nodes and edges are sent), otherwise in the kernel, up to ${MAX_NODES} nodes.`,
      schema: z.object({
        algorithm: z.enum(ALGORITHMS),
        labels: z.array(z.string()).min(1).max(20).describe("Node labels to include, e.g. [\"Person\"]."),
        relationships: z.array(z.string()).max(20).optional().describe("Relationship types to follow; all by default."),
        engine: z.enum(["auto", "gds", "remote", "local"]).default("auto"),
        write: z.boolean().default(true).describe("Write the result on the nodes."),
        top: z.number().int().positive().max(100).default(10),
      }),
      outputSchema: z.unknown(),
      tags: ["graph", "analytics"],
      cost: { tokens_p50: 0, usd_p50: 0, latency_p50_ms: 3000, reversible: true, cacheable: false },
      async handler(a): Promise<ToolResult> {
        if (!service) return errorResult("graph analytics not available");
        try {
          return structuredResult(await service.analyze(a));
        } catch (err) {
          return errorResult(err instanceof Error ? err.message.split("\n")[0] : String(err));
        }
      },
    }),
  ];

  return {
    name: "graph-analytics",
    async initialize(ctx: ModuleContext) {
      service = new GraphAnalytics(() => ctx.graph);
    },
    getTools(): ToolDefinition[] {
      return tools;
    },
    async shutdown() {
      service = null;
    },
  };
}
