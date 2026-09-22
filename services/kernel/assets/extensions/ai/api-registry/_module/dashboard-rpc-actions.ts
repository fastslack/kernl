/**
 * API Registry dashboard RPC slice — `registry.apis.*` handlers used by the
 * dashboard's API explorer page.
 *
 * Each one is an operation shared with its HTTP route (api-routes.ts binds
 * the same map): the dashboard calls them through `rpcOrCall`, WS first and
 * HTTP when the bridge is down, so both roads have to answer alike.
 */

import { HttpError, pickArgs, rpcActionsFrom, type Operation, type RpcAction } from "@kernl/extension-sdk";
import type { ApiRegistryService } from "./service.js";

export interface ApiRegistryDashboardRpcDeps {
  apiRegistryService: ApiRegistryService;
}

export function apiRegistryOperations(api: ApiRegistryService): Record<string, Operation> {
  return {
    // Bootstrap: catalog + stats + per-API hasKey flag
    "registry.apis.list": () => ({
      categories: api.listCategories(),
      apis: api.listApis().map((a) => ({ ...a, hasKey: api.hasApiKey(a.id) })),
      stats: api.getStats(),
    }),

    // `freeOnly` is a boolean over RPC and the string "true" in a query string.
    "registry.apis.search": (input) => {
      const { q, category } = pickArgs(input, { q: "string", category: "string" });
      return {
        results: api.searchApis({
          query: q ?? "",
          category_id: category || undefined,
          is_free: input.freeOnly === true || input.freeOnly === "true" ? true : undefined,
        }),
      };
    },

    "registry.apis.test": (input) => {
      const { id } = pickArgs(input, { id: "string" });
      if (!id) throw new HttpError(400, "id is required");
      return api.testApi(id);
    },
  };
}

export function apiRegistryDashboardRpcActions(deps: ApiRegistryDashboardRpcDeps): RpcAction[] {
  return rpcActionsFrom(apiRegistryOperations(deps.apiRegistryService));
}
