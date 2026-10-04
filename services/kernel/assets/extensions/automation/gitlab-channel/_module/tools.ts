import { z } from "zod";
import type { ToolDefinition } from "@kernl/extension-sdk";
import { forgeConnectionTools } from "../../_lib/forge/index.js";
import type { GitLabConnectionsService } from "./connections-service.js";
import type { GitLabRepoProvider } from "./provider.js";

export function gitlabChannelTools(
  connections: GitLabConnectionsService,
  provider: GitLabRepoProvider,
): ToolDefinition[] {
  return forgeConnectionTools({
    prefix: "gitlab",
    label: "GitLab",
    addDescription: "Register a GitLab connection (Personal or Project Access Token with 'api' scope).",
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
  });
}
