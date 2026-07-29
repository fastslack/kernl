/**
 * HTTP routes owned by the rss-registry extension. Registered via
 * `getDashboardDescriptor.registerRoutes` so the routes are tied to the
 * extension lifecycle — when the module unloads, its routes go with it.
 */
import type { IncomingMessage } from "node:http";
import type { KernelHttpServer } from "../../../../../src/core/http-server.js";
import type { RssRegistryService } from "./service.js";

export function registerRssRegistryRoutes(
  server: KernelHttpServer,
  service: RssRegistryService,
): void {
  // ── Bootstrap data for the dashboard registry view ──
  server.get("/api/registry/rss", (_req, res) => {
    try {
      server.json(res, 200, {
        categories: service.listCategories(),
        feeds: service.listFeeds(),
        stats: service.getStats(),
      });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // ── Search ──
  server.get("/api/registry/rss/search", (req, res) => {
    try {
      const url = new URL(req.url ?? "", `http://${req.headers.host}`);
      const results = service.searchFeeds({
        query:       url.searchParams.get("q") ?? "",
        category_id: url.searchParams.get("category") ?? undefined,
        language:    url.searchParams.get("language") ?? undefined,
      });
      server.json(res, 200, { results });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // ── Discover by topic (used by Universal Research Engine) ──
  server.get("/api/registry/rss/discover", (req, res) => {
    try {
      const url = new URL(req.url ?? "", `http://${req.headers.host}`);
      const topic = url.searchParams.get("topic") ?? "";
      const tags = url.searchParams.get("tags")?.split(",").filter(Boolean) ?? [];
      server.json(res, 200, { results: service.discoverFeeds(topic, tags) });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // ── Items ──
  server.get("/api/registry/rss/items", (req, res) => {
    try {
      const url = new URL(req.url ?? "", `http://${req.headers.host}`);
      const items = service.listItems({
        feed_id:     url.searchParams.get("feed_id")     ?? undefined,
        category_id: url.searchParams.get("category_id") ?? undefined,
        language:    url.searchParams.get("language")    ?? undefined,
        since:       url.searchParams.get("since")       ?? undefined,
        search:      url.searchParams.get("q")           ?? undefined,
        limit:       Number(url.searchParams.get("limit")  ?? "100"),
        offset:      Number(url.searchParams.get("offset") ?? "0"),
      });
      server.json(res, 200, { items });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.get("/api/registry/rss/items/:id", (req, res) => {
    try {
      const id = (req as IncomingMessage & { params?: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "Missing item ID" }); return; }
      const item = service.getItem(id);
      if (!item) { server.json(res, 404, { error: "Item not found" }); return; }
      server.json(res, 200, { item });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // ── Live preview (no persistence) — for "add feed" UX ──
  server.get("/api/registry/rss/preview", async (req, res) => {
    try {
      const url = new URL(req.url ?? "", `http://${req.headers.host}`);
      const feedUrl = url.searchParams.get("url");
      if (!feedUrl) { server.json(res, 400, { error: "Missing url" }); return; }
      const result = await service.previewFeed(feedUrl);
      server.json(res, 200, result as Record<string, unknown>);
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // ── Refresh (fetch new items) ──
  server.post("/api/registry/rss/refresh", async (_req, res) => {
    try {
      const results = await service.fetchAllActive();
      server.json(res, 200, { results });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.post("/api/registry/rss/:id/refresh", async (req, res) => {
    try {
      const id = (req as IncomingMessage & { params?: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "Missing feed ID" }); return; }
      const result = await service.fetchFeed(id);
      server.json(res, 200, result as unknown as Record<string, unknown>);
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // ── Test (validate URL) ──
  server.post("/api/registry/rss/:id/test", async (req, res) => {
    try {
      const id = (req as IncomingMessage & { params?: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "Missing feed ID" }); return; }
      const result = await service.testFeed(id);
      server.json(res, 200, result);
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // ── Toggle active/disabled ──
  server.post("/api/registry/rss/:id/toggle", async (req, res) => {
    try {
      const id = (req as IncomingMessage & { params?: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "Missing feed ID" }); return; }
      const feed = service.getFeed(id);
      if (!feed) { server.json(res, 404, { error: "Feed not found" }); return; }
      const newStatus = feed.status === "active" ? "disabled" : "active";
      const updated = service.updateFeed(id, { status: newStatus });
      server.json(res, 200, { success: true, feed: updated });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // ── Feed CRUD ──
  server.post("/api/registry/rss", async (req, res) => {
    try {
      const body = await server.parseBody<Record<string, unknown>>(req);
      if (!body.feed_url || !body.name) {
        server.json(res, 400, { error: "name and feed_url are required" });
        return;
      }
      const feed = service.addFeed(body as never);
      server.json(res, 200, { feed });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  /**
   * Generic feed update — used by drag-drop in the reader sidebar to change
   * `category_id` when moving a feed between folders, and by any future
   * inline-edit flows for feed properties.
   */
  server.put("/api/registry/rss/:id", async (req, res) => {
    try {
      const id = (req as IncomingMessage & { params?: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "Missing feed ID" }); return; }
      const body = await server.parseBody<Record<string, unknown>>(req);
      const feed = service.updateFeed(id, body as never);
      if (!feed) { server.json(res, 404, { error: "Feed not found" }); return; }
      server.json(res, 200, { feed });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.delete("/api/registry/rss/:id", (req, res) => {
    try {
      const id = (req as IncomingMessage & { params?: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "Missing feed ID" }); return; }
      const ok = service.deleteFeed(id);
      server.json(res, ok ? 200 : 404, { ok });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  /**
   * Persist a new feed ordering for one category. Body shape:
   *   { category_id: string | null, ids: string[] }
   * The caller sends the full list of feed IDs in the new order; we rewrite
   * `sort_order` (and `category_id`, so the same call can also re-home feeds
   * coming from another folder during a drag-and-drop).
   * NOTE: this route lives BEFORE `/:id` PUT so the path doesn't get gobbled.
   */
  server.post("/api/registry/rss/reorder", async (req, res) => {
    try {
      const body = await server.parseBody<{ category_id?: string | null; ids?: unknown }>(req);
      const ids = Array.isArray(body.ids) ? (body.ids as unknown[]).filter((x): x is string => typeof x === "string") : [];
      if (ids.length === 0) { server.json(res, 400, { error: "ids must be a non-empty array" }); return; }
      const catId = body.category_id ?? null;
      service.reorderFeeds(catId, ids);
      server.json(res, 200, { ok: true });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // ── Category CRUD (inline folder editing in the reader sidebar) ──
  /**
   * Persist a new category ordering. Body: `{ ids: string[] }`. Same shape as
   * the feed reorder endpoint — we rewrite `sort_order` 0..N-1 to match.
   * Lives before `/categories/:id` so the path matcher picks the literal one.
   */
  server.post("/api/registry/rss/categories/reorder", async (req, res) => {
    try {
      const body = await server.parseBody<{ ids?: unknown }>(req);
      const ids = Array.isArray(body.ids) ? (body.ids as unknown[]).filter((x): x is string => typeof x === "string") : [];
      if (ids.length === 0) { server.json(res, 400, { error: "ids must be a non-empty array" }); return; }
      service.reorderCategories(ids);
      server.json(res, 200, { ok: true });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.post("/api/registry/rss/categories", async (req, res) => {
    try {
      const body = await server.parseBody<Record<string, unknown>>(req);
      if (!body.name || typeof body.name !== "string") {
        server.json(res, 400, { error: "name is required" });
        return;
      }
      const category = service.addCategory(body as never);
      server.json(res, 200, { category });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.put("/api/registry/rss/categories/:id", async (req, res) => {
    try {
      const id = (req as IncomingMessage & { params?: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "Missing category ID" }); return; }
      const body = await server.parseBody<Record<string, unknown>>(req);
      const category = service.updateCategory(id, body);
      if (!category) { server.json(res, 404, { error: "Category not found" }); return; }
      server.json(res, 200, { category });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.delete("/api/registry/rss/categories/:id", (req, res) => {
    try {
      const id = (req as IncomingMessage & { params?: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "Missing category ID" }); return; }
      const ok = service.deleteCategory(id);
      server.json(res, ok ? 200 : 404, { ok });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });
}
