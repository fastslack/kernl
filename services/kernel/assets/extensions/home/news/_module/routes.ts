import type { IncomingMessage } from "node:http";
import type { KernelHttpServer } from "../../../../../src/core/http-server.js";
import type { NewsService } from "./news-service.js";
import type { EventBus } from "../../../../../src/core/event-bus.js";
import { log } from "../../../../../src/core/logger.js";

export function registerNewsRoutes(
  server: KernelHttpServer,
  newsService?: NewsService | null,
  events?: EventBus,
): void {
  // Get news articles from all active feeds
  server.get("/api/dashboard/news", async (req, res) => {
    if (!newsService) {
      server.json(res, 200, { available: false, articles: [], feeds: [], categories: [] });
      return;
    }

    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const categories = url.searchParams.get("categories")?.split(",").filter(Boolean);
      const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
      const forceRefresh = url.searchParams.get("refresh") === "1";

      const news = await newsService.getNews({ categories, limit, forceRefresh });
      server.json(res, 200, { available: true, ...news });
    } catch (err) {
      log.error("News fetch failed", err);
      server.json(res, 500, { error: String(err) });
    }
  });

  // List all user feeds
  server.get("/api/feeds", (_req, res) => {
    if (!newsService) {
      server.json(res, 200, { feeds: [], categories: [] });
      return;
    }
    server.json(res, 200, {
      feeds: newsService.listFeeds(),
      categories: newsService.listCategories(),
    });
  });

  // Add a new feed
  server.post("/api/feeds", async (req, res) => {
    if (!newsService) {
      server.json(res, 400, { error: "News service not available" });
      return;
    }

    try {
      const body = await server.parseBody<{
        name: string;
        url: string;
        category?: string;
        color?: string;
        icon?: string;
      }>(req);

      if (!body.name || !body.url) {
        server.json(res, 400, { error: "Missing required fields: name, url" });
        return;
      }

      // Validate URL
      try {
        new URL(body.url);
      } catch {
        server.json(res, 400, { error: "Invalid URL format" });
        return;
      }

      const feed = newsService.addFeed(body);
      log.info(`Feed added: ${feed.name} (${feed.url})`);
      events?.emit("data.changed", { module: "news", action: "add_feed" });
      server.json(res, 201, { feed });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE constraint failed")) {
        server.json(res, 409, { error: "Feed URL already exists" });
      } else {
        server.json(res, 500, { error: msg });
      }
    }
  });

  // Update a feed
  server.put("/api/feeds/:id", async (req, res) => {
    if (!newsService) {
      server.json(res, 400, { error: "News service not available" });
      return;
    }

    try {
      const id = (req as IncomingMessage & { params?: Record<string, string> }).params?.id;
      if (!id) {
        server.json(res, 400, { error: "Missing feed ID" });
        return;
      }

      const body = await server.parseBody<{
        name?: string;
        url?: string;
        category?: string;
        color?: string;
        icon?: string;
        is_active?: boolean;
        sort_order?: number;
      }>(req);

      const feed = newsService.updateFeed(id, body);
      if (!feed) {
        server.json(res, 404, { error: "Feed not found" });
        return;
      }

      events?.emit("data.changed", { module: "news", action: "update_feed" });
      server.json(res, 200, { feed });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // Toggle feed active status
  server.post("/api/feeds/:id/toggle", async (req, res) => {
    if (!newsService) {
      server.json(res, 400, { error: "News service not available" });
      return;
    }

    try {
      const id = (req as IncomingMessage & { params?: Record<string, string> }).params?.id;
      if (!id) {
        server.json(res, 400, { error: "Missing feed ID" });
        return;
      }

      const feed = newsService.toggleFeed(id);
      if (!feed) {
        server.json(res, 404, { error: "Feed not found" });
        return;
      }

      events?.emit("data.changed", { module: "news", action: "toggle_feed" });
      server.json(res, 200, { feed });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // Delete a feed
  server.delete("/api/feeds/:id", async (req, res) => {
    if (!newsService) {
      server.json(res, 400, { error: "News service not available" });
      return;
    }

    try {
      const id = (req as IncomingMessage & { params?: Record<string, string> }).params?.id;
      if (!id) {
        server.json(res, 400, { error: "Missing feed ID" });
        return;
      }

      const deleted = newsService.deleteFeed(id);
      if (!deleted) {
        server.json(res, 404, { error: "Feed not found" });
        return;
      }

      events?.emit("data.changed", { module: "news", action: "delete_feed" });
      server.json(res, 200, { success: true });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // Refresh news cache
  server.post("/api/feeds/refresh", async (_req, res) => {
    if (!newsService) {
      server.json(res, 400, { error: "News service not available" });
      return;
    }

    try {
      newsService.refreshCache();
      const news = await newsService.getNews({ forceRefresh: true });
      server.json(res, 200, { success: true, articleCount: news.articles.length });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // NEWS COLUMNS ROUTES
  // ═══════════════════════════════════════════════════════════════════

  // List all columns
  server.get("/api/news/columns", (_req, res) => {
    if (!newsService) {
      server.json(res, 200, { columns: [] });
      return;
    }
    server.json(res, 200, { columns: newsService.listColumns() });
  });

  // Create a column
  server.post("/api/news/columns", async (req, res) => {
    if (!newsService) {
      server.json(res, 400, { error: "News service not available" });
      return;
    }
    try {
      const body = await server.parseBody<{ name: string; color?: string; icon?: string }>(req);
      if (!body.name) {
        server.json(res, 400, { error: "Name is required" });
        return;
      }
      const column = newsService.createColumn(body);
      events?.emit("data.changed", { module: "news", action: "create_column" });
      server.json(res, 201, { column });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // Update a column
  server.put("/api/news/columns/:id", async (req, res) => {
    if (!newsService) {
      server.json(res, 400, { error: "News service not available" });
      return;
    }
    try {
      const id = (req as IncomingMessage & { params?: Record<string, string> }).params?.id;
      if (!id) {
        server.json(res, 400, { error: "Missing column ID" });
        return;
      }
      const body = await server.parseBody<{ name?: string; color?: string; icon?: string; is_active?: boolean; sort_order?: number }>(req);
      const column = newsService.updateColumn(id, body);
      if (!column) {
        server.json(res, 404, { error: "Column not found" });
        return;
      }
      events?.emit("data.changed", { module: "news", action: "update_column" });
      server.json(res, 200, { column });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // Delete a column
  server.delete("/api/news/columns/:id", async (req, res) => {
    if (!newsService) {
      server.json(res, 400, { error: "News service not available" });
      return;
    }
    try {
      const id = (req as IncomingMessage & { params?: Record<string, string> }).params?.id;
      if (!id) {
        server.json(res, 400, { error: "Missing column ID" });
        return;
      }
      const deleted = newsService.deleteColumn(id);
      if (!deleted) {
        server.json(res, 404, { error: "Column not found" });
        return;
      }
      events?.emit("data.changed", { module: "news", action: "delete_column" });
      server.json(res, 200, { success: true });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // Set feeds for a column
  server.put("/api/news/columns/:id/feeds", async (req, res) => {
    if (!newsService) {
      server.json(res, 400, { error: "News service not available" });
      return;
    }
    try {
      const id = (req as IncomingMessage & { params?: Record<string, string> }).params?.id;
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
  server.get("/api/news/all-feeds", (_req, res) => {
    if (!newsService) {
      server.json(res, 200, { feeds: [] });
      return;
    }
    server.json(res, 200, { feeds: newsService.listFeeds(false) });
  });
}
