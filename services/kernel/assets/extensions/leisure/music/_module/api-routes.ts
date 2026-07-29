import type { KernelHttpServer } from "../../../../../src/core/http-server.js";
import { log } from "../../../../../src/core/logger.js";
import type { MusicService } from "./service.js";
import type { MusicFormatKind, MusicListFilter } from "./types.js";

export function registerMusicRoutes(server: KernelHttpServer, service: MusicService): void {
  // GET /api/music/search?q=...&kind=vinyl_78&tags=jazz,blues&tags_match=any&yearMin=1950&yearMax=1970
  server.get("/api/music/search", async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const tagsRaw = url.searchParams.get("tags");
      const tags = tagsRaw
        ? tagsRaw.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined;
      const tagsMatchRaw = url.searchParams.get("tags_match") ?? "all";
      const filter: MusicListFilter = {
        query: url.searchParams.get("q") ?? "",
        kind: (url.searchParams.get("kind") as MusicFormatKind | "any" | null) ?? "any",
        collection: url.searchParams.get("collection") ?? undefined,
        creator: url.searchParams.get("creator") ?? undefined,
        language: url.searchParams.get("language") ?? undefined,
        yearMin: numParam(url.searchParams.get("yearMin")),
        yearMax: numParam(url.searchParams.get("yearMax")),
        tags,
        tagsMatch: tagsMatchRaw === "any" ? "any" : "all",
        sort: (url.searchParams.get("sort") as MusicListFilter["sort"]) ?? "downloads",
        page: numParam(url.searchParams.get("page")) ?? 1,
        limit: numParam(url.searchParams.get("limit")) ?? 24,
      };
      const result = await service.search(filter);
      server.json(res, 200, result);
    } catch (err) {
      log.error("music: search failed", err);
      server.json(res, 502, { error: extractMessage(err) });
    }
  });

  // GET /api/music/tags?kind=vinyl_78&limit=60&q=jazz
  // Hits archive.org's `user_aggs=subject` aggregation across the whole
  // audio corpus (~13.5M items), narrowed to the requested kind. Cached
  // 24h server-side. The `q` is a client-side substring filter for the
  // autocomplete dropdown.
  server.get("/api/music/tags", async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const limit = numParam(url.searchParams.get("limit")) ?? 60;
      const q = url.searchParams.get("q") ?? undefined;
      const kind = (url.searchParams.get("kind") as MusicFormatKind | "any" | null) ?? "any";
      const tags = await service.topTagsLive({ kind, q, limit });
      server.json(res, 200, { tags, total: tags.length });
    } catch (err) {
      log.error("music: tags failed", err);
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // GET /api/music/details?id=...
  server.get("/api/music/details", async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const id = url.searchParams.get("id") ?? "";
      if (!id) return server.json(res, 400, { error: "id is required" });
      const details = await service.details(id);
      server.json(res, 200, details);
    } catch (err) {
      log.error("music: details failed", err);
      server.json(res, 502, { error: extractMessage(err) });
    }
  });

  // GET /api/music/library?kind=vinyl_78
  server.get("/api/music/library", (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const kind = url.searchParams.get("kind") as MusicFormatKind | "any" | null;
      const items = service.listLibrary({ kind: kind ?? "any" });
      server.json(res, 200, { items });
    } catch (err) {
      log.error("music: library failed", err);
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // POST /api/music/library
  // body: { identifier, title?, creator?, year?, cover_url?, format_kind?, collection? }
  server.post("/api/music/library", async (req, res) => {
    try {
      const body = await server.parseBody<{
        identifier: string;
        title?: string;
        creator?: string;
        year?: number;
        cover_url?: string;
        format_kind?: MusicFormatKind;
        collection?: string;
      }>(req);
      if (!body?.identifier) return server.json(res, 400, { error: "identifier is required" });
      service.addToLibrary(body);
      server.json(res, 200, { ok: true });
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // DELETE /api/music/library?id=...
  server.delete("/api/music/library", (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const id = url.searchParams.get("id") ?? "";
      if (!id) return server.json(res, 400, { error: "id is required" });
      service.removeFromLibrary(id);
      server.json(res, 200, { ok: true });
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // POST /api/music/play  body: { identifier, track_name?, seconds?, position? }
  // Logged from the player when a track ends OR the user pauses for 5+s.
  server.post("/api/music/play", async (req, res) => {
    try {
      const body = await server.parseBody<{
        identifier: string;
        track_name?: string;
        seconds?: number;
        position?: number;
      }>(req);
      if (!body?.identifier) return server.json(res, 400, { error: "identifier is required" });
      service.recordPlay(body);
      server.json(res, 200, { ok: true });
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // GET /api/music/recent?limit=24
  server.get("/api/music/recent", (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const limit = numParam(url.searchParams.get("limit")) ?? 24;
      const items = service.recentPlays(limit);
      server.json(res, 200, { items });
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // GET /api/music/catalog/status
  // Surface ingester progress so the UI can show "X titles indexed,
  // Y tags discovered, ingester at collection Z page N".
  server.get("/api/music/catalog/status", (_req, res) => {
    try {
      const cat = service.catalog;
      const totalTitles = cat.countAll();
      const totalTags = cat.topTags(1).length > 0 ? "computed" : "0";
      const recentRuns = cat.recentRuns(10);
      server.json(res, 200, {
        total_titles: totalTitles,
        tags_state: totalTags,
        recent_runs: recentRuns,
      });
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // POST /api/music/catalog/rebuild-tags
  // Manual rebuild after a big ingest, for users who don't want to wait
  // for the next automatic rebuild (every 5 ingest passes).
  server.post("/api/music/catalog/rebuild-tags", (_req, res) => {
    try {
      const r = service.catalog.rebuildTags();
      server.json(res, 200, r);
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
