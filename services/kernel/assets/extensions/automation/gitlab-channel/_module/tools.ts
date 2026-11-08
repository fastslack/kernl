import { z } from "zod";
import type { SqliteDb, ToolDefinition } from "@kernl/extension-sdk";
import { forgeConnectionTools, forgeReadTools, scopeConnections } from "../../_lib/forge/index.js";
import type { GitLabConnectionsService } from "./connections-service.js";
import type { GitLabRepoProvider } from "./provider.js";

export function gitlabChannelTools(
  connections: GitLabConnectionsService,
  provider: GitLabRepoProvider,
  /** Kernel db, to keep a project's own connection for its repos (scope.ts). */
  db?: SqliteDb,
): ToolDefinition[] {
  return [...forgeConnectionTools({
    prefix: "gitlab",
    label: "GitLab",
    addDescription: "Register a GitLab connection (Personal or Project Access Token: 'api' scope for triage to comment and close, 'read_api' is enough to read issues and merge requests).",
    addSchema: z.object({
      name: z.string().describe("display name, must be unique"),
      token: z.string(),
      host: z.string().optional().describe("default https://gitlab.com"),
    }),
    testDescription: "Test a GitLab connection by calling /user.",
    add: (input) => connections.add(input),
    list: () => connections.list(),
    remove: (id) => connections.remove(id),
    test: (id) => provider.testConnection(id),
    addedSuffix: (c) => `, host ${c.host}`,
    listDetails: (c) => `host=${c.host}`,
  }), ...forgeReadTools({
    prefix: "gitlab",
    label: "GitLab",
    changeNoun: "mr",
    reader: provider,
    connections: () => connections.list(),
    scope: db ? (all, host, path) => scopeConnections(db, "gitlab_connection", all, host, path) : undefined,
    hostOf: (c) => { try { return new URL(c.host).hostname.toLowerCase(); } catch { return ""; } },
  })];
}
