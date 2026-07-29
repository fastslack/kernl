import type { KernelHttpServer } from "../../../../../src/core/http-server.js";
import { log } from "../../../../../src/core/logger.js";
import type { BooksService } from "./service.js";
import type { BookListFilter } from "./types.js";

export function registerBooksRoutes(server: KernelHttpServer, service: BooksService): void {
  // GET /api/books/search?q=...&language=es&page=2&sort=downloads
  server.get("/api/books/search", async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const filter: BookListFilter = {
        query: url.searchParams.get("q") ?? "",
        language: url.searchParams.get("language") ?? undefined,
        collection: url.searchParams.get("collection") ?? undefined,
        yearMin: numParam(url.searchParams.get("yearMin")),
        yearMax: numParam(url.searchParams.get("yearMax")),
        sort: (url.searchParams.get("sort") as BookListFilter["sort"]) ?? "downloads",
        page: numParam(url.searchParams.get("page")) ?? 1,
        limit: numParam(url.searchParams.get("limit")) ?? 24,
      };
      const result = await service.search(filter);
      server.json(res, 200, result);
    } catch (err) {
      log.error("books: search failed", err);
      server.json(res, 502, { error: extractMessage(err) });
    }
  });

  // GET /api/books/details/:identifier
  server.get("/api/books/details", async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const id = url.searchParams.get("id") ?? "";
      if (!id) return server.json(res, 400, { error: "id is required" });
      const details = await service.details(id);
      server.json(res, 200, details);
    } catch (err) {
      log.error("books: details failed", err);
      server.json(res, 502, { error: extractMessage(err) });
    }
  });

  // GET /api/books/watchlist
  server.get("/api/books/watchlist", (_req, res) => {
    try {
      const items = service.listWatchlist();
      server.json(res, 200, { items });
    } catch (err) {
      log.error("books: watchlist failed", err);
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // POST /api/books/watchlist  body: { identifier, title?, creator?, year?, cover_url? }
  server.post("/api/books/watchlist", async (req, res) => {
    try {
      const body = await server.parseBody<{ identifier: string; title?: string; creator?: string; year?: number; cover_url?: string }>(req);
      if (!body?.identifier) return server.json(res, 400, { error: "identifier is required" });
      service.addToWatchlist(body);
      server.json(res, 200, { ok: true });
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // DELETE /api/books/watchlist?id=…
  server.delete("/api/books/watchlist", (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const id = url.searchParams.get("id") ?? "";
      if (!id) return server.json(res, 400, { error: "id is required" });
      service.removeFromWatchlist(id);
      server.json(res, 200, { ok: true });
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // POST /api/books/progress  body: { identifier, progress: 0..1 }
  server.post("/api/books/progress", async (req, res) => {
    try {
      const body = await server.parseBody<{ identifier: string; progress: number }>(req);
      if (!body?.identifier || typeof body.progress !== "number") {
        return server.json(res, 400, { error: "identifier and progress required" });
      }
      service.setReadProgress(body.identifier, body.progress);
      server.json(res, 200, { ok: true });
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });
}

function numParam(s: string | null): number | undefined {
  if (!s) return undefined;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
