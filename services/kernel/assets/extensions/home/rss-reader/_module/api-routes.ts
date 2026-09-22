import { HttpError, type KernelHttpServer } from "@kernl/extension-sdk";
import type { RssReaderService } from "./service.js";

export function registerRssReaderRoutes(
  server: KernelHttpServer,
  service: RssReaderService,
): void {
  // ── Bootstrap: everything the UI needs in one shot ──
  // (We deliberately fold catalog data in here too so the SPA boots fast
  //  without a fan-out of HTTP calls. The reader is the consumer of the
  //  registry's tables — sharing the SQLite DB makes this a single round-trip.)
  server.route("GET", "/api/reader/rss/bootstrap", () => {
    const stats = service.getStats();
    const items = service.listItems({ limit: 200 });
    return { stats, items };
  });

  server.route("GET", "/api/reader/rss/items", ({ query }) => ({
    items: service.listItems({
      feed_id:     query.get("feed_id")     ?? undefined,
      category_id: query.get("category_id") ?? undefined,
      unread_only: query.get("unread_only") === "1",
      starred_only: query.get("starred_only") === "1",
      search:      query.get("q")           ?? undefined,
      since:       query.get("since")       ?? undefined,
      limit:       Number(query.get("limit")  ?? "200"),
      offset:      Number(query.get("offset") ?? "0"),
    }),
  }));

  /**
   * The single item, with its body — fetched from the source if the feed did
   * not carry one.
   *
   * The reader already calls this whenever the listed content is under 200
   * characters, which was doing nothing useful: it re-read the same summary
   * out of the same row. Feeds that publish title-and-link only (Hugging Face
   * blog, and most news feeds) left the pane blank. The article is fetched
   * once here and cached onto the item, so this costs one request per article
   * ever, not one per open.
   */
  server.route("GET", "/api/reader/rss/items/:id", async ({ params: { id } }) => {
    const item = service.getItem(id);
    if (!item) throw new HttpError(404, "Not found");

    const bodyLength = (item.content ?? "").replace(/<[^>]+>/g, "").trim().length;
    if (bodyLength < 200 && item.link) {
      const { fetchArticle } = await import("./article.js");
      const article = await fetchArticle(item.link);
      if (article) {
        service.saveFetchedContent(id, article.html);
        item.content = article.html;
      }
    }

    return { item };
  });

  server.route("POST", "/api/reader/rss/items/:id/read", ({ params: { id } }) => {
    service.markRead(id, true);
    return { ok: true };
  });

  server.route("POST", "/api/reader/rss/items/:id/unread", ({ params: { id } }) => {
    service.markRead(id, false);
    return { ok: true };
  });

  server.route("POST", "/api/reader/rss/items/:id/star", ({ params: { id } }) => {
    const starred = service.toggleStar(id);
    return { ok: true, starred };
  });

  // Left raw: route() reads an empty body as {}, which would mark every item
  // in every feed read where an empty body used to be rejected.
  server.post("/api/reader/rss/markAllRead", async (req, res) => {
    try {
      const body = await server.parseBody<{ feed_id?: string; category_id?: string }>(req);
      const count = service.markAllRead({
        feed_id: body.feed_id,
        category_id: body.category_id,
      });
      server.json(res, 200, { ok: true, count });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });
}
