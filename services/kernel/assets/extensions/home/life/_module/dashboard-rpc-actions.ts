/**
 * Life dashboard RPC slice — `dashboard.life` panel.
 */

import type { RpcAction } from "../../../../../src/core/mtw/rpc-handler.js";
import type { LifeService } from "./life-service.js";

export interface LifeDashboardRpcDeps {
  lifeService: LifeService;
}

export function lifeDashboardRpcActions(deps: LifeDashboardRpcDeps): RpcAction[] {
  const { lifeService } = deps;
  return [
    {
      name: "dashboard.life",
      handler: async () => lifeService.getLifeData(),
    },
  ];
}
