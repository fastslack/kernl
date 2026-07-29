import { z } from "zod";
import { defineTool } from "../../../../../src/core/tool-builder.js";
import { textResult, errorResult } from "../../../../../src/core/helpers.js";
import type { ToolDefinition } from "../../../../../src/core/types.js";
import { RankingService } from "../../../../../src/core/ranking/service.js";
import type { RssRegistryService } from "./service.js";
import type { RssItemWithFeed } from "./types.js";

/** Candidate pool size to rank over when a query narrows the result set. */
const RANK_CANDIDATE_CAP = 500;

const UpdateFrequencySchema = z.enum(["realtime", "hourly", "daily", "weekly"]);
const FeedStatusSchema = z.enum(["active", "disabled", "error", "dead"]);

export function rssRegistryTools(service: RssRegistryService): ToolDefinition[] {
  return [
    defineTool({
      name: "kernel_rss_add",
      description: "Add a new RSS feed to the registry.",
      schema: z.object({
        name: z.string(),
        slug: z.string().optional(),
        description: z.string().optional(),
        category_id: z.string().optional(),
        feed_url: z.string(),
        website_url: z.string().optional(),
        language: z.string().optional(),
        country: z.string().optional(),
        update_frequency: UpdateFrequencySchema.optional(),
        tags: z.array(z.string()).optional(),
        quality_score: z.number().min(0).max(100).optional(),
      }),
      handler: async (input) => {
        try {
          const feed = service.addFeed(input);
          return textResult(`Feed added: **${feed.name}** (${feed.slug})\n- URL: ${feed.feed_url}`);
        } catch (err) {
          return errorResult(`Failed to add feed: ${err}`);
        }
      },
    }),
    defineTool({
      name: "kernel_rss_update",
      description: "Update an existing RSS feed.",
      schema: z.object({
        id: z.string(),
        name: z.string().optional(),
        description: z.string().optional(),
        category_id: z.string().nullable().optional(),
        feed_url: z.string().optional(),
        website_url: z.string().optional(),
        language: z.string().optional(),
        country: z.string().optional(),
        update_frequency: UpdateFrequencySchema.optional(),
        status: FeedStatusSchema.optional(),
        tags: z.array(z.string()).optional(),
        quality_score: z.number().min(0).max(100).optional(),
      }),
      handler: async ({ id, ...changes }) => {
        const feed = service.updateFeed(id, changes);
        if (!feed) return errorResult("Feed not found");
        return textResult(`Updated feed: **${feed.name}**`);
      },
    }),
    defineTool({
      name: "kernel_rss_delete",
      description: "Remove a feed from the registry.",
      schema: z.object({ id: z.string() }),
      handler: async ({ id }) => {
        const ok = service.deleteFeed(id);
        return ok ? textResult("Feed deleted") : errorResult("Feed not found");
      },
    }),
    defineTool({
      name: "kernel_rss_get",
      description: "Get details of a specific feed.",
      schema: z.object({
        id: z.string().optional(),
        slug: z.string().optional(),
      }),
      handler: async ({ id, slug }) => {
        const feed = id
          ? service.getFeed(id)
          : slug
            ? service.getFeedBySlug(slug)
            : null;
        if (!feed) return errorResult("Feed not found");
        return textResult(
          `## ${feed.name}\n` +
            `- Slug: ${feed.slug}\n` +
            `- URL: ${feed.feed_url}\n` +
            `- Status: ${feed.status}\n` +
            `- Quality: ${feed.quality_score}/100\n` +
            `- Items: ${feed.item_count}` +
            (feed.last_check_at ? `\n- Last check: ${feed.last_check_at}` : ""),
        );
      },
    }),
    defineTool({
      name: "kernel_rss_list",
      description: "List RSS feeds with optional filters.",
      schema: z.object({
        category_id: z.string().optional(),
        status: FeedStatusSchema.optional(),
        language: z.string().optional(),
        country: z.string().optional(),
        min_quality: z.number().optional(),
        limit: z.number().optional(),
        offset: z.number().optional(),
      }),
      handler: async (query) => {
        const feeds = service.listFeeds(query);
        if (feeds.length === 0) return textResult("No feeds found");
        let md = `## RSS Feeds (${feeds.length})\n\n`;
        for (const f of feeds) {
          const status = f.status !== "active" ? ` [${f.status.toUpperCase()}]` : "";
          md += `- **${f.name}** (${f.slug})${status} — Q:${f.quality_score} — ${f.category_name ?? "Uncat"}\n`;
        }
        return textResult(md);
      },
    }),
    defineTool({
      name: "kernel_rss_search",
      description: "Search feeds by name, description, or tags.",
      schema: z.object({
        query: z.string(),
        category_id: z.string().optional(),
        language: z.string().optional(),
        limit: z.number().optional(),
      }),
      handler: async (input) => {
        const feeds = service.searchFeeds(input);
        if (feeds.length === 0) return textResult("No feeds found");
        return textResult(
          `## Search Results (${feeds.length})\n\n` +
            feeds.map((f) => `- **${f.name}** (${f.slug})\n  ${f.description?.slice(0, 100) || f.feed_url}`).join("\n"),
        );
      },
    }),
    defineTool({
      name: "kernel_rss_test",
      description: "Validate a feed by fetching and parsing it.",
      schema: z.object({
        id: z.string().optional(),
        url: z.string().optional(),
      }),
      handler: async ({ id, url }) => {
        const result = id
          ? await service.testFeed(id)
          : url
            ? await service.validateFeedUrl(url)
            : null;
        if (!result) return errorResult("Provide either id or url");
        if (!result.valid) return errorResult(`Validation failed: ${result.error}`);
        return textResult(
          `Feed is valid (${result.response_time_ms}ms)\n` +
            `- Title: ${result.title ?? "Untitled"}\n` +
            `- Items: ${result.item_count}\n` +
            (result.last_item_date ? `- Most recent: ${result.last_item_date}` : ""),
        );
      },
    }),
    defineTool({
      name: "kernel_rss_fetch",
      description: "Fetch and persist new items from a feed (or all active feeds).",
      schema: z.object({ id: z.string().optional() }),
      handler: async ({ id }) => {
        if (id) {
          const r = await service.fetchFeed(id);
          if (!r.ok) return errorResult(`Fetch failed: ${r.error}`);
          return textResult(`Fetched ${r.feed_id}: ${r.new_items} new of ${r.total_items} total`);
        }
        const all = await service.fetchAllActive();
        const newTotal = all.reduce((acc, r) => acc + r.new_items, 0);
        const okCount = all.filter((r) => r.ok).length;
        return textResult(
          `Refreshed ${okCount}/${all.length} feeds — ${newTotal} new items`,
        );
      },
    }),
    defineTool({
      name: "kernel_rss_items",
      description: "List recent items across feeds with filters.",
      schema: z.object({
        feed_id: z.string().optional(),
        category_id: z.string().optional(),
        language: z.string().optional(),
        since: z.string().optional(),
        search: z.string().optional(),
        limit: z.number().optional(),
        query: z
          .string()
          .optional()
          .describe("Rank items by relevance to this query, capped to limit."),
      }),
      handler: async (q) => {
        const { query } = q;
        let items: RssItemWithFeed[];
        if (query && query.trim()) {
          // Ranking path: widen the candidate pool (ignore the SQL limit so the
          // best matches aren't truncated by recency first), then rank + cap.
          const k = q.limit ?? 24;
          const candidates = service.listItems({ ...q, limit: RANK_CANDIDATE_CAP });
          const ranking = new RankingService(service.getEmbeddingsClient());
          const out = await ranking.rankAndPage({
            items: candidates,
            query,
            key: (r) => ({
              id: String(r.id),
              text: `${r.title ?? ""} ${r.description ?? r.content ?? ""}`,
            }),
            k,
          });
          items = out.ranked;
        } else {
          items = service.listItems(q);
        }
        if (items.length === 0) return textResult("No items");
        return textResult(
          `## Items (${items.length})\n\n` +
            items
              .slice(0, 30)
              .map(
                (i) =>
                  `- **${i.title || "(untitled)"}** — ${i.feed_name}` +
                  (i.published_at ? `  \n  ${i.published_at}` : ""),
              )
              .join("\n"),
        );
      },
    }),
    defineTool({
      name: "kernel_rss_categories",
      description: "List all RSS categories.",
      schema: z.object({}),
      handler: async () => {
        const cats = service.listCategories();
        if (cats.length === 0) return textResult("No categories");
        return textResult(
          `## Categories (${cats.length})\n\n` +
            cats.map((c) => `- ${c.icon || "📁"} ${c.name}`).join("\n"),
        );
      },
    }),
    defineTool({
      name: "kernel_rss_seed",
      description: "Load the built-in catalog of curated feeds.",
      schema: z.object({ force: z.boolean().optional() }),
      handler: async ({ force }) => {
        const r = service.seedBuiltins(force ?? false);
        return textResult(
          `Seeded — categories: ${r.categories}, feeds: ${r.feeds}`,
        );
      },
    }),
    defineTool({
      name: "kernel_rss_discover",
      description: "Find feeds matching a topic. Useful for research engines.",
      schema: z.object({
        topic: z.string(),
        tags: z.array(z.string()).optional(),
      }),
      handler: async ({ topic, tags }) => {
        const feeds = service.discoverFeeds(topic, tags);
        if (feeds.length === 0) return textResult("No feeds matched");
        return textResult(
          `## Discovered (${feeds.length})\n\n` +
            feeds.map((f) => `- **${f.name}** (Q:${f.quality_score})`).join("\n"),
        );
      },
    }),
    defineTool({
      name: "kernel_rss_stats",
      description: "Statistics about the RSS registry.",
      schema: z.object({}),
      handler: async () => {
        const s = service.getStats();
        return textResult(
          `## RSS Registry Stats\n\n` +
            `- Total feeds: ${s.total_feeds}\n` +
            `- Active: ${s.active_feeds}\n` +
            `- With errors: ${s.error_feeds}\n` +
            `- Avg quality: ${s.avg_quality_score}/100\n` +
            `- Total items: ${s.total_items}\n` +
            `- Items last 24h: ${s.items_last_24h}`,
        );
      },
    }),
  ];
}
