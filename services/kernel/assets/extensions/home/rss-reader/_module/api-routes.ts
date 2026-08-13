import type { KernelHttpServer } from "../../../../../src/core/http-server.js";
import type { IncomingMessage } from "node:http";
import type { RssReaderService } from "./service.js";

export function registerRssReaderRoutes(
  server: KernelHttpServer,
  service: RssReaderService,
): void {
  // ── Bootstrap: everything the UI needs in one shot ──
  // (We deliberately fold catalog data in here too so the SPA boots fast
  //  without a fan-out of HTTP calls. The reader is the consumer of the
  //  registry's tables — sharing the SQLite DB makes this a single round-trip.)
  server.get("/api/reader/rss/bootstrap", (_req, res) => {
    try {
      const stats = service.getStats();
      const items = service.listItems({ limit: 200 });
      server.json(res, 200, { stats, items });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.get("/api/reader/rss/items", (req, res) => {
    try {
      const url = new URL(req.url ?? "", `http://${req.headers.host}`);
      const items = service.listItems({
        feed_id:     url.searchParams.get("feed_id")     ?? undefined,
        category_id: url.searchParams.get("category_id") ?? undefined,
        unread_only: url.searchParams.get("unread_only") === "1",
        starred_only: url.searchParams.get("starred_only") === "1",
        search:      url.searchParams.get("q")           ?? undefined,
        since:       url.searchParams.get("since")       ?? undefined,
        limit:       Number(url.searchParams.get("limit")  ?? "200"),
        offset:      Number(url.searchParams.get("offset") ?? "0"),
      });
      server.json(res, 200, { items });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

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
  server.get("/api/reader/rss/items/:id", async (req, res) => {
    try {
      const id = (req as IncomingMessage & { params?: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "Missing item ID" }); return; }
      const item = service.getItem(id);
      if (!item) { server.json(res, 404, { error: "Not found" }); return; }

      const bodyLength = (item.content ?? "").replace(/<[^>]+>/g, "").trim().length;
      if (bodyLength < 200 && item.link) {
        const { fetchArticle } = await import("./article.js");
        const article = await fetchArticle(item.link);
        if (article) {
          service.saveFetchedContent(id, article.html);
          item.content = article.html;
        }
      }

      server.json(res, 200, { item });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.post("/api/reader/rss/items/:id/read", (req, res) => {
    try {
      const id = (req as IncomingMessage & { params?: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "Missing item ID" }); return; }
      service.markRead(id, true);
      server.json(res, 200, { ok: true });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.post("/api/reader/rss/items/:id/unread", (req, res) => {
    try {
      const id = (req as IncomingMessage & { params?: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "Missing item ID" }); return; }
      service.markRead(id, false);
      server.json(res, 200, { ok: true });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.post("/api/reader/rss/items/:id/star", (req, res) => {
    try {
      const id = (req as IncomingMessage & { params?: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "Missing item ID" }); return; }
      const starred = service.toggleStar(id);
      server.json(res, 200, { ok: true, starred });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

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
