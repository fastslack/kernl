/**
 * News dashboard RPC slice — `news.*`, `feeds.*`, `news.columns.*`, and the
 * `dashboard.news` shortcut used by the home page.
 */

import type { RpcAction } from "../../../../../src/core/mtw/rpc-handler.js";
import type { NewsService } from "./news-service.js";

export interface NewsDashboardRpcDeps {
  newsService: NewsService;
}

export function newsDashboardRpcActions(deps: NewsDashboardRpcDeps): RpcAction[] {
  const { newsService: news } = deps;
  return [
    {
      name: "news.list",
      handler: async (args) => {
        const categories = typeof args.categories === "string" ? args.categories.split(",").filter(Boolean) : undefined;
        const limit = typeof args.limit === "number" ? args.limit : 50;
        const forceRefresh = args.refresh === true;
        return { available: true, ...(await news.getNews({ categories, limit, forceRefresh })) };
      },
    },
    {
      name: "feeds.list",
      handler: async () => ({ feeds: news.listFeeds(), categories: news.listCategories() }),
    },
    {
      name: "feeds.listAll",
      handler: async () => ({ feeds: news.listFeeds(false) }),
    },
    {
      name: "feeds.refresh",
      handler: async () => {
        news.refreshCache();
        const data = await news.getNews({ forceRefresh: true });
        return { ok: true, articles: data.articles.length };
      },
    },
    {
      name: "feeds.add",
      handler: async (args) => {
        const name = typeof args.name === "string" ? args.name : "";
        const url = typeof args.url === "string" ? args.url : "";
        if (!name || !url) return { error: "name and url are required" };
        const feed = news.addFeed({
          name,
          url,
          category: typeof args.category === "string" ? args.category : undefined,
          color: typeof args.color === "string" ? args.color : undefined,
          icon: typeof args.icon === "string" ? args.icon : undefined,
        });
        return { ok: true, feed };
      },
    },
    {
      name: "feeds.delete",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) return { error: "id is required" };
        const deleted = news.deleteFeed(id);
        return { ok: deleted };
      },
    },
    {
      name: "feeds.toggle",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) return { error: "id is required" };
        const feed = news.toggleFeed(id);
        if (!feed) return { error: "Feed not found" };
        return { ok: true, feed };
      },
    },
    {
      name: "news.columns.list",
      handler: async () => ({ columns: news.listColumns() }),
    },
    {
      name: "news.columns.create",
      handler: async (args) => {
        const name = typeof args.name === "string" ? args.name : "";
        if (!name) return { error: "name is required" };
        const column = news.createColumn({
          name,
          color: typeof args.color === "string" ? args.color : undefined,
          icon: typeof args.icon === "string" ? args.icon : undefined,
        });
        return { ok: true, column };
      },
    },
    {
      name: "news.columns.update",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) return { error: "id is required" };
        const column = news.updateColumn(id, {
          name: typeof args.name === "string" ? args.name : undefined,
          color: typeof args.color === "string" ? args.color : undefined,
          icon: typeof args.icon === "string" ? args.icon : undefined,
          is_active: typeof args.is_active === "boolean" ? args.is_active : undefined,
          sort_order: typeof args.sort_order === "number" ? args.sort_order : undefined,
        });
        if (!column) return { error: "Column not found" };
        return { ok: true, column };
      },
    },
    {
      name: "news.columns.delete",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) return { error: "id is required" };
        const deleted = news.deleteColumn(id);
        return { ok: deleted };
      },
    },
    {
      name: "news.columns.assignFeeds",
      handler: async (args) => {
        const columnId = typeof args.columnId === "string" ? args.columnId : "";
        const feedIds = Array.isArray(args.feedIds) ? (args.feedIds as string[]) : [];
        if (!columnId) return { error: "columnId is required" };
        news.setColumnFeeds(columnId, feedIds);
        return { ok: true };
      },
    },
    {
      name: "dashboard.news",
      handler: async (args) => {
        const limit = typeof args.limit === "number" ? args.limit : 50;
        return { available: true, ...(await news.getNews({ limit })) };
      },
    },
  ];
}
