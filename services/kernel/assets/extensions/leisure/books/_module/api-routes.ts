import { HttpError, type KernelHttpServer, log } from "@kernl/extension-sdk";
import type { BooksService } from "./service.js";
import type { BookListFilter } from "./types.js";

export function registerBooksRoutes(server: KernelHttpServer, service: BooksService): void {
  // GET /api/books/search?q=...&language=es&page=2&sort=downloads
  server.route("GET", "/api/books/search", ({ query }) => upstream("search", () => {
    const filter: BookListFilter = {
      query: query.get("q") ?? "",
      language: query.get("language") ?? undefined,
      collection: query.get("collection") ?? undefined,
      yearMin: numParam(query.get("yearMin")),
      yearMax: numParam(query.get("yearMax")),
      sort: (query.get("sort") as BookListFilter["sort"]) ?? "downloads",
      page: numParam(query.get("page")) ?? 1,
      limit: numParam(query.get("limit")) ?? 24,
    };
    return service.search(filter);
  }));

  // GET /api/books/details/:identifier
  server.route("GET", "/api/books/details", ({ query }) => {
    const id = query.get("id") ?? "";
    if (!id) throw new HttpError(400, "id is required");
    return upstream("details", () => service.details(id));
  });

  // GET /api/books/watchlist
  server.route("GET", "/api/books/watchlist", () => ({ items: service.listWatchlist() }));

  // POST /api/books/watchlist  body: { identifier, title?, creator?, year?, cover_url? }
  server.route<{ identifier: string; title?: string; creator?: string; year?: number; cover_url?: string }>(
    "POST", "/api/books/watchlist", ({ body }) => {
      if (!body?.identifier) throw new HttpError(400, "identifier is required");
      service.addToWatchlist(body);
      return { ok: true };
    },
  );

  // DELETE /api/books/watchlist?id=…
  server.route("DELETE", "/api/books/watchlist", ({ query }) => {
    const id = query.get("id") ?? "";
    if (!id) throw new HttpError(400, "id is required");
    service.removeFromWatchlist(id);
    return { ok: true };
  });

  // POST /api/books/progress  body: { identifier, progress: 0..1 }
  server.route<{ identifier: string; progress: number }>("POST", "/api/books/progress", ({ body }) => {
    if (!body?.identifier || typeof body.progress !== "number") {
      throw new HttpError(400, "identifier and progress required");
    }
    service.setReadProgress(body.identifier, body.progress);
    return { ok: true };
  });
}

/** archive.org calls: a failure there is the upstream's, so it answers 502. */
async function upstream<T>(what: string, fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    log.error(`books: ${what} failed`, err);
    throw new HttpError(502, extractMessage(err));
  }
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
