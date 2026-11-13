/**
 * provenance module — who changed what (service.ts).
 *
 *   * `kernel_audit_who_changed` — every writing tool call that named or
 *     returned an id: who (agent and run, or MCP client), which tool, when,
 *     whether it worked.
 *   * `kernel_audit_changes`     — recent writing calls, by actor, run or tool.
 */

import { z } from "zod";
import type { GraphDriver } from "../../core/db-drivers/graph-driver.js";
import type { KernelModule, ModuleContext, RetentionPolicy, ToolDefinition, ToolResult } from "../../core/types.js";
import { agePolicy } from "../../sdk/retention.js";
import { errorResult, structuredResult } from "../../core/helpers.js";
import { runMigrations } from "../../core/db/migrations.js";
import { defineTool } from "../../core/tool-builder.js";
import { provenanceMigrations } from "./migrations.js";
import { ProvenanceService, setProvenanceService } from "./service.js";

export function createProvenanceModule(): KernelModule {
  let service: ProvenanceService | null = null;
  const tools: ToolDefinition[] = [
    defineTool({
      name: "kernel_audit_who_changed",
      description:
        "Who changed this? Every tool call that wrote and named or returned this id (a task, contact, " +
        "note, fact…): the agent and run or the MCP client that made it, the tool, when, whether it " +
        "worked, and its arguments in short.",
      schema: z.object({
        id: z.string().min(1),
        limit: z.number().int().positive().max(200).default(30),
      }),
      outputSchema: z.unknown(),
      tags: ["audit", "provenance"],
      cost: { tokens_p50: 0, usd_p50: 0, latency_p50_ms: 5, reversible: true, cacheable: false },
      async handler(a): Promise<ToolResult> {
        if (!service) return errorResult("provenance not available");
        return structuredResult({ id: a.id, calls: service.whoTouched(a.id, a.limit) });
      },
    }),
    defineTool({
      name: "kernel_audit_changes",
      description: "Recent tool calls that wrote something, newest first — by agent, run or tool — with the ids each touched.",
      schema: z.object({
        actor_id: z.string().optional().describe("An agent id, or 'mcp' for MCP clients."),
        run_id: z.string().optional(),
        tool: z.string().optional(),
        since: z.string().optional().describe("ISO time."),
        limit: z.number().int().positive().max(200).default(50),
      }),
      outputSchema: z.unknown(),
      tags: ["audit", "provenance"],
      cost: { tokens_p50: 0, usd_p50: 0, latency_p50_ms: 5, reversible: true, cacheable: false },
      async handler(a): Promise<ToolResult> {
        if (!service) return errorResult("provenance not available");
        return structuredResult({
          calls: service.recent({ actorId: a.actor_id, runId: a.run_id, tool: a.tool, since: a.since, limit: a.limit }),
        });
      },
    }),
  ];

  return {
    name: "provenance",
    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "provenance", provenanceMigrations);
      service = new ProvenanceService(ctx.sqlite, () => ctx.graph);
      setProvenanceService(service);
    },
    // TOUCHED edges for a new or upgraded store; after the projected modules (order 50).
    getGraphBackfill() {
      const svc = service;
      return svc ? { name: "provenance", version: 1, order: 50, run: (g: GraphDriver) => svc.backfill(g) } : undefined;
    },
    getRetentionPolicies(): RetentionPolicy[] {
      return [
        agePolicy({
          id: "provenance.calls",
          label: "Who changed what",
          description: "The record of which agent or client called a tool that changed something, and what it touched.",
          kind: "operational",
          table: "tool_provenance",
          dateColumn: "at",
          defaultDays: 180,
          defaultEnabled: true,
        }),
      ];
    },
    getTools(): ToolDefinition[] {
      return tools;
    },
    async shutdown() {
      setProvenanceService(null);
    },
  };
}
