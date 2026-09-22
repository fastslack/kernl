/**
 * HTTP routes owned by the api-registry module. Browse, search, test,
 * configure API keys, and discover external APIs by intent.
 */
import { HttpError, type KernelHttpServer } from "@kernl/extension-sdk";
import type { ApiRegistryService } from "./service.js";

export function registerApiRegistryRoutes(
  server: KernelHttpServer,
  service: ApiRegistryService,
): void {
  // Bootstrap: catalog + stats + per-API hasKey flag
  server.route("GET", "/api/registry/apis", () => {
    const categories = service.listCategories();
    const apis = service.listApis();
    const stats = service.getStats();
    const apisWithKeyInfo = apis.map((api) => ({
      ...api,
      hasKey: service.hasApiKey(api.id),
    }));
    return { categories, apis: apisWithKeyInfo, stats };
  });

  server.route("GET", "/api/registry/apis/search", ({ query }) => {
    const results = service.searchApis({
      query:       query.get("q") ?? "",
      category_id: query.get("category") ?? undefined,
      is_free:     query.get("freeOnly") === "true" ? true : undefined,
    });
    return { results };
  });

  server.route("POST", "/api/registry/apis/:id/test", ({ params: { id } }) => service.testApi(id));

  server.route<{ apiKey: string; apiSecret?: string }>(
    "POST", "/api/registry/apis/:id/key", ({ params: { id }, body }) => {
      if (!body.apiKey) throw new HttpError(400, "Missing apiKey in body");
      const success = service.setApiKey(id, body.apiKey, body.apiSecret);
      return { success };
    },
  );

  server.route("GET", "/api/registry/apis/discover", ({ query }) => {
    const intent = query.get("intent") ?? "";
    const tags = query.get("tags")?.split(",").filter(Boolean) ?? [];
    return { results: service.discoverApis(intent, tags) };
  });
}
