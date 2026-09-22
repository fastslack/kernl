/**
 * HTTP routes owned by the rss-registry extension. Registered via
 * `getDashboardDescriptor.registerRoutes` so the routes are tied to the
 * extension lifecycle — when the module unloads, its routes go with it.
 */
import { HttpError, type KernelHttpServer } from "@kernl/extension-sdk";
import type { RssRegistryService } from "./service.js";

export function registerRssRegistryRoutes(
  server: KernelHttpServer,
  service: RssRegistryService,
): void {
  // ── Bootstrap data for the dashboard registry view ──
  server.route("GET", "/api/registry/rss", () => ({
    categories: service.listCategories(),
    feeds: service.listFeeds(),
    stats: service.getStats(),
  }));

  // ── Search ──
  server.route("GET", "/api/registry/rss/search", ({ query }) => ({
    results: service.searchFeeds({
      query:       query.get("q") ?? "",
      category_id: query.get("category") ?? undefined,
      language:    query.get("language") ?? undefined,
    }),
  }));

  // ── Discover by topic (used by Universal Research Engine) ──
  server.route("GET", "/api/registry/rss/discover", ({ query }) => {
    const topic = query.get("topic") ?? "";
    const tags = query.get("tags")?.split(",").filter(Boolean) ?? [];
    return { results: service.discoverFeeds(topic, tags) };
  });

  // ── Items ──
  server.route("GET", "/api/registry/rss/items", ({ query }) => ({
    items: service.listItems({
      feed_id:     query.get("feed_id")     ?? undefined,
      category_id: query.get("category_id") ?? undefined,
      language:    query.get("language")    ?? undefined,
      since:       query.get("since")       ?? undefined,
      search:      query.get("q")           ?? undefined,
      limit:       Number(query.get("limit")  ?? "100"),
      offset:      Number(query.get("offset") ?? "0"),
    }),
  }));

  server.route("GET", "/api/registry/rss/items/:id", ({ params: { id } }) => {
    const item = service.getItem(id);
    if (!item) throw new HttpError(404, "Item not found");
    return { item };
  });

  // ── Live preview (no persistence) — for "add feed" UX ──
  server.route("GET", "/api/registry/rss/preview", async ({ query }) => {
    const feedUrl = query.get("url");
    if (!feedUrl) throw new HttpError(400, "Missing url");
    return service.previewFeed(feedUrl);
  });

  // ── Refresh (fetch new items) ──
  server.route("POST", "/api/registry/rss/refresh", async () => ({
    results: await service.fetchAllActive(),
  }));

  server.route("POST", "/api/registry/rss/:id/refresh", ({ params: { id } }) => service.fetchFeed(id));

  // ── Test (validate URL) ──
  server.route("POST", "/api/registry/rss/:id/test", ({ params: { id } }) => service.testFeed(id));

  // ── Toggle active/disabled ──
  server.route("POST", "/api/registry/rss/:id/toggle", ({ params: { id } }) => {
    const feed = service.getFeed(id);
    if (!feed) throw new HttpError(404, "Feed not found");
    const newStatus = feed.status === "active" ? "disabled" : "active";
    const updated = service.updateFeed(id, { status: newStatus });
    return { success: true, feed: updated };
  });

  // ── Feed CRUD ──
  server.route<Record<string, unknown>>("POST", "/api/registry/rss", ({ body }) => {
    if (!body.feed_url || !body.name) throw new HttpError(400, "name and feed_url are required");
    return { feed: service.addFeed(body as never) };
  });

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

  server.route("DELETE", "/api/registry/rss/:id", ({ params: { id } }) => {
    if (!service.deleteFeed(id)) throw new HttpError(404, "Feed not found", { ok: false });
    return { ok: true };
  });

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

  server.route<Record<string, unknown>>("POST", "/api/registry/rss/categories", ({ body }) => {
    if (!body.name || typeof body.name !== "string") throw new HttpError(400, "name is required");
    return { category: service.addCategory(body as never) };
  });

  server.route<Record<string, unknown>>("PUT", "/api/registry/rss/categories/:id", ({ params: { id }, body }) => {
    const category = service.updateCategory(id, body);
    if (!category) throw new HttpError(404, "Category not found");
    return { category };
  });

  server.route("DELETE", "/api/registry/rss/categories/:id", ({ params: { id } }) => {
    if (!service.deleteCategory(id)) throw new HttpError(404, "Category not found", { ok: false });
    return { ok: true };
  });
}
