import { z } from "zod";
import type { SqliteDb, ToolDefinition } from "@kernl/extension-sdk";
import { forgeConnectionTools, forgeReadTools, scopeConnections } from "../../_lib/forge/index.js";
import type { GitHubConnectionsService } from "./connections-service.js";
import type { GitHubRepoProvider } from "./provider.js";

export function githubChannelTools(
  connections: GitHubConnectionsService,
  provider: GitHubRepoProvider,
  /** Kernel db, to keep a project's own connection for its repos (scope.ts). */
  db?: SqliteDb,
): ToolDefinition[] {
  return [...forgeConnectionTools({
    prefix: "github",
    label: "GitHub",
    addDescription:
      "Register a GitHub connection (for use by triage targets and any other module that consumes RepoProvider): " +
      "a personal access token (`token`, e.g. a fine-grained one scoped to the repo) or a GitHub App (app_id, installation_id, private_key_pem).",
    addSchema: z.object({
      name: z.string().describe("display name, must be unique"),
      token: z.string().optional().describe("personal access token; leave the App fields out when you pass it"),
      app_id: z.string().optional(),
      installation_id: z.string().optional(),
      private_key_pem: z.string().optional().describe("PEM-encoded RSA private key"),
    }),
    testDescription: "Test a GitHub connection: /user for a token, an installation token and /app for an App.",
    add: (input) => connections.add(input),
    list: () => connections.list(),
    remove: (id) => connections.remove(id),
    test: (id) => provider.testConnection(id),
    addedSuffix: () => "",
    listDetails: (c) => (c.token ? "personal token" : `app_id=${c.app_id}, installation=${c.installation_id}`),
  }), ...forgeReadTools({
    prefix: "github",
    label: "GitHub",
    changeNoun: "pr",
    reader: provider,
    connections: () => connections.list(),
    scope: db ? (all, host, path) => scopeConnections(db, "github_connection", all, host, path) : undefined,
    hostOf: () => "github.com",
  })];
}
