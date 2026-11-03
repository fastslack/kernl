/**
 * The dashboard's way to the forge connections: list them (no secrets) and add
 * one. A connection is tested as it is added and dropped if the forge refuses
 * it, so a mistyped token never sits in the list looking usable.
 */

import type { RpcAction } from "@kernl/extension-sdk";
import type { ForgeConnectionRow, ForgeConnectionStore } from "./connections.js";
import type { ForgeRepoProvider } from "./provider.js";

export function forgeConnectionRpc<C extends ForgeConnectionRow, I>(spec: {
  /** Action prefix: "github" → github.connections.list / github.connections.add. */
  prefix: string;
  connections: ForgeConnectionStore<C> & { add(input: I): C };
  provider: ForgeRepoProvider<C>;
  /** The add input out of the dashboard's form fields. */
  addInput: (args: Record<string, unknown>) => I;
}): RpcAction[] {
  const { prefix, connections, provider } = spec;
  return [
    {
      name: `${prefix}.connections.list`,
      handler: async () => ({ connections: provider.listConnections() }),
    },
    {
      name: `${prefix}.connections.add`,
      handler: async (args) => {
        const c = connections.add(spec.addInput(args));
        const test = await provider.testConnection(c.id);
        if (!test.ok) {
          connections.remove(c.id);
          throw new Error(test.detail);
        }
        return { id: c.id, name: c.name, detail: test.detail };
      },
    },
  ];
}
