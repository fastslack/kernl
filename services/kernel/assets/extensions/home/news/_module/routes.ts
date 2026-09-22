import { HttpError, type KernelHttpServer, type EventBus, log } from "@kernl/extension-sdk";
import type { NewsService } from "./news-service.js";

export function registerNewsRoutes(
  server: KernelHttpServer,
  newsService?: NewsService | null,
  events?: EventBus,
): void {
  const requireNews = (): NewsService => {
    if (!newsService) throw new HttpError(400, "News service not available");
    return newsService;
  };

  // Get news articles from all active feeds
  server.route("GET", "/api/dashboard/news", async ({ query }) => {
    if (!newsService) return { available: false, articles: [], feeds: [], categories: [] };

    const categories = query.get("categories")?.split(",").filter(Boolean);
    const limit = parseInt(query.get("limit") ?? "50", 10);
    const forceRefresh = query.get("refresh") === "1";

    const news = await newsService.getNews({ categories, limit, forceRefresh });
    return { available: true, ...news };
  });

  // List all user feeds
  server.route("GET", "/api/feeds", () => {
    if (!newsService) return { feeds: [], categories: [] };
    return {
      feeds: newsService.listFeeds(),
      categories: newsService.listCategories(),
    };
  });

  // Add a new feed
  server.route<{
    name: string;
    url: string;
    category?: string;
    color?: string;
    icon?: string;
  }>("POST", "/api/feeds", ({ req, res, body }) => {
    const news = requireNews();

    if (!body.name || !body.url) throw new HttpError(400, "Missing required fields: name, url");

    // Validate URL
    try {
      new URL(body.url);
    } catch {
      throw new HttpError(400, "Invalid URL format");
    }

    let feed;
    try {
      feed = news.addFeed(body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE constraint failed")) throw new HttpError(409, "Feed URL already exists");
      throw new HttpError(500, msg);
    }
    log.info(`Feed added: ${feed.name} (${feed.url})`);
    events?.emit("data.changed", { module: "news", action: "add_feed" });
    server.json(res, 201, { feed }, req);
  });

  // Update a feed
  server.route<{
    name?: string;
    url?: string;
    category?: string;
    color?: string;
    icon?: string;
    is_active?: boolean;
    sort_order?: number;
  }>("PUT", "/api/feeds/:id", ({ params: { id }, body }) => {
    const feed = requireNews().updateFeed(id, body);
    if (!feed) throw new HttpError(404, "Feed not found");

    events?.emit("data.changed", { module: "news", action: "update_feed" });
    return { feed };
  });

  // Toggle feed active status
  server.route("POST", "/api/feeds/:id/toggle", ({ params: { id } }) => {
    const feed = requireNews().toggleFeed(id);
    if (!feed) throw new HttpError(404, "Feed not found");

    events?.emit("data.changed", { module: "news", action: "toggle_feed" });
    return { feed };
  });

  // Delete a feed
  server.route("DELETE", "/api/feeds/:id", ({ params: { id } }) => {
    if (!requireNews().deleteFeed(id)) throw new HttpError(404, "Feed not found");

    events?.emit("data.changed", { module: "news", action: "delete_feed" });
    return { success: true };
  });

  // Refresh news cache
  server.route("POST", "/api/feeds/refresh", async () => {
    const news = requireNews();
    news.refreshCache();
    const result = await news.getNews({ forceRefresh: true });
    return { success: true, articleCount: result.articles.length };
  });

  // ═══════════════════════════════════════════════════════════════════
  // NEWS COLUMNS ROUTES
  // ═══════════════════════════════════════════════════════════════════

  // List all columns
  server.route("GET", "/api/news/columns", () => {
    if (!newsService) return { columns: [] };
    return { columns: newsService.listColumns() };
  });

  // Create a column
  server.route<{ name: string; color?: string; icon?: string }>("POST", "/api/news/columns", ({ req, res, body }) => {
    const news = requireNews();
    if (!body.name) throw new HttpError(400, "Name is required");
    const column = news.createColumn(body);
    events?.emit("data.changed", { module: "news", action: "create_column" });
    server.json(res, 201, { column }, req);
  });

  // Update a column
  server.route<{ name?: string; color?: string; icon?: string; is_active?: boolean; sort_order?: number }>(
    "PUT", "/api/news/columns/:id", ({ params: { id }, body }) => {
      const column = requireNews().updateColumn(id, body);
      if (!column) throw new HttpError(404, "Column not found");
      events?.emit("data.changed", { module: "news", action: "update_column" });
      return { column };
    },
  );

  // Delete a column
  server.route("DELETE", "/api/news/columns/:id", ({ params: { id } }) => {
    if (!requireNews().deleteColumn(id)) throw new HttpError(404, "Column not found");
    events?.emit("data.changed", { module: "news", action: "delete_column" });
    return { success: true };
  });

  // Set feeds for a column.
  // Left raw: route() reads an empty body as {}, which would clear the
  // column's feeds (feed_ids || []) where an empty body used to be rejected.
  server.put("/api/news/columns/:id/feeds", async (req, res) => {
    if (!newsService) {
      server.json(res, 400, { error: "News service not available" });
      return;
    }
    try {
      const id = (req as unknown as { params?: Record<string, string> }).params?.id;
      if (!id) {
        server.json(res, 400, { error: "Missing column ID" });
        return;
      }
      const body = await server.parseBody<{ feed_ids: string[] }>(req);
      newsService.setColumnFeeds(id, body.feed_ids || []);
      const column = newsService.getColumn(id);
      events?.emit("data.changed", { module: "news", action: "set_column_feeds" });
      server.json(res, 200, { column });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // Get all feeds (for column assignment UI)
  server.route("GET", "/api/news/all-feeds", () => {
    if (!newsService) return { feeds: [] };
    return { feeds: newsService.listFeeds(false) };
  });
}
