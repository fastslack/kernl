import { z } from "zod";
import type { ToolDefinition } from "@kernl/extension-sdk";
import { forgeConnectionTools } from "../../_lib/forge/index.js";
import type { GitHubConnectionsService } from "./connections-service.js";
import type { GitHubRepoProvider } from "./provider.js";

export function githubChannelTools(
  connections: GitHubConnectionsService,
  provider: GitHubRepoProvider,
): ToolDefinition[] {
  return forgeConnectionTools({
    prefix: "github",
    label: "GitHub",
    addDescription:
      "Register a GitHub App connection (for use by triage targets and any other module that consumes RepoProvider).",
    addSchema: z.object({
      name: z.string().describe("display name, must be unique"),
      app_id: z.string(),
      installation_id: z.string(),
      private_key_pem: z.string().describe("PEM-encoded RSA private key"),
    }),
    testDescription: "Test a GitHub connection by minting an installation token and calling /app.",
    add: (input) => connections.add(input),
    list: () => connections.list(),
    remove: (id) => connections.remove(id),
    test: (id) => provider.testConnection(id),
    addedSuffix: () => "",
    listDetails: (c) => `app_id=${c.app_id}, installation=${c.installation_id}`,
  });
}
