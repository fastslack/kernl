/**
 * Life dashboard RPC slice — `dashboard.life` panel.
 *
 * Its HTTP twin is `GET /api/dashboard/life` in the kernel's dashboard module
 * (the kernel cannot import an extension, so the two stay separate). They
 * answer alike: a failure is logged and comes back as a payload with an
 * `error`, which the panel renders, rather than a thrown RPC error that sent
 * rpcOrCall off to retry over HTTP.
 */

import { log, type RpcAction } from "@kernl/extension-sdk";
import type { LifeService } from "./life-service.js";

export interface LifeDashboardRpcDeps {
  lifeService: LifeService;
}

export function lifeDashboardRpcActions(deps: LifeDashboardRpcDeps): RpcAction[] {
  const { lifeService } = deps;
  return [
    {
      name: "dashboard.life",
      handler: async () => {
        try {
          return await lifeService.getLifeData();
        } catch (err) {
          log.error("Life data failed", err);
          return { generatedAt: new Date().toISOString(), error: "Unavailable" };
        }
      },
    },
  ];
}
