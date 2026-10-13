// src/modules/panels/api-routes.ts
import type { KernelHttpServer } from "../../core/http-server.js";
import { HttpError } from "../../sdk/http-error.js";
import { PanelError, type PanelGateway } from "./gateway.js";
import type { PanelStore } from "./store.js";

const asHttp = (e: unknown): never => {
  if (e instanceof PanelError) throw new HttpError(e.status, e.message);
  throw e;
};

export function registerPanelsRoutes(server: KernelHttpServer, gw: PanelGateway, store: PanelStore): void {
  server.route("GET", "/api/panels/:flowId", ({ params }) => {
    const s = gw.spec(params.flowId);
    if (!s) throw new HttpError(404, "this office has no panels");
    return s;
  });

  server.route("GET", "/api/panels/:flowId/sources/:source", ({ params, query }) => {
    try {
      const key = query.get("key");
      return gw.read(params.flowId, params.source, {
        select: query.get("select") ?? undefined,
        since: query.get("since") ?? undefined,
        vars: key ? { key } : {},
      });
    } catch (e) { return asHttp(e); }
  });

  server.route<{ values?: Record<string, unknown> }>("POST", "/api/panels/:flowId/actions/:action", ({ params, body }) => {
    try { return gw.act(params.flowId, params.action, body?.values ?? {}, "operator"); }
    catch (e) { return asHttp(e); }
  });

  server.route("GET", "/api/panels/:flowId/audit", ({ params, query }) => ({
    items: store.listAudit(params.flowId, Number(query.get("limit") ?? 50) || 50),
  }));
}
