import { HttpError, type KernelHttpServer, type EventBus } from "@kernl/extension-sdk";
import type { NewsService } from "./news-service.js";
import { newsOperations } from "./operations.js";

type Method = Parameters<KernelHttpServer["operation"]>[0];

export function registerNewsRoutes(
  server: KernelHttpServer,
  newsService?: NewsService | null,
  events?: EventBus,
): void {
  // ── Operations shared with the WS RPC (operations.ts) ─────────
  // The pages reach these through rpcOrCall, WS first and HTTP when the
  // bridge is down, so both roads run the same function. A path param is
  // named after the input key the operation reads.
  const op = newsOperations(newsService ?? null, events);
  ([
    ["GET", "/api/dashboard/news", "dashboard.news"],
    ["GET", "/api/feeds", "feeds.list"],
    ["POST", "/api/feeds/:id/toggle", "feeds.toggle"],
    ["DELETE", "/api/feeds/:id", "feeds.delete"],
    ["POST", "/api/feeds/refresh", "feeds.refresh"],
    ["GET", "/api/news/columns", "news.columns.list"],
    ["PUT", "/api/news/columns/:id", "news.columns.update"],
    ["DELETE", "/api/news/columns/:id", "news.columns.delete"],
    ["GET", "/api/news/all-feeds", "feeds.listAll"],
  ] as Array<[Method, string, string]>).forEach(([method, path, name]) => server.operation(method, path, op[name]));

  // Creations answer 201, which a bound operation (always 200) cannot.
  const created = (path: string, name: string) =>
    server.route<Record<string, unknown>>("POST", path, async ({ req, res, body, query }) => {
      const out = await op[name]({ ...Object.fromEntries(query), ...(body ?? {}) });
      server.json(res, 201, out, req);
    });
  created("/api/feeds", "feeds.add");
  created("/api/news/columns", "news.columns.create");

  // Set feeds for a column. `requireBody` keeps an empty body a 400: read as
  // {}, it would clear the column's feeds.
  server.operation("PUT", "/api/news/columns/:id/feeds", op["news.columns.assignFeeds"], { requireBody: true });

  // Update a feed (no RPC twin).
  server.route<{
    name?: string;
    url?: string;
    category?: string;
    color?: string;
    icon?: string;
    is_active?: boolean;
    sort_order?: number;
  }>("PUT", "/api/feeds/:id", ({ params: { id }, body }) => {
    if (!newsService) throw new HttpError(400, "News service not available");
    const feed = newsService.updateFeed(id, body);
    if (!feed) throw new HttpError(404, "Feed not found");

    events?.emit("data.changed", { module: "news", action: "update_feed" });
    return { feed };
  });
}
