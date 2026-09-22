/**
 * HTTP routes owned by the rss-registry extension. Registered via
 * `getDashboardDescriptor.registerRoutes` so the routes are tied to the
 * extension lifecycle — when the module unloads, its routes go with it.
 */
import { HttpError, type KernelHttpServer } from "@kernl/extension-sdk";
import type { RssRegistryService } from "./service.js";
import { rssRegistryOperations } from "./operations.js";

type RouteMethod = Parameters<KernelHttpServer["operation"]>[0];

export function registerRssRegistryRoutes(
  server: KernelHttpServer,
  service: RssRegistryService,
): void {
  // Routes whose RPC twin is the same operation (operations.ts). A path
  // param is named after the input key the operation reads.
  const op = rssRegistryOperations(service);
  const bind = (method: RouteMethod, path: string, name: string) => server.operation(method, path, op[name]);

  bind("GET", "/api/registry/rss", "registry.rss.list");
  bind("GET", "/api/registry/rss/search", "registry.rss.search");

  // ── Discover by topic (used by Universal Research Engine) ──
  server.route("GET", "/api/registry/rss/discover", ({ query }) => {
    const topic = query.get("topic") ?? "";
    const tags = query.get("tags")?.split(",").filter(Boolean) ?? [];
    return { results: service.discoverFeeds(topic, tags) };
  });

  bind("GET", "/api/registry/rss/items", "registry.rss.items");
  bind("GET", "/api/registry/rss/items/:id", "registry.rss.itemGet");
  bind("GET", "/api/registry/rss/preview", "registry.rss.preview");
  bind("POST", "/api/registry/rss/refresh", "registry.rss.refresh");
  bind("POST", "/api/registry/rss/:id/refresh", "registry.rss.refresh");
  bind("POST", "/api/registry/rss/:id/test", "registry.rss.test");
  bind("POST", "/api/registry/rss/:id/toggle", "registry.rss.toggle");
  bind("POST", "/api/registry/rss", "registry.rss.add");

  /**
   * Generic feed update — used by drag-drop in the reader sidebar to change
   * `category_id` when moving a feed between folders, and by any future
   * inline-edit flows for feed properties.
   */
  server.route<Record<string, unknown>>("PUT", "/api/registry/rss/:id", ({ params: { id }, body }) => {
    const feed = service.updateFeed(id, body as never);
    if (!feed) throw new HttpError(404, "Feed not found");
    return { feed };
  });

  bind("DELETE", "/api/registry/rss/:id", "registry.rss.delete");

  /**
   * Persist a new feed ordering for one category. Body shape:
   *   { category_id: string | null, ids: string[] }
   * The caller sends the full list of feed IDs in the new order; we rewrite
   * `sort_order` (and `category_id`, so the same call can also re-home feeds
   * coming from another folder during a drag-and-drop).
   * NOTE: this route lives BEFORE `/:id` PUT so the path doesn't get gobbled.
   */
  server.route<{ category_id?: string | null; ids?: unknown }>("POST", "/api/registry/rss/reorder", ({ body }) => {
    const ids = Array.isArray(body.ids) ? (body.ids as unknown[]).filter((x): x is string => typeof x === "string") : [];
    if (ids.length === 0) throw new HttpError(400, "ids must be a non-empty array");
    const catId = body.category_id ?? null;
    service.reorderFeeds(catId, ids);
    return { ok: true };
  });

  // ── Category CRUD (inline folder editing in the reader sidebar) ──
  /**
   * Persist a new category ordering. Body: `{ ids: string[] }`. Same shape as
   * the feed reorder endpoint — we rewrite `sort_order` 0..N-1 to match.
   * Lives before `/categories/:id` so the path matcher picks the literal one.
   */
  server.route<{ ids?: unknown }>("POST", "/api/registry/rss/categories/reorder", ({ body }) => {
    const ids = Array.isArray(body.ids) ? (body.ids as unknown[]).filter((x): x is string => typeof x === "string") : [];
    if (ids.length === 0) throw new HttpError(400, "ids must be a non-empty array");
    service.reorderCategories(ids);
    return { ok: true };
  });

  bind("POST", "/api/registry/rss/categories", "registry.rss.categoryAdd");
  bind("PUT", "/api/registry/rss/categories/:id", "registry.rss.categoryUpdate");
  bind("DELETE", "/api/registry/rss/categories/:id", "registry.rss.categoryDelete");
}
