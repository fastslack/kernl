/**
 * MCP tools for an office's declarative workspace — `kubectl apply` for the
 * folder its agents work in.
 */

import { z } from "zod";
import { textResult, errorResult } from "../../core/helpers.js";
import { defineTool } from "../../core/tool-builder.js";
import type { ToolDefinition } from "../../core/types.js";
import type { AgentService } from "./service.js";
import type { WorkspaceSpec } from "./workspace-spec.js";

function describeSpec(spec: WorkspaceSpec): string {
  const lines: string[] = [];
  for (const g of spec.git) {
    lines.push(`- git ${g.repo}${g.branch ? ` @ ${g.branch}` : ""} → ${g.path}${g.depth ? ` (depth ${g.depth})` : ""}`);
  }
  for (const f of spec.files) lines.push(`- file ${f.path}${f.overwrite ? " (overwrite)" : ""}`);
  for (const name of Object.keys(spec.mcp_servers)) lines.push(`- mcp ${name}`);
  if (spec.skills.length > 0) lines.push(`- skills ${spec.skills.join(", ")}`);
  return lines.length > 0 ? lines.join("\n") : "_(empty — nothing is prepared)_";
}

export function workspaceSpecTools(service: AgentService): ToolDefinition[] {
  return [
    defineTool({
      name: "kernel_agents_workspace_apply",
      description:
        "Declare what an office's home folder must contain and prepare it now: git repos to clone " +
        "(at a branch), files to seed, MCP servers and skills for every claude_code agent working " +
        "in the home. Replaces the previous spec. Existing checkouts are never re-cloned or reset; " +
        "seeded files only replace an existing one when `overwrite` is true. Runs of the office wait " +
        "for the home to be ready and fail with the reason when it can't be prepared.",
      schema: z.object({
        flow_id: z.string().describe("Office (flow) ID"),
        spec: z
          .union([z.string(), z.record(z.string(), z.unknown())])
          .describe(
            'WorkspaceSpec object or JSON: { "git": [{ "repo", "branch"?, "path"?, "depth"? }], ' +
              '"files": [{ "path", "content", "overwrite"? }], "mcp_servers": { name: config }, "skills": [slug] }',
          ),
      }),
      handler: async (input) => {
        let spec: WorkspaceSpec;
        try {
          spec = service.setFlowWorkspaceSpec(input.flow_id, input.spec);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
        const prepared = await service.prepareFlowWorkspace(input.flow_id);
        let md = `**Workspace spec saved**\n${describeSpec(spec)}\n`;
        if (!prepared) return textResult(md);
        const { result, path } = prepared;
        md += `\n**${result.ready ? "Ready" : "Not ready"}** at \`${path}\`\n`;
        if (result.cloned.length > 0) md += `- cloned: ${result.cloned.join(", ")}\n`;
        if (result.written.length > 0) md += `- wrote: ${result.written.join(", ")}\n`;
        for (const e of result.errors) md += `- ❌ ${e}\n`;
        return result.ready ? textResult(md) : errorResult(md);
      },
    }),

    defineTool({
      name: "kernel_agents_workspace_get",
      description: "Show an office's declarative workspace spec and how its last preparation went.",
      schema: z.object({
        flow_id: z.string().describe("Office (flow) ID"),
      }),
      handler: async (input) => {
        const ws = service.getFlowWorkspace(input.flow_id);
        if (!ws) return errorResult(`Flow not found: ${input.flow_id}`);
        const home = service.resolveFlowHome(input.flow_id);
        let md = `**Workspace of office ${home?.flow.name ?? input.flow_id}**\n`;
        if (home) md += `- home: \`${home.path}\` (${home.kind})\n`;
        md += `- last preparation: ${ws.setup_status || "never"}${ws.setup_at ? ` at ${ws.setup_at}` : ""}\n`;
        if (ws.setup_error) md += `- errors: ${ws.setup_error.replace(/\n/g, "; ")}\n`;
        md += `\n**Spec**\n${describeSpec(ws.spec)}\n`;
        return textResult(md);
      },
    }),
  ];
}
