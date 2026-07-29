import { z } from "zod";
import { defineTool, defineToolNoInput } from "../../../../../src/core/tool-builder.js";
import { textResult, errorResult } from "../../../../../src/core/helpers.js";
import type { ToolDefinition } from "../../../../../src/core/types.js";
import type { GitHubConnectionsService } from "./connections-service.js";
import type { GitHubRepoProvider } from "./provider.js";

export function githubChannelTools(
  connections: GitHubConnectionsService,
  provider: GitHubRepoProvider,
): ToolDefinition[] {
  return [
    defineTool({
      name: "kernel_github_connections_add",
      description:
        "Register a GitHub App connection (for use by triage targets and any other module that consumes RepoProvider).",
      schema: z.object({
        name: z.string().describe("display name, must be unique"),
        app_id: z.string(),
        installation_id: z.string(),
        private_key_pem: z.string().describe("PEM-encoded RSA private key"),
      }),
      handler: async (input) => {
        try {
          const c = connections.add(input);
          return textResult(`Added GitHub connection **${c.name}** (id ${c.id}).`);
        } catch (err) {
          return errorResult(`Failed: ${err}`);
        }
      },
    }),
    defineToolNoInput({
      name: "kernel_github_connections_list",
      description: "List configured GitHub connections (no secrets).",
      handler: async () => {
        const rows = connections.list();
        if (rows.length === 0) return textResult("No GitHub connections configured.");
        const lines = rows.map((c) => {
          const test = c.last_test_at
            ? `last_test=${c.last_test_at} ok=${c.last_test_ok === 1}`
            : "untested";
          return `- **${c.name}** (id ${c.id}) — app_id=${c.app_id}, installation=${c.installation_id}, ${test}`;
        });
        return textResult(`GitHub connections (${rows.length}):\n${lines.join("\n")}`);
      },
    }),
    defineTool({
      name: "kernel_github_connections_remove",
      description: "Remove a GitHub connection by id (soft-delete).",
      schema: z.object({ id: z.string() }),
      handler: async ({ id }) => {
        const ok = connections.remove(id);
        return ok ? textResult("Connection removed.") : errorResult("Not found.");
      },
    }),
    defineTool({
      name: "kernel_github_connections_test",
      description: "Test a GitHub connection by minting an installation token and calling /app.",
      schema: z.object({ id: z.string() }),
      handler: async ({ id }) => {
        const r = await provider.testConnection(id);
        return r.ok ? textResult(r.detail) : errorResult(r.detail);
      },
    }),
  ];
}
