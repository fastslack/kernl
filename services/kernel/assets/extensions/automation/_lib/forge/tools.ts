/**
 * The four connection tools every forge channel exposes
 * (kernel_<forge>_connections_add | list | remove | test).
 */

import { z } from "zod";
import {
  defineTool,
  defineToolNoInput,
  textResult,
  errorResult,
  type ToolDefinition,
} from "@kernl/extension-sdk";
import type { ForgeConnectionRow } from "./connections.js";

export interface ForgeToolsSpec<C extends ForgeConnectionRow, S extends z.ZodTypeAny> {
  /** Tool-name segment: "github", "gitlab", "gitea". */
  prefix: string;
  label: string;
  addDescription: string;
  addSchema: S;
  testDescription: string;
  add: (input: z.infer<S>) => C;
  list: () => C[];
  remove: (id: string) => boolean;
  test: (id: string) => Promise<{ ok: boolean; detail: string }>;
  /** What follows the id in the "Added …" line, e.g. `, host https://…`. Empty for none. */
  addedSuffix: (c: C) => string;
  /** Non-secret details in the list line, e.g. `host=https://…`. */
  listDetails: (c: C) => string;
}

export function forgeConnectionTools<C extends ForgeConnectionRow, S extends z.ZodTypeAny>(
  spec: ForgeToolsSpec<C, S>,
): ToolDefinition[] {
  const { prefix, label } = spec;
  return [
    defineTool({
      name: `kernel_${prefix}_connections_add`,
      description: spec.addDescription,
      schema: spec.addSchema,
      handler: async (input) => {
        try {
          const c = spec.add(input);
          return textResult(`Added ${label} connection **${c.name}** (id ${c.id}${spec.addedSuffix(c)}).`);
        } catch (err) {
          return errorResult(`Failed: ${err}`);
        }
      },
    }),
    defineToolNoInput({
      name: `kernel_${prefix}_connections_list`,
      description: `List configured ${label} connections (no secrets).`,
      handler: async () => {
        const rows = spec.list();
        if (rows.length === 0) return textResult(`No ${label} connections configured.`);
        const lines = rows.map((c) => {
          const test = c.last_test_at
            ? `last_test=${c.last_test_at} ok=${c.last_test_ok === 1}`
            : "untested";
          // Only the fact is shown — never the stored value.
          const creds = c.credentials_unreadable ? ", credentials=unreadable (re-add the connection)" : "";
          return `- **${c.name}** (id ${c.id}) — ${spec.listDetails(c)}${creds}, ${test}`;
        });
        return textResult(`${label} connections (${rows.length}):\n${lines.join("\n")}`);
      },
    }),
    defineTool({
      name: `kernel_${prefix}_connections_remove`,
      description: `Remove a ${label} connection by id (soft-delete).`,
      schema: z.object({ id: z.string() }),
      handler: async ({ id }) => (spec.remove(id) ? textResult("Connection removed.") : errorResult("Not found.")),
    }),
    defineTool({
      name: `kernel_${prefix}_connections_test`,
      description: spec.testDescription,
      schema: z.object({ id: z.string() }),
      handler: async ({ id }) => {
        const r = await spec.test(id);
        return r.ok ? textResult(r.detail) : errorResult(r.detail);
      },
    }),
  ];
}
