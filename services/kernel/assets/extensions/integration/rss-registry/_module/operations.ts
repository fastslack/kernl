/**
 * RSS-registry operations reachable over both the WS RPC and HTTP.
 *
 * The dashboard calls some of these through `rpcOrCall` (WS first, the route
 * when the bridge is down), so each RPC action and its route are one function
 * here: rpc-actions.ts exposes the map, api-routes.ts binds the paths. The two
 * copies had drifted: `registry.rss.toggle` without a `status` always set the
 * feed active, so the registry page's toggle could never disable a feed over
 * WS, while the route flipped it; the RPC side answered failures with a
 * resolved `{ error }` instead of failing; search ignored `language` and the
 * items list read `search` over one road and `q` over the other.
 */

import { HttpError, pickArgs, type Operation } from "@kernl/extension-sdk";
import type { RssRegistryService } from "./service.js";
import type { FeedStatus, UpdateFrequency } from "./types.js";

const FEED_FIELDS = {
  name: "string", slug: "string", description: "string", category_id: "string", feed_url: "string",
  website_url: "string", language: "string", country: "string", update_frequency: "string",
  tags: "string[]", quality_score: "number",
} as const;

const CATEGORY_FIELDS = { name: "string", description: "string", icon: "string", sort_order: "number" } as const;

export function rssRegistryOperations(service: RssRegistryService): Record<string, Operation> {
  const requireId = (input: Record<string, unknown>): string => {
    const id = pickArgs(input, { id: "string" }).id;
    if (!id) throw new HttpError(400, "id is required");
    return id;
  };

  return {
    // ── Bootstrap data for the dashboard registry view ──
    "registry.rss.list": () => ({
      categories: service.listCategories(),
      feeds: service.listFeeds(),
      stats: service.getStats(),
    }),

    "registry.rss.search": (input) => {
      const args = pickArgs(input, { q: "string", category: "string", language: "string" });
      return {
        results: service.searchFeeds({
          query: args.q ?? "",
          category_id: args.category || undefined,
          language: args.language || undefined,
        }),
      };
    },

    "registry.rss.items": (input) => {
      const args = pickArgs(input, {
        feed_id: "string", category_id: "string", language: "string", since: "string",
        search: "string", q: "string", limit: "number", offset: "number",
      });
      const items = service.listItems({
        feed_id: args.feed_id || undefined,
        category_id: args.category_id || undefined,
        language: args.language || undefined,
        since: args.since || undefined,
        search: args.search ?? args.q,
        limit: args.limit ?? 100,
        offset: args.offset ?? 0,
      });
      const counts: Record<string, number> = {};
      for (const [k, v] of service.itemCountsByFeed().entries()) counts[k] = v;
      return { items, counts };
    },

    "registry.rss.itemGet": (input) => {
      const item = service.getItem(requireId(input));
      if (!item) throw new HttpError(404, "Item not found");
      return { item };
    },

    // ── Live preview (no persistence) — for "add feed" UX ──
    "registry.rss.preview": (input) => {
      const url = pickArgs(input, { url: "string" }).url;
      if (!url) throw new HttpError(400, "url is required");
      return service.previewFeed(url);
    },

    // ── Refresh (fetch new items): one feed, or every active one ──
    "registry.rss.refresh": async (input) => {
      const id = pickArgs(input, { id: "string" }).id;
      if (id) return service.fetchFeed(id);
      return { results: await service.fetchAllActive() };
    },

    // ── Test (validate URL) ──
    "registry.rss.test": (input) => service.testFeed(requireId(input)),

    // ── Toggle active/disabled, or set one of the two explicitly ──
    "registry.rss.toggle": (input) => {
      const id = requireId(input);
      const feed = service.getFeed(id);
      if (!feed) throw new HttpError(404, "Feed not found");
      const asked = pickArgs(input, { status: "string" }).status;
      const status: FeedStatus = asked === "active" || asked === "disabled"
        ? asked
        : feed.status === "active" ? "disabled" : "active";
      return { success: true, feed: service.updateFeed(id, { status }) };
    },

    // ── Feed CRUD ──
    "registry.rss.add": (input) => {
      const args = pickArgs(input, FEED_FIELDS);
      if (!args.feed_url || !args.name) throw new HttpError(400, "name and feed_url are required");
      return {
        feed: service.addFeed({
          ...args,
          name: args.name,
          feed_url: args.feed_url,
          update_frequency: args.update_frequency as UpdateFrequency | undefined,
        }),
      };
    },

    "registry.rss.delete": (input) => {
      if (!service.deleteFeed(requireId(input))) throw new HttpError(404, "Feed not found", { ok: false });
      return { ok: true };
    },

    // ── Category CRUD (inline folder editing in the reader sidebar) ──
    "registry.rss.categoryAdd": (input) => {
      const args = pickArgs(input, { ...CATEGORY_FIELDS, parent_id: "string" });
      const name = args.name?.trim() ?? "";
      if (!name) throw new HttpError(400, "name is required");
      return { category: service.addCategory({ ...args, name }) };
    },

    "registry.rss.categoryUpdate": (input) => {
      const category = service.updateCategory(requireId(input), pickArgs(input, CATEGORY_FIELDS));
      if (!category) throw new HttpError(404, "Category not found");
      return { category };
    },

    "registry.rss.categoryDelete": (input) => {
      if (!service.deleteCategory(requireId(input))) throw new HttpError(404, "Category not found", { ok: false });
      return { ok: true };
    },
  };
}
