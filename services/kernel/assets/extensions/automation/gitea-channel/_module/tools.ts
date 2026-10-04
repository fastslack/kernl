import { z } from "zod";
import type { ToolDefinition } from "@kernl/extension-sdk";
import { forgeConnectionTools } from "../../_lib/forge/index.js";
import type { GiteaConnectionsService } from "./connections-service.js";
import type { GiteaRepoProvider } from "./provider.js";

export function giteaChannelTools(
  connections: GiteaConnectionsService,
  provider: GiteaRepoProvider,
): ToolDefinition[] {
  return forgeConnectionTools({
    prefix: "gitea",
    label: "Gitea",
    addDescription:
      "Register a Gitea/Forgejo/Codeberg connection. Token must have 'read:repository' + 'write:issue' scopes (or admin).",
    addSchema: z.object({
      name: z.string().describe("display name, must be unique"),
      host: z.string().describe("base URL, e.g. https://codeberg.org or https://git.local"),
      token: z.string().describe("personal access token"),
    }),
    testDescription: "Test a Gitea connection by calling /user.",
    add: (input) => connections.add(input),
    list: () => connections.list(),
    remove: (id) => connections.remove(id),
    test: (id) => provider.testConnection(id),
    addedSuffix: (c) => `, host ${c.host}`,
    listDetails: (c) => `host=${c.host}`,
  });
}
