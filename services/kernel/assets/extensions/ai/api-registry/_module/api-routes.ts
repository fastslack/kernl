/**
 * HTTP routes owned by the api-registry module. Browse, search, test,
 * configure API keys, and discover external APIs by intent.
 */
import type { IncomingMessage } from "node:http";
import type { KernelHttpServer } from "../../../../../src/core/http-server.js";
import type { ApiRegistryService } from "./service.js";

export function registerApiRegistryRoutes(
  server: KernelHttpServer,
  service: ApiRegistryService,
): void {
  // Bootstrap: catalog + stats + per-API hasKey flag
  server.get("/api/registry/apis", (_req, res) => {
    try {
      const categories = service.listCategories();
      const apis = service.listApis();
      const stats = service.getStats();
      const apisWithKeyInfo = apis.map((api) => ({
        ...api,
        hasKey: service.hasApiKey(api.id),
      }));
      server.json(res, 200, { categories, apis: apisWithKeyInfo, stats });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.get("/api/registry/apis/search", (req, res) => {
    try {
      const url = new URL(req.url ?? "", `http://${req.headers.host}`);
      const results = service.searchApis({
        query:       url.searchParams.get("q") ?? "",
        category_id: url.searchParams.get("category") ?? undefined,
        is_free:     url.searchParams.get("freeOnly") === "true" ? true : undefined,
      });
      server.json(res, 200, { results });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.post("/api/registry/apis/:id/test", async (req, res) => {
    try {
      const id = (req as IncomingMessage & { params?: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "Missing API ID" }); return; }
      server.json(res, 200, await service.testApi(id));
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.post("/api/registry/apis/:id/key", async (req, res) => {
    try {
      const id = (req as IncomingMessage & { params?: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "Missing API ID" }); return; }
      const body = await server.parseBody<{ apiKey: string; apiSecret?: string }>(req);
      if (!body.apiKey) { server.json(res, 400, { error: "Missing apiKey in body" }); return; }
      const success = service.setApiKey(id, body.apiKey, body.apiSecret);
      server.json(res, 200, { success });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.get("/api/registry/apis/discover", (req, res) => {
    try {
      const url = new URL(req.url ?? "", `http://${req.headers.host}`);
      const intent = url.searchParams.get("intent") ?? "";
      const tags = url.searchParams.get("tags")?.split(",").filter(Boolean) ?? [];
      server.json(res, 200, { results: service.discoverApis(intent, tags) });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });
}
