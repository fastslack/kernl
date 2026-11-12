/**
 * graph-query module — agents read the graph (service.ts, gate.ts).
 *
 *   * `kernel_graph_schema` — what the graph holds and how it connects.
 *   * `kernel_graph_query`  — a read-only Cypher statement, checked first.
 *   * `kernel_graph_ask`    — a question in plain words, answered through a
 *     generated query that corrects itself from the checks' errors.
 *   * `kernel_graph_scratch` / `kernel_graph_slice` / `kernel_graph_scratch_drop`
 *     — a private in-memory graph per run where an agent may write, and a
 *     read-only slice of the main graph copied into it or handed back as
 *     JSON (scratch.ts).
 */

import { z } from "zod";
import type { KernelModule, ModuleContext, ToolDefinition, ToolResult } from "../../core/types.js";
import { errorResult, structuredResult } from "../../core/helpers.js";
import { defineTool } from "../../core/tool-builder.js";
import { llm } from "../../core/llm/client.js";
import { getRequestContext } from "../../core/request-context.js";
import { log } from "../../core/logger.js";
import { RelateGraphDriver, relateClientInstalled } from "../../core/db-drivers/builtins/relate-graph-driver.js";
import { GraphQueryService, plain } from "./service.js";
import { MAX_NODES, ScratchGraphs, collectSlice } from "./scratch.js";
import { type ClientPolicy, clientPolicy, filterSchema } from "./privacy.js";

/**
 * The privacy policy when the caller is an outside MCP client, or undefined
 * for Kernl's own agents (a run or an agent in the request context, or the
 * executor's injected id — never settable by a client).
 */
function policyFor(args: Record<string, unknown>): ClientPolicy | undefined {
  return scratchOwner(args) === "client" ? clientPolicy() : undefined;
}
const notForClients = (p: ClientPolicy) =>
  errorResult(p.access === "off" ? "The graph is not shared with MCP clients (GRAPH_MCP_ACCESS=off)." : "This MCP client may only read the graph's schema (GRAPH_MCP_ACCESS=schema).");

/** Whose scratch graph: the run, else the agent, else the MCP client. */
function scratchOwner(args: Record<string, unknown>): string {
  const ctx = getRequestContext();
  if (ctx.callerRunId) return `run:${ctx.callerRunId}`;
  const agent = ctx.callerAgentId || (typeof args.__caller_agent_id === "string" ? args.__caller_agent_id : "");
  return agent ? `agent:${agent}` : "client";
}

export function createGraphQueryModule(): KernelModule {
  let service: GraphQueryService | null = null;
  const off = () => errorResult("The graph is off.");
  const scratch = relateClientInstalled()
    ? new ScratchGraphs(async () => {
        const g = new RelateGraphDriver();
        g.configure({ path: ":memory:", memoryLimit: "256mib" });
        await g.start();
        return g;
      })
    : null;
  const noScratch = () => errorResult("Scratch graphs need the embedded graph engine (Relate), which is not installed.");
  const fail = (err: unknown) => errorResult(err instanceof Error ? err.message.split("\n")[0] : String(err));

  const tools: ToolDefinition[] = [
    defineTool({
      name: "kernel_graph_schema",
      schema: z.object({}),
      description:
        "What Kernl's graph holds: node labels with counts and properties, which relationships connect " +
        "which labels, and the vector and full-text search indexes. Read it before kernel_graph_query.",
      outputSchema: z.unknown(),
      tags: ["graph", "read"],
      cost: { tokens_p50: 0, usd_p50: 0, latency_p50_ms: 200, reversible: true, cacheable: true },
      async handler(a): Promise<ToolResult> {
        if (!service) return off();
        const policy = policyFor(a);
        if (policy?.access === "off") return notForClients(policy);
        try {
          const s = policy ? filterSchema(await service.schema(), policy) : await service.schema();
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
        const policy = policyFor(a);
        if (policy && policy.access !== "read") return notForClients(policy);
        const out = await service.query(a.cypher, { params: a.params, limit: a.limit, policy });
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
        const policy = policyFor(a);
        if (policy && policy.access !== "read") return notForClients(policy);
        try {
          const out = await service.ask(
            a.question,
            async (system, user) =>
              (await llm().chat({ system, user, maxTokens: 600, temperature: 0, json: true, caller: "graph-query:ask" })).text,
            { limit: a.limit, policy },
          );
          return out.ok ? structuredResult(out) : errorResult(`Could not answer from the graph after ${out.attempts} tries: ${out.error}${out.cypher ? `\nLast query: ${out.cypher}` : ""}`);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    }),
    defineTool({
      name: "kernel_graph_scratch",
      description:
        "Run Cypher — reads AND writes — in your own private, in-memory scratch graph: a working space for plans, dependency maps or " +
        "a slice of the main graph you want to reshape (see kernel_graph_slice). It belongs to your run, nobody else sees it, and it is " +
        `wiped when the run ends or after 30 idle minutes. At most ${MAX_NODES} nodes; no LOAD CSV, no apoc/gds/dbms. The main graph is never touched.`,
      schema: z.object({
        cypher: z.string().min(1),
        params: z.record(z.string(), z.unknown()).optional(),
        limit: z.number().int().positive().max(1000).default(100),
      }),
      outputSchema: z.unknown(),
      tags: ["graph", "scratch"],
      cost: { tokens_p50: 0, usd_p50: 0, latency_p50_ms: 20, reversible: true, cacheable: false },
      async handler(a): Promise<ToolResult> {
        if (!scratch) return noScratch();
        const owner = scratchOwner(a);
        const policy = policyFor(a);
        if (policy?.access === "off") return notForClients(policy);
        try {
          const r = await scratch.run(owner, a.cypher, a.params ?? {});
          const rows = r.records.slice(0, a.limit).map((rec) => plain(rec.toObject()) as Record<string, unknown>);
          return structuredResult({ rows, truncated: r.records.length > a.limit || undefined, counters: r.summary?.counters, graph: await scratch.stats(owner) });
        } catch (err) {
          return fail(err);
        }
      },
    }),
    defineTool({
      name: "kernel_graph_slice",
      description:
        "Take a slice of Kernl's main graph with a READ-ONLY query that returns nodes, relationships or paths " +
        "(e.g. `MATCH p = (:Person {name: $n})-[*1..2]-() RETURN p`), checked like kernel_graph_query. " +
        "`into: \"scratch\"` (default) copies it into your scratch graph, keeping labels and properties, with `_src` set to the original's " +
        "element id; `into: \"json\"` returns it as nodes and relationships, for a sandboxed agent or a file. Embeddings are left out.",
      schema: z.object({
        cypher: z.string().min(1),
        params: z.record(z.string(), z.unknown()).optional(),
        rows: z.number().int().positive().max(2000).default(500).describe("Most rows the query may return."),
        into: z.enum(["scratch", "json"]).default("scratch"),
      }),
      outputSchema: z.unknown(),
      tags: ["graph", "read", "scratch"],
      cost: { tokens_p50: 0, usd_p50: 0, latency_p50_ms: 200, reversible: true, cacheable: false },
      async handler(a): Promise<ToolResult> {
        if (!service) return off();
        const policy = policyFor(a);
        if (policy && policy.access !== "read") return notForClients(policy);
        const out = await service.query(a.cypher, { params: a.params, limit: a.rows, raw: true, timeoutMs: 15_000, policy });
        if (!out.ok) return errorResult(`${out.error}${out.hints?.length ? `\nHints: ${out.hints.join(" ")}` : ""}`);
        const slice = collectSlice(out.rows ?? []);
        if (!slice.nodes.length) return errorResult("The query returned no nodes. Return nodes, relationships or paths (RETURN n, r, p), not their properties.");
        if (a.into === "json") {
          return structuredResult({ ...slice, truncated: out.truncated });
        }
        if (!scratch) return noScratch();
        try {
          const owner = scratchOwner(a);
          const copied = await scratch.copyIn(owner, slice);
          return structuredResult({ ...copied, truncated: out.truncated, graph: await scratch.stats(owner) });
        } catch (err) {
          return fail(err);
        }
      },
    }),
    defineTool({
      name: "kernel_graph_scratch_drop",
      description: "Wipe your scratch graph now (it also goes when your run ends).",
      schema: z.object({}),
      outputSchema: z.unknown(),
      tags: ["graph", "scratch"],
      cost: { tokens_p50: 0, usd_p50: 0, latency_p50_ms: 20, reversible: false, cacheable: false },
      async handler(a): Promise<ToolResult> {
        if (!scratch) return noScratch();
        return structuredResult({ dropped: await scratch.release(scratchOwner(a)) });
      },
    }),
  ];

  return {
    name: "graph-query",
    async initialize(ctx: ModuleContext) {
      service = new GraphQueryService(() => ctx.graph);
      if (scratch) {
        scratch.startSweeper();
        const done = (p: unknown) => {
          const runId = (p as { run_id?: string } | null)?.run_id;
          if (runId) scratch.release(`run:${runId}`).catch((e) => log.warn(`scratch graph release failed: ${(e as Error).message}`));
        };
        ctx.events.on("agent.run.completed", done);
        ctx.events.on("agent.run.failed", done);
      }
    },
    getTools(): ToolDefinition[] {
      return tools;
    },
    async shutdown() {
      scratch?.stop();
    },
  };
}
