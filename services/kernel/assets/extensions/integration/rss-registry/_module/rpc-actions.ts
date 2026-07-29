/**
 * RPC actions owned by the rss-registry extension. Returned by
 * `module.getRpcActions()` and registered against the kernel's `mtwRpc`
 * registry by the bootstrap after the extension loads.
 */
import type { RssRegistryService } from "./service.js";

interface RpcAction {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export function rssRegistryRpcActions(service: RssRegistryService): RpcAction[] {
  return [
    {
      name: "registry.rss.list",
      handler: async () => ({
        categories: service.listCategories(),
        feeds: service.listFeeds(),
        stats: service.getStats(),
      }),
    },
    {
      name: "registry.rss.search",
      handler: async (args) => ({
        results: service.searchFeeds({
          query:       typeof args.q === "string" ? args.q : "",
          category_id: typeof args.category === "string" ? args.category : undefined,
        }),
      }),
    },
    {
      name: "registry.rss.toggle",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) return { error: "id is required" };
        const status = typeof args.status === "string" ? args.status as "active" | "disabled" : "active";
        const feed = service.updateFeed(id, { status });
        if (!feed) return { error: "Feed not found" };
        return { ok: true, feed };
      },
    },
    {
      name: "registry.rss.test",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) return { error: "id is required" };
        return service.testFeed(id);
      },
    },
    {
      name: "registry.rss.refresh",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (id) return service.fetchFeed(id);
        const all = await service.fetchAllActive();
        return { results: all };
      },
    },
    {
      name: "registry.rss.items",
      handler: async (args) => {
        const items = service.listItems({
          feed_id:     typeof args.feed_id     === "string" ? args.feed_id     : undefined,
          category_id: typeof args.category_id === "string" ? args.category_id : undefined,
          language:    typeof args.language    === "string" ? args.language    : undefined,
          since:       typeof args.since       === "string" ? args.since       : undefined,
          search:      typeof args.search      === "string" ? args.search
                       : (typeof args.q === "string" ? args.q : undefined),
          limit:       typeof args.limit       === "number" ? args.limit       : 100,
          offset:      typeof args.offset      === "number" ? args.offset      : 0,
        });
        const counts: Record<string, number> = {};
        for (const [k, v] of service.itemCountsByFeed().entries()) counts[k] = v;
        return { items, counts };
      },
    },
    {
      name: "registry.rss.itemGet",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) return { error: "id is required" };
        const item = service.getItem(id);
        if (!item) return { error: "Item not found" };
        return { item };
      },
    },
    {
      name: "registry.rss.preview",
      handler: async (args) => {
        const url = typeof args.url === "string" ? args.url : "";
        if (!url) return { error: "url is required" };
        return service.previewFeed(url);
      },
    },
    {
      name: "registry.rss.add",
      handler: async (args) => {
        if (typeof args.feed_url !== "string" || typeof args.name !== "string") {
          return { error: "name and feed_url are required" };
        }
        const feed = service.addFeed(args as never);
        return { feed };
      },
    },
    {
      name: "registry.rss.delete",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) return { error: "id is required" };
        const ok = service.deleteFeed(id);
        return { ok };
      },
    },
    // ── Category actions (parallel to the HTTP /categories routes) ──
    {
      name: "registry.rss.categoryAdd",
      handler: async (args) => {
        if (typeof args.name !== "string" || !args.name.trim()) {
          return { error: "name is required" };
        }
        const category = service.addCategory(args as never);
        return { category };
      },
    },
    {
      name: "registry.rss.categoryUpdate",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) return { error: "id is required" };
        const category = service.updateCategory(id, args);
        if (!category) return { error: "Category not found" };
        return { category };
      },
    },
    {
      name: "registry.rss.categoryDelete",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) return { error: "id is required" };
        const ok = service.deleteCategory(id);
        return { ok };
      },
    },
  ];
}
