/**
 * HTTP routes owned by the api-registry module. Browse, search, test,
 * configure API keys, and discover external APIs by intent.
 */
import { HttpError, type KernelHttpServer } from "@kernl/extension-sdk";
import type { ApiRegistryService } from "./service.js";
import { apiRegistryOperations } from "./dashboard-rpc-actions.js";

type Method = Parameters<KernelHttpServer["operation"]>[0];

export function registerApiRegistryRoutes(
  server: KernelHttpServer,
  service: ApiRegistryService,
): void {
  // Operations shared with the WS RPC (dashboard-rpc-actions.ts). A path
  // param is named after the input key the operation reads.
  const op = apiRegistryOperations(service);
  ([
    ["GET", "/api/registry/apis", "registry.apis.list"],
    ["GET", "/api/registry/apis/search", "registry.apis.search"],
    ["POST", "/api/registry/apis/:id/test", "registry.apis.test"],
  ] as Array<[Method, string, string]>).forEach(([method, path, name]) => server.operation(method, path, op[name]));

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
