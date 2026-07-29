/**
 * API Registry dashboard RPC slice — `registry.apis.*` handlers used by the
 * dashboard's API explorer page.
 */

import type { RpcAction } from "../../../../../src/core/mtw/rpc-handler.js";
import type { ApiRegistryService } from "./service.js";

export interface ApiRegistryDashboardRpcDeps {
  apiRegistryService: ApiRegistryService;
}

export function apiRegistryDashboardRpcActions(deps: ApiRegistryDashboardRpcDeps): RpcAction[] {
  const { apiRegistryService: api } = deps;
  return [
    {
      name: "registry.apis.list",
      handler: async () => ({
        categories: api.listCategories(),
        apis: api.listApis().map((a: any) => ({ ...a, hasKey: api.hasApiKey(a.id) })),
        stats: api.getStats(),
      }),
    },
    {
      name: "registry.apis.search",
      handler: async (args) => ({
        results: api.searchApis({
          query: typeof args.q === "string" ? args.q : "",
          category_id: typeof args.category === "string" ? args.category : undefined,
          is_free: args.freeOnly === true ? true : undefined,
        }),
      }),
    },
    {
      name: "registry.apis.test",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) return { error: "id is required" };
        return api.testApi(id);
      },
    },
  ];
}
