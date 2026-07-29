import { z } from "zod";
import { defineTool, defineToolNoInput } from "../../../../../src/core/tool-builder.js";
import { textResult, errorResult } from "../../../../../src/core/helpers.js";
import type { ToolDefinition } from "../../../../../src/core/types.js";
import type { GitLabConnectionsService } from "./connections-service.js";
import type { GitLabRepoProvider } from "./provider.js";

export function gitlabChannelTools(
  connections: GitLabConnectionsService,
  provider: GitLabRepoProvider,
): ToolDefinition[] {
  return [
    defineTool({
      name: "kernel_gitlab_connections_add",
      description:
        "Register a GitLab connection (Personal or Project Access Token with 'api' scope).",
      schema: z.object({
        name: z.string().describe("display name, must be unique"),
        token: z.string(),
        host: z.string().optional().describe("default https://gitlab.com"),
      }),
      handler: async (input) => {
        try {
          const c = connections.add(input);
          return textResult(`Added GitLab connection **${c.name}** (id ${c.id}, host ${c.host}).`);
        } catch (err) {
          return errorResult(`Failed: ${err}`);
        }
      },
    }),
    defineToolNoInput({
      name: "kernel_gitlab_connections_list",
      description: "List configured GitLab connections (no secrets).",
      handler: async () => {
        const rows = connections.list();
        if (rows.length === 0) return textResult("No GitLab connections configured.");
        const lines = rows.map((c) => {
          const test = c.last_test_at
            ? `last_test=${c.last_test_at} ok=${c.last_test_ok === 1}`
            : "untested";
          return `- **${c.name}** (id ${c.id}) — host=${c.host}, ${test}`;
        });
        return textResult(`GitLab connections (${rows.length}):\n${lines.join("\n")}`);
      },
    }),
    defineTool({
      name: "kernel_gitlab_connections_remove",
      description: "Remove a GitLab connection by id (soft-delete).",
      schema: z.object({ id: z.string() }),
      handler: async ({ id }) => {
        const ok = connections.remove(id);
        return ok ? textResult("Connection removed.") : errorResult("Not found.");
      },
    }),
    defineTool({
      name: "kernel_gitlab_connections_test",
      description: "Test a GitLab connection by calling /user.",
      schema: z.object({ id: z.string() }),
      handler: async ({ id }) => {
        const r = await provider.testConnection(id);
        return r.ok ? textResult(r.detail) : errorResult(r.detail);
      },
    }),
  ];
}
