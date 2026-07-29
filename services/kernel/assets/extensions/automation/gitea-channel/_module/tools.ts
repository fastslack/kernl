import { z } from "zod";
import { defineTool, defineToolNoInput } from "../../../../../src/core/tool-builder.js";
import { textResult, errorResult } from "../../../../../src/core/helpers.js";
import type { ToolDefinition } from "../../../../../src/core/types.js";
import type { GiteaConnectionsService } from "./connections-service.js";
import type { GiteaRepoProvider } from "./provider.js";

export function giteaChannelTools(
  connections: GiteaConnectionsService,
  provider: GiteaRepoProvider,
): ToolDefinition[] {
  return [
    defineTool({
      name: "kernel_gitea_connections_add",
      description:
        "Register a Gitea/Forgejo/Codeberg connection. Token must have 'read:repository' + 'write:issue' scopes (or admin).",
      schema: z.object({
        name: z.string().describe("display name, must be unique"),
        host: z.string().describe("base URL, e.g. https://codeberg.org or https://git.local"),
        token: z.string().describe("personal access token"),
      }),
      handler: async (input) => {
        try {
          const c = connections.add(input);
          return textResult(`Added Gitea connection **${c.name}** (id ${c.id}, host ${c.host}).`);
        } catch (err) {
          return errorResult(`Failed: ${err}`);
        }
      },
    }),
    defineToolNoInput({
      name: "kernel_gitea_connections_list",
      description: "List configured Gitea connections (no secrets).",
      handler: async () => {
        const rows = connections.list();
        if (rows.length === 0) return textResult("No Gitea connections configured.");
        const lines = rows.map((c) => {
          const test = c.last_test_at
            ? `last_test=${c.last_test_at} ok=${c.last_test_ok === 1}`
            : "untested";
          return `- **${c.name}** (id ${c.id}) — host=${c.host}, ${test}`;
        });
        return textResult(`Gitea connections (${rows.length}):\n${lines.join("\n")}`);
      },
    }),
    defineTool({
      name: "kernel_gitea_connections_remove",
      description: "Remove a Gitea connection by id (soft-delete).",
      schema: z.object({ id: z.string() }),
      handler: async ({ id }) => {
        const ok = connections.remove(id);
        return ok ? textResult("Connection removed.") : errorResult("Not found.");
      },
    }),
    defineTool({
      name: "kernel_gitea_connections_test",
      description: "Test a Gitea connection by calling /user.",
      schema: z.object({ id: z.string() }),
      handler: async ({ id }) => {
        const r = await provider.testConnection(id);
        return r.ok ? textResult(r.detail) : errorResult(r.detail);
      },
    }),
  ];
}
