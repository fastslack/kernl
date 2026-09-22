import { HttpError, type KernelHttpServer, log } from "@kernl/extension-sdk";
import type { MusicService } from "./service.js";
import type { MusicFormatKind, MusicListFilter } from "./types.js";

export function registerMusicRoutes(server: KernelHttpServer, service: MusicService): void {
  // GET /api/music/search?q=...&kind=vinyl_78&tags=jazz,blues&tags_match=any&yearMin=1950&yearMax=1970
  server.route("GET", "/api/music/search", ({ query }) => upstream("search", () => {
    const tagsRaw = query.get("tags");
    const tags = tagsRaw
      ? tagsRaw.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;
    const tagsMatchRaw = query.get("tags_match") ?? "all";
    const filter: MusicListFilter = {
      query: query.get("q") ?? "",
      kind: (query.get("kind") as MusicFormatKind | "any" | null) ?? "any",
      collection: query.get("collection") ?? undefined,
      creator: query.get("creator") ?? undefined,
      language: query.get("language") ?? undefined,
      yearMin: numParam(query.get("yearMin")),
      yearMax: numParam(query.get("yearMax")),
      tags,
      tagsMatch: tagsMatchRaw === "any" ? "any" : "all",
      sort: (query.get("sort") as MusicListFilter["sort"]) ?? "downloads",
      page: numParam(query.get("page")) ?? 1,
      limit: numParam(query.get("limit")) ?? 24,
    };
    return service.search(filter);
  }));

  // GET /api/music/tags?kind=vinyl_78&limit=60&q=jazz
  // Hits archive.org's `user_aggs=subject` aggregation across the whole
  // audio corpus (~13.5M items), narrowed to the requested kind. Cached
  // 24h server-side. The `q` is a client-side substring filter for the
  // autocomplete dropdown.
  server.route("GET", "/api/music/tags", async ({ query }) => {
    const limit = numParam(query.get("limit")) ?? 60;
    const q = query.get("q") ?? undefined;
    const kind = (query.get("kind") as MusicFormatKind | "any" | null) ?? "any";
    const tags = await service.topTagsLive({ kind, q, limit });
    return { tags, total: tags.length };
  });

  // GET /api/music/details?id=...
  server.route("GET", "/api/music/details", ({ query }) => {
    const id = query.get("id") ?? "";
    if (!id) throw new HttpError(400, "id is required");
    return upstream("details", () => service.details(id));
  });

  // GET /api/music/library?kind=vinyl_78
  server.route("GET", "/api/music/library", ({ query }) => {
    const kind = query.get("kind") as MusicFormatKind | "any" | null;
    return { items: service.listLibrary({ kind: kind ?? "any" }) };
  });

  // POST /api/music/library
  // body: { identifier, title?, creator?, year?, cover_url?, format_kind?, collection? }
  server.route<{
    identifier: string;
    title?: string;
    creator?: string;
    year?: number;
    cover_url?: string;
    format_kind?: MusicFormatKind;
    collection?: string;
  }>("POST", "/api/music/library", ({ body }) => {
    if (!body?.identifier) throw new HttpError(400, "identifier is required");
    service.addToLibrary(body);
    return { ok: true };
  });

  // DELETE /api/music/library?id=...
  server.route("DELETE", "/api/music/library", ({ query }) => {
    const id = query.get("id") ?? "";
    if (!id) throw new HttpError(400, "id is required");
    service.removeFromLibrary(id);
    return { ok: true };
  });

  // POST /api/music/play  body: { identifier, track_name?, seconds?, position? }
  // Logged from the player when a track ends OR the user pauses for 5+s.
  server.route<{
    identifier: string;
    track_name?: string;
    seconds?: number;
    position?: number;
  }>("POST", "/api/music/play", ({ body }) => {
    if (!body?.identifier) throw new HttpError(400, "identifier is required");
    service.recordPlay(body);
    return { ok: true };
  });

  // GET /api/music/recent?limit=24
  server.route("GET", "/api/music/recent", ({ query }) => {
    const limit = numParam(query.get("limit")) ?? 24;
    return { items: service.recentPlays(limit) };
  });

  // GET /api/music/catalog/status
  // Surface ingester progress so the UI can show "X titles indexed,
  // Y tags discovered, ingester at collection Z page N".
  server.route("GET", "/api/music/catalog/status", () => {
    const cat = service.catalog;
    const totalTitles = cat.countAll();
    const totalTags = cat.topTags(1).length > 0 ? "computed" : "0";
    const recentRuns = cat.recentRuns(10);
    return {
      total_titles: totalTitles,
      tags_state: totalTags,
      recent_runs: recentRuns,
    };
  });

  // POST /api/music/catalog/rebuild-tags
  // Manual rebuild after a big ingest, for users who don't want to wait
  // for the next automatic rebuild (every 5 ingest passes).
  server.route("POST", "/api/music/catalog/rebuild-tags", () => service.catalog.rebuildTags());
}

/** archive.org calls: a failure there is the upstream's, so it answers 502. */
async function upstream<T>(what: string, fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    log.error(`music: ${what} failed`, err);
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
