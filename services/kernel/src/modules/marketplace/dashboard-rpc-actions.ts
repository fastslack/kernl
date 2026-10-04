/**
 * Marketplace dashboard RPC slice — `marketplace.*` operations.
 * Each one is an operation shared with its HTTP route; see operations.ts.
 */

import type { RpcAction } from "../../core/mtw/rpc-handler.js";
import { rpcActionsFrom } from "../../sdk/args.js";
import type { MarketplaceService } from "./service.js";
import { marketplaceOperations } from "./operations.js";

export interface MarketplaceDashboardRpcDeps {
  marketplaceService: MarketplaceService;
}

export function marketplaceDashboardRpcActions(deps: MarketplaceDashboardRpcDeps): RpcAction[] {
  return rpcActionsFrom(marketplaceOperations(deps.marketplaceService));
}
