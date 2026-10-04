/**
 * News operations the news page and the dashboard reach over both the WS RPC
 * and HTTP.
 *
 * Each is called through `rpcOrCall`, so the RPC action and the HTTP route
 * are the same request by two roads and have to answer alike. They used to be
 * written twice and had drifted: `news.columns.assignFeeds` over RPC read
 * `columnId`/`feedIds` while the page sends `id`/`feed_ids`, so every feed
 * assignment over WS was a silent no-op; `feeds.add` over RPC skipped the URL
 * check and the duplicate-URL 409; `dashboard.news` over RPC ignored
 * `categories` and `refresh`; the RPC answered failures as a resolved
 * `{ error }` and wrapped results in `{ ok, … }`. Now dashboard-rpc-actions.ts
 * exposes this map and routes.ts binds each entry to its path; where the two
 * disagreed, the fuller behaviour won and the HTTP body shape was kept.
 */

import { HttpError, pickArgs, log, type Operation, type EventBus } from "@kernl/extension-sdk";
import type { NewsService } from "./news-service.js";

export function newsOperations(newsService: NewsService | null, events?: EventBus | null): Record<string, Operation> {
  const requireNews = (): NewsService => {
    if (!newsService) throw new HttpError(400, "News service not available");
    return newsService;
  };
  const requireId = (input: Record<string, unknown>): string => {
    const { id } = pickArgs(input, { id: "string" });
    if (!id) throw new HttpError(400, "id is required");
    return id;
  };
  const changed = (action: string) => { events?.emit("data.changed", { module: "news", action }); };

  /**
   * Articles from all active feeds. `categories` is a comma list (or an
   * array over RPC); `refresh` is true, or "1" in a query string.
   */
  const getNews: Operation = async (input) => {
    if (!newsService) return { available: false, articles: [], feeds: [], categories: [] };
    const args = pickArgs(input, { categories: "string", limit: "number" });
    const categories = pickArgs(input, { categories: "string[]" }).categories ?? args.categories?.split(",").filter(Boolean);
    const forceRefresh = input.refresh === true || input.refresh === "1";
    return { available: true, ...(await newsService.getNews({ categories, limit: args.limit ?? 50, forceRefresh })) };
  };

  return {
    "news.list": getNews,
    "dashboard.news": getNews,

    "feeds.list": () => {
      if (!newsService) return { feeds: [], categories: [] };
      return { feeds: newsService.listFeeds(), categories: newsService.listCategories() };
    },

    // Every feed, active or not (for the column assignment UI).
    "feeds.listAll": () => {
      if (!newsService) return { feeds: [] };
      return { feeds: newsService.listFeeds(false) };
    },

    "feeds.refresh": async () => {
      const news = requireNews();
      news.refreshCache();
      const result = await news.getNews({ forceRefresh: true });
      return { success: true, articleCount: result.articles.length };
    },

    "feeds.add": (input) => {
      const news = requireNews();
      const args = pickArgs(input, { name: "string", url: "string", category: "string", color: "string", icon: "string" });
      if (!args.name || !args.url) throw new HttpError(400, "Missing required fields: name, url");
      try {
        new URL(args.url);
      } catch {
        throw new HttpError(400, "Invalid URL format");
      }
      let feed;
      try {
        feed = news.addFeed({ ...args, name: args.name, url: args.url });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("UNIQUE constraint failed")) throw new HttpError(409, "Feed URL already exists");
        throw new HttpError(500, msg);
      }
      log.info(`Feed added: ${feed.name} (${feed.url})`);
      changed("add_feed");
      return { feed };
    },

    "feeds.toggle": (input) => {
      const feed = requireNews().toggleFeed(requireId(input));
      if (!feed) throw new HttpError(404, "Feed not found");
      changed("toggle_feed");
      return { feed };
    },

    "feeds.delete": (input) => {
      if (!requireNews().deleteFeed(requireId(input))) throw new HttpError(404, "Feed not found");
      changed("delete_feed");
      return { success: true };
    },

    "news.columns.list": () => {
      if (!newsService) return { columns: [] };
      return { columns: newsService.listColumns() };
    },

    "news.columns.create": (input) => {
      const news = requireNews();
      const args = pickArgs(input, { name: "string", color: "string", icon: "string" });
      if (!args.name) throw new HttpError(400, "Name is required");
      const column = news.createColumn({ ...args, name: args.name });
      changed("create_column");
      return { column };
    },

    "news.columns.update": (input) => {
      const news = requireNews();
      const column = news.updateColumn(requireId(input), pickArgs(input, {
        name: "string", color: "string", icon: "string", is_active: "boolean", sort_order: "number",
      }));
      if (!column) throw new HttpError(404, "Column not found");
      changed("update_column");
      return { column };
    },

    "news.columns.delete": (input) => {
      if (!requireNews().deleteColumn(requireId(input))) throw new HttpError(404, "Column not found");
      changed("delete_column");
      return { success: true };
    },

    // Replaces the column's feeds. `feed_ids` must be an array — `[]` clears
    // the column on purpose; a request without it is rejected rather than
    // read as "no feeds", which is what an empty body used to do.
    // `columnId`/`feedIds` are the names the RPC used to read.
    "news.columns.assignFeeds": (input) => {
      const news = requireNews();
      const args = pickArgs(input, { id: "string", columnId: "string", feed_ids: "string[]", feedIds: "string[]" });
      const id = args.id || args.columnId;
      if (!id) throw new HttpError(400, "Missing column ID");
      const feedIds = args.feed_ids ?? args.feedIds;
      if (!feedIds) throw new HttpError(400, "feed_ids must be an array of feed ids");
      if (!news.getColumn(id)) throw new HttpError(404, "Column not found");
      news.setColumnFeeds(id, feedIds);
      changed("set_column_feeds");
      return { column: news.getColumn(id) };
    },
  };
}
