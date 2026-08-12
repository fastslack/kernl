/**
 * HTTP API for the cinema module.
 *
 *   GET  /api/cinema/titles               list local catalog with filters
 *   GET  /api/cinema/title/:identifier    one title (full row)
 *   GET  /api/cinema/search?q=…           local catalogue (fts | semantic | hybrid)
 *   GET  /api/cinema/search?q=…&scope=remote   archive.org itself, no index needed
 *   POST /api/cinema/watchlist            { identifier, watchlist:bool }
 *   POST /api/cinema/watched              { identifier, watched:bool }
 *   GET  /api/cinema/ingest/status        recent ingest runs + counts
 *   POST /api/cinema/ingest/run           trigger one ingest pass now
 *
 * The two `getter` callbacks (neo4j, embeddings) let us register the
 * routes BEFORE the embeddings client is instantiated — same pattern
 * the torrents module uses for the rust backend.
 */

import type { KernelHttpServer } from "../../../../../src/core/http-server.js";
import { log } from "../../../../../src/core/logger.js";
import { guardOutboundUrl } from "../../../../../src/core/url-guard.js";
import type { GraphDriver } from "../../../../../src/core/db-drivers/graph-driver.js";
import type { EmbeddingsClient } from "../../../../../src/core/embeddings/index.js";
import type { CinemaService } from "./service.js";
import type { CinemaSubsService, PublisherTrust } from "./subs-service.js";
import type { DiscoveryRegistry } from "./discovery/registry.js";
import type { EmbedRunner } from "./embed-runner.js";
import type { GraphProjectionRunner } from "./graph-projection-runner.js";
import type { TranslateRunner } from "./translate-runner.js";
import type { CanonicalService } from "./canonical/service.js";
import type { CanonicalRunner, CanonicalPhase } from "./canonical/runner.js";
import type { MediaProbeRunner } from "./media-runner.js";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { probeItem, recordFacts } from "./archive-files.js";
import { canonRails, syncCanonLists, canonListByKey } from "./canonical/canon.js";
import { similarTo, forYou } from "./recommend.js";
import type {
  CinemaDirectoriesService,
  CreateDirectoryInput,
  DirectoryVisibility,
  UpdateDirectoryInput,
} from "./directories-service.js";
import type { NostrDirectoriesProvider } from "./discovery/nostr-directories-provider.js";
import type { NostrIdentity } from "../../../../../src/core/nostr/nostr-identity.js";
import { searchSimilar, hybridSearch } from "./embeddings.js";
import { ingestNextChunk, CINEMA_COLLECTIONS } from "./ingester.js";
import { parseSubs, encodeVtt } from "./subtitles.js";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(n, max));
}

function asBool(raw: unknown): boolean {
  if (typeof raw === "boolean") return raw;
  if (raw === 1 || raw === "1" || raw === "true") return true;
  return false;
}

function extractMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerCinemaRoutes(
  server: KernelHttpServer,
  service: CinemaService,
  subs: CinemaSubsService,
  graphRef: () => GraphDriver | null,
  embedderRef: () => EmbeddingsClient | null,
  registryRef: () => DiscoveryRegistry | null,
  embedRunnerRef: () => EmbedRunner | null = () => null,
  dirsRef: () => CinemaDirectoriesService | null = () => null,
  dirsProviderRef: () => NostrDirectoriesProvider | null = () => null,
  localIdentityRef: () => NostrIdentity | null = () => null,
  translateRunnerRef: () => TranslateRunner | null = () => null,
  canonicalRef: () => CanonicalService | null = () => null,
  canonicalRunnerRef: () => CanonicalRunner | null = () => null,
  mediaRunnerRef: () => MediaProbeRunner | null = () => null,
  sqliteRef: () => SqliteDb | null = () => null,
  graphProjectionRunnerRef: () => GraphProjectionRunner | null = () => null,
): void {
  // ── GET /api/cinema/titles ──────────────────────────────────────
  server.get("/api/cinema/titles", async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const params = url.searchParams;
      const limit = clampInt(params.get("limit"), 60, 1, 500);
      const offset = clampInt(params.get("offset"), 0, 0, 1_000_000);
      const collection = params.get("collection") || undefined;
      const query = params.get("q") || undefined;
      const yearMin = parseInt(params.get("year_min") ?? "", 10) || undefined;
      const yearMax = parseInt(params.get("year_max") ?? "", 10) || undefined;
      const watchlist = params.get("watchlist") === "1";
      const tag = params.get("tag") || undefined;
      const tagsRaw = params.get("tags") || undefined;
      const tags = tagsRaw ? tagsRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
      const tagsMatchRaw = params.get("tags_match") || "all";
      const tagsMatch: "all" | "any" = tagsMatchRaw === "any" ? "any" : "all";
      const language = params.get("language") || undefined;
      const sortRaw = params.get("sort") ?? "downloads";
      const sort = (["downloads", "year_desc", "year_asc", "added_desc", "rating", "best"] as const)
        .find((s) => s === sortRaw) ?? "downloads";
      const kindRaw = params.get("kind");
      const kind = kindRaw === "film" || kindRaw === "series" ? kindRaw : undefined;
      // Opt-in, never a default: the unidentified tail holds the industrial
      // and educational cinema the archive is uniquely good at.
      const identifiedOnly = params.get("identified_only") === "1";
      // Collapse the many uploads of one film into one row. Also changes what
      // the row's downloads and votes MEAN — they become the work's totals.
      const collapse = params.get("collapse") === "1";
      // File-level filters. `min_minutes` rather than seconds because that is
      // the unit anyone thinks in when they say "at least a feature".
      const minMinutes = parseInt(params.get("min_minutes") ?? "", 10);
      const minDurationSec = Number.isFinite(minMinutes) && minMinutes > 0
        ? minMinutes * 60
        : undefined;
      const minHeight = parseInt(params.get("min_height") ?? "", 10) || undefined;
      const hasSubtitles = params.get("has_subtitles") === "1";
      const playableOnly = params.get("playable_only") === "1";
      // Only a rail that exists; an unknown key would otherwise silently
      // return an empty grid with no hint as to why.
      const canonList = canonListByKey(params.get("canon_list") ?? "")?.key;
      const canonOnly = params.get("canon_only") === "1";

      const filter = {
        query,
        collection,
        tag,
        tags,
        tagsMatch,
        language,
        yearMin,
        yearMax,
        watchlist: watchlist || undefined,
        kind,
        identifiedOnly: identifiedOnly || undefined,
        collapse: collapse || undefined,
        minDurationSec,
        minHeight,
        hasSubtitles: hasSubtitles || undefined,
        playableOnly: playableOnly || undefined,
        canonList,
        canonOnly: canonOnly || undefined,
        sort,
      } as const;

      // ── Hybrid path ────────────────────────────────────────
      // When the user typed a query AND we have both an embedder and
      // a graph driver, run hybrid (FTS5 + semantic, RRF-fused) and then
      // apply the rest of the filters (tags, year, language, etc.) on
      // top of the candidate set. This unifies "keyword search" and
      // "semantic search" into a single input — the user no longer has
      // to choose a mode. The classic listing path runs only when there
      // is no query at all.
      if (filter.query && filter.query.trim()) {
        const embedder = embedderRef();
        const graph = graphRef();
        // Cap the candidate set generously so the post-filter survives
        // even if most candidates fail the year/lang/tag check.
        const candidates = (embedder)
          ? await hybridSearch(embedder, graph, service, filter.query, 500)
          : service.fullTextSearch(filter.query, 500).map((id) => ({ identifier: id }));
        const ids = candidates.map((c) => c.identifier);
        const filtered = service.filterByIds(ids, filter);
        // Manual paging on the in-memory ranked list — small N, fine.
        const items = filtered.slice(offset, offset + limit);
        server.json(res, 200, { items, total: filtered.length, limit, offset });
        return;
      }

      const items = service.list({ ...filter, limit, offset });
      const total = service.countAll(filter);
      server.json(res, 200, { items, total, limit, offset });
    } catch (err) {
      log.error("cinema: list failed", err);
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // ── GET /api/cinema/title/:identifier ───────────────────────────
  server.get("/api/cinema/title/:identifier", (req, res) => {
    try {
      const id = (req as unknown as { params: { identifier: string } }).params.identifier;
      const t = service.getByIdentifier(id);
      if (!t) return server.json(res, 404, { error: "not found" });
      server.json(res, 200, { title: t });
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // ── GET /api/cinema/search?q=&limit=&mode= ──────────────────────
  // Hybrid search by default: FTS5 + semantic vectors fused via RRF.
  // Modes:
  //   hybrid   — FTS5 + semantic, RRF-fused (default; best for any query)
  //   semantic — pure embedding cosine over Neo4j (good for concept queries)
  //   fts      — pure FTS5 + bm25 (good when you know the exact name)
  //
  // Hybrid degrades gracefully: if Neo4j is down, only FTS5 contributes;
  // if FTS hits zero, semantic still runs.
  server.get("/api/cinema/search", async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const q = (url.searchParams.get("q") ?? "").trim();
      if (!q) return server.json(res, 400, { error: "query string `q` required" });
      const limit = clampInt(url.searchParams.get("limit"), 24, 1, 100);

      // ── scope=remote — search archive.org instead of the local catalogue.
      //
      // The local table is only what the ingester has walked so far, and the
      // semantic mode over it wants an embedding per row before the first
      // query. archive.org runs a Solr index over everything it holds and
      // answers for free, so finding a film needs neither.
      if ((url.searchParams.get("scope") ?? "local").toLowerCase() === "remote") {
        const { searchArchive } = await import("./archive-search.js");
        const page = clampInt(url.searchParams.get("page"), 1, 1, 500);
        const yearFrom = clampInt(url.searchParams.get("year_from"), 0, 0, 2999);
        const yearTo = clampInt(url.searchParams.get("year_to"), 0, 0, 2999);
        const remote = await searchArchive({
          q, rows: limit, page,
          yearFrom: yearFrom || undefined,
          yearTo: yearTo || undefined,
          language: url.searchParams.get("language") ?? undefined,
          sort: (url.searchParams.get("sort") as "downloads" | "newest" | null) ?? undefined,
          everywhere: url.searchParams.get("everywhere") === "1",
        });
        // Rows already in the catalogue are marked, so the UI can show what is
        // downloadable versus what would have to be added first.
        const items = remote.items.map((t) => ({
          ...t,
          _local: !!service.getByIdentifier(t.identifier),
        }));
        return server.json(res, 200, {
          items, query: q, mode: "archive", scope: "remote",
          total: items.length, totalRemote: remote.total, page,
        });
      }

      const modeRaw = (url.searchParams.get("mode") ?? "hybrid").toLowerCase();
      const mode: "hybrid" | "semantic" | "fts" =
        modeRaw === "semantic" ? "semantic" :
        modeRaw === "fts" ? "fts" : "hybrid";

      const graph = graphRef();
      const embedder = embedderRef();

      let hits: Array<{ identifier: string; score: number; source?: string }> = [];

      if (mode === "fts") {
        const ids = service.fullTextSearch(q, limit);
        hits = ids.map((id, i) => ({ identifier: id, score: 1 / (i + 1), source: "fts" }));
      } else if (mode === "semantic") {
        if (!graph?.capabilities.cypher || !embedder) {
          return server.json(res, 503, { error: "semantic search unavailable — graph driver or embedder not ready" });
        }
        const sem = await searchSimilar(embedder, graph, q, limit);
        hits = sem.map((h) => ({ identifier: h.identifier, score: h.score, source: h.source }));
      } else {
        // hybrid — embedder may be null (semantic leg falls through)
        if (!embedder) {
          // No embedder → degrade silently to FTS-only.
          const ids = service.fullTextSearch(q, limit);
          hits = ids.map((id, i) => ({ identifier: id, score: 1 / (i + 1), source: "fts" }));
        } else {
          const fused = await hybridSearch(embedder, graph, service, q, limit);
          hits = fused.map((h) => ({ identifier: h.identifier, score: h.score, source: h.source }));
        }
      }

      // Hydrate from SQLite so the UI has poster/description/year/etc.
      const items = hits
        .map((h) => {
          const row = service.getByIdentifier(h.identifier);
          return row ? { ...row, _score: h.score, _source: h.source } : null;
        })
        .filter((x) => x !== null);

      server.json(res, 200, { items, query: q, mode, total: items.length });
    } catch (err) {
      log.error("cinema: search failed", err);
      server.json(res, 502, { error: extractMessage(err) });
    }
  });

  // ── POST /api/cinema/watchlist ──────────────────────────────────
  server.post("/api/cinema/watchlist", async (req, res) => {
    try {
      const body = await server.parseBody<{ identifier: string; watchlist: boolean | number | string }>(req);
      const id = (body?.identifier ?? "").trim();
      if (!id) return server.json(res, 400, { error: "identifier required" });
      service.setWatchlist(id, asBool(body?.watchlist));
      const t = service.getByIdentifier(id);
      if (!t) return server.json(res, 404, { error: "not found" });
      server.json(res, 200, { title: t });
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // ── POST /api/cinema/watched ────────────────────────────────────
  server.post("/api/cinema/watched", async (req, res) => {
    try {
      const body = await server.parseBody<{ identifier: string; watched: boolean | number | string }>(req);
      const id = (body?.identifier ?? "").trim();
      if (!id) return server.json(res, 400, { error: "identifier required" });
      service.setWatched(id, asBool(body?.watched));
      const t = service.getByIdentifier(id);
      if (!t) return server.json(res, 404, { error: "not found" });
      server.json(res, 200, { title: t });
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // ── GET /api/cinema/ingest/status ───────────────────────────────
  server.get("/api/cinema/ingest/status", (req, res) => {
    try {
      const runs = service.recentRuns(20);
      const total = service.countAll();
      const embedder = embedderRef();
      const pendingEmbeddings = embedder
        ? service.pendingEmbeddingIds(embedder.model, embedder.dim, 99999).length
        : null;
      server.json(res, 200, {
        total,
        pending_embeddings: pendingEmbeddings,
        embedder: embedder ? {
          provider: embedder.provider,
          model: embedder.model,
          dim: embedder.dim,
        } : null,
        collections: CINEMA_COLLECTIONS,
        recent_runs: runs,
      });
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // ── POST /api/cinema/ingest/run ─────────────────────────────────
  // Manually trigger one ingest chunk (same code path as the cron handler)
  // — useful when the catalog is empty on first install and the user
  // doesn't want to wait for the 15-minute cron. Optional body:
  //   { collection?: string, pageSize?: number, maxPages?: number }
  server.post("/api/cinema/ingest/run", async (req, res) => {
    try {
      const body = await server.parseBody<{
        collection?: string;
        pageSize?: number;
        maxPages?: number;
      }>(req);
      const collections = body?.collection ? [body.collection] : CINEMA_COLLECTIONS;
      const result = await ingestNextChunk(service, collections, {
        pageSize: body?.pageSize,
        maxPages: body?.maxPages,
      });
      server.json(res, 200, { result });
    } catch (err) {
      log.error("cinema: manual ingest failed", err);
      server.json(res, 502, { error: extractMessage(err) });
    }
  });

  // POST /api/cinema/embed/run — trigger one embedding batch now
  // Same code path the cinema:embed-pending agent uses, but exposed
  // over HTTP so an external script can drive a tight loop and fill
  // the catalog much faster than the cron's 5-minute tick. Body:
  //   { batch_size?: number }   default 96, max 256
  server.post("/api/cinema/embed/run", async (req, res) => {
    try {
      const body = await server.parseBody<{ batch_size?: number }>(req);
      const graph = graphRef();
      const embedder = embedderRef();
      if (!graph?.capabilities.cypher) {
        return server.json(res, 503, { error: "graph driver unavailable — neo4j down" });
      }
      if (!embedder) {
        return server.json(res, 503, { error: "embeddings client not initialised" });
      }
      const batchSize = Math.max(1, Math.min(body?.batch_size ?? 96, 256));
      const { embedPending } = await import("./embeddings.js");
      const result = await embedPending(service, embedder, graph, batchSize);
      const pending = service.pendingEmbeddingIds(embedder.model, embedder.dim, 99999).length;
      server.json(res, 200, {
        embedded: result.embedded,
        graph_writes: result.graphWrites,
        duration_ms: result.durationMs,
        pending,
        model: embedder.model,
        dim: embedder.dim,
      });
    } catch (err) {
      log.error("cinema: embed/run failed", err);
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // ── Tag catalog ────────────────────────────────────────────────
  // GET /api/cinema/tags?limit=&q=
  //   limit  default 50, max 500
  //   q      optional prefix filter for autocomplete
  // The tags table is populated by POST /api/cinema/tags/rebuild (or the
  // cinema:rebuild-tags handler on cron). UI uses this for the chip row
  // and inline tag-search input.
  server.get("/api/cinema/tags", (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const limit = clampInt(url.searchParams.get("limit"), 50, 1, 500);
      const q = url.searchParams.get("q") ?? undefined;
      const tags = service.topTags(limit, q);
      server.json(res, 200, { tags, total: tags.length });
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // ── Embedding runner (drives the bge-m3 → Neo4j vector indexer) ─
  // GET  /api/cinema/embed/status — full snapshot for the UI progress bar
  // POST /api/cinema/embed/start  { batch_size? }
  // POST /api/cinema/embed/stop   (graceful, finishes current batch)
  server.get("/api/cinema/embed/status", (_req, res) => {
    try {
      const runner = embedRunnerRef();
      if (!runner) return server.json(res, 503, { error: "embed runner not wired" });
      server.json(res, 200, runner.snapshot());
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  server.post("/api/cinema/embed/start", async (req, res) => {
    try {
      const runner = embedRunnerRef();
      if (!runner) return server.json(res, 503, { error: "embed runner not wired" });
      const body = await server.parseBody<{ batch_size?: number }>(req);
      const snap = runner.start({ batchSize: body?.batch_size });
      server.json(res, 200, snap);
    } catch (err) {
      log.error("cinema: embed start failed", err);
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  server.post("/api/cinema/embed/stop", async (_req, res) => {
    try {
      const runner = embedRunnerRef();
      if (!runner) return server.json(res, 503, { error: "embed runner not wired" });
      const snap = await runner.stop();
      server.json(res, 200, snap);
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // ── Catalogue → graph projection ─────────────────────────────────
  // GET  /api/cinema/graph/status — per-entity cursors + rate
  // POST /api/cinema/graph/start  { batch_size?, reset? }
  // POST /api/cinema/graph/stop   (graceful, finishes current batch)
  server.get("/api/cinema/graph/status", (_req, res) => {
    try {
      const runner = graphProjectionRunnerRef();
      if (!runner) return server.json(res, 503, { error: "graph projection runner not wired" });
      server.json(res, 200, runner.snapshot());
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  server.post("/api/cinema/graph/start", async (req, res) => {
    try {
      const runner = graphProjectionRunnerRef();
      if (!runner) return server.json(res, 503, { error: "graph projection runner not wired" });
      const body = await server.parseBody<{ batch_size?: number; reset?: boolean }>(req);
      const snap = runner.start({ batchSize: body?.batch_size, reset: body?.reset === true });
      server.json(res, 200, snap);
    } catch (err) {
      log.error("cinema: graph projection start failed", err);
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  server.post("/api/cinema/graph/stop", async (_req, res) => {
    try {
      const runner = graphProjectionRunnerRef();
      if (!runner) return server.json(res, 503, { error: "graph projection runner not wired" });
      const snap = await runner.stop();
      server.json(res, 200, snap);
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // ── Translation runner ───────────────────────────────────────────
  // GET  /api/cinema/translate/status — snapshot for the UI progress bar
  // POST /api/cinema/translate/start  { concurrency? }
  // POST /api/cinema/translate/stop   (graceful, finishes in-flight calls)
  server.get("/api/cinema/translate/status", (_req, res) => {
    try {
      const runner = translateRunnerRef();
      if (!runner) return server.json(res, 503, { error: "translate runner not wired" });
      server.json(res, 200, runner.snapshot());
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  server.post("/api/cinema/translate/start", async (req, res) => {
    try {
      const runner = translateRunnerRef();
      if (!runner) return server.json(res, 503, { error: "translate runner not wired" });
      const body = await server.parseBody<{ concurrency?: number }>(req);
      const snap = runner.start({ concurrency: body?.concurrency });
      server.json(res, 200, snap);
    } catch (err) {
      log.error("cinema: translate start failed", err);
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  server.post("/api/cinema/translate/stop", async (_req, res) => {
    try {
      const runner = translateRunnerRef();
      if (!runner) return server.json(res, 503, { error: "translate runner not wired" });
      const snap = await runner.stop();
      server.json(res, 200, snap);
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // ── Discovery from the vectors ───────────────────────────────────
  // GET /api/cinema/similar/:identifier  the route from one film to the next
  // GET /api/cinema/for-you              the catalogue against your taste
  //
  // Both hydrate to full rows via filterByIds, so the grid renders them with
  // exactly the same card as everything else — badges, canon rails and all.
  server.get("/api/cinema/similar/:identifier", async (req, res) => {
    try {
      const embedder = embedderRef();
      if (!embedder) return server.json(res, 503, { error: "embeddings client not wired" });
      const identifier =
        ((req as unknown as { params: { identifier: string } }).params.identifier ?? "").trim();
      if (!identifier) return server.json(res, 400, { error: "identifier required" });

      const url = new URL(req.url ?? "/", "http://localhost");
      const limit = clampInt(url.searchParams.get("limit"), 12, 1, 60);
      const hits = await similarTo(embedder, graphRef(), identifier, limit);
      // filterByIds preserves the caller's order, so cosine ranking survives.
      const items = service.filterByIds(hits.map((h) => h.identifier), {});
      server.json(res, 200, { items, total: items.length });
    } catch (err) {
      log.error("cinema: similar failed", err);
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  server.get("/api/cinema/for-you", async (req, res) => {
    try {
      const db = sqliteRef();
      const embedder = embedderRef();
      if (!db) return server.json(res, 503, { error: "database not wired" });
      if (!embedder) return server.json(res, 503, { error: "embeddings client not wired" });

      const url = new URL(req.url ?? "/", "http://localhost");
      const limit = clampInt(url.searchParams.get("limit"), 24, 1, 60);
      const result = await forYou(db, embedder, graphRef(), limit);
      const items = service.filterByIds(result.hits.map((h) => h.identifier), {});
      // `reason` is passed through rather than collapsed into an empty list:
      // "save a few films first" and "run the embed runner" are different
      // messages and the page needs to tell them apart.
      server.json(res, 200, {
        items,
        total: items.length,
        profile_size: result.profile_size,
        reason: result.reason,
      });
    } catch (err) {
      log.error("cinema: for-you failed", err);
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // ── Canon rails ──────────────────────────────────────────────────
  // GET  /api/cinema/canon/rails  the lists, and how much of each is held
  // POST /api/cinema/canon/sync   refresh membership from Wikidata
  server.get("/api/cinema/canon/rails", (_req, res) => {
    try {
      const db = sqliteRef();
      if (!db) return server.json(res, 503, { error: "database not wired" });
      // `held` lets the page hide a rail the catalogue has nothing from,
      // rather than offering an empty shelf.
      server.json(res, 200, { rails: canonRails(db) });
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  server.post("/api/cinema/canon/sync", async (_req, res) => {
    try {
      const db = sqliteRef();
      if (!db) return server.json(res, 503, { error: "database not wired" });
      const t0 = Date.now();
      const result = await syncCanonLists(db);
      server.json(res, 200, { ...result, duration_ms: Date.now() - t0 });
    } catch (err) {
      log.error("cinema: canon sync failed", err);
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // ── File-level probe ─────────────────────────────────────────────
  // GET  /api/cinema/media/status      how much of the catalogue is probed
  // POST /api/cinema/media/start       { concurrency? }
  // POST /api/cinema/media/stop
  // POST /api/cinema/media/probe       { identifier } — one item, now
  server.get("/api/cinema/media/status", (_req, res) => {
    try {
      const runner = mediaRunnerRef();
      if (!runner) return server.json(res, 503, { error: "media runner not wired" });
      server.json(res, 200, runner.snapshot());
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  server.post("/api/cinema/media/start", async (req, res) => {
    try {
      const runner = mediaRunnerRef();
      if (!runner) return server.json(res, 503, { error: "media runner not wired" });
      const body = await server.parseBody<{ concurrency?: number }>(req);
      server.json(res, 200, runner.start({ concurrency: body?.concurrency }));
    } catch (err) {
      log.error("cinema: media probe start failed", err);
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  server.post("/api/cinema/media/stop", async (_req, res) => {
    try {
      const runner = mediaRunnerRef();
      if (!runner) return server.json(res, 503, { error: "media runner not wired" });
      server.json(res, 200, await runner.stop());
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // On-demand probe, so opening a title's page fills in its facts without
  // waiting for the background walk to reach it.
  server.post("/api/cinema/media/probe", async (req, res) => {
    try {
      const db = sqliteRef();
      if (!db) return server.json(res, 503, { error: "database not wired" });
      const body = await server.parseBody<{ identifier?: string }>(req);
      const identifier = (body?.identifier ?? "").trim();
      if (!identifier) return server.json(res, 400, { error: "identifier required" });
      const facts = await probeItem(identifier);
      recordFacts(db, identifier, facts);
      server.json(res, 200, { identifier, ...facts });
    } catch (err) {
      log.error("cinema: media probe failed", err);
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // ── Work-level dedupe ────────────────────────────────────────────
  // POST /api/cinema/works/rebuild        regroup the whole catalogue
  // GET  /api/cinema/works/stats          how much duplication there is
  // GET  /api/cinema/works/copies/:id     the other uploads of this film
  server.post("/api/cinema/works/rebuild", async (_req, res) => {
    try {
      const t0 = Date.now();
      const result = service.rebuildWorks();
      server.json(res, 200, { ...result, duration_ms: Date.now() - t0 });
    } catch (err) {
      log.error("cinema: works rebuild failed", err);
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  server.get("/api/cinema/works/stats", (_req, res) => {
    try {
      server.json(res, 200, service.worksStats());
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  server.get("/api/cinema/works/copies/:identifier", (req, res) => {
    try {
      const identifier =
        ((req as unknown as { params: { identifier: string } }).params.identifier ?? "").trim();
      if (!identifier) return server.json(res, 400, { error: "identifier required" });
      const items = service.siblingCopies(identifier);
      server.json(res, 200, { items, total: items.length });
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // ── Canonical identification ─────────────────────────────────────
  // GET  /api/cinema/canonical/status  corpus + match + ratings progress
  // POST /api/cinema/canonical/start   { phase?, slices_per_pass?, batch_size? }
  // POST /api/cinema/canonical/stop    (graceful, finishes current batch)
  // GET  /api/cinema/canonical/review  the grey zone awaiting a human
  // POST /api/cinema/canonical/decide  { identifier, qid }  — "" qid = reject
  server.get("/api/cinema/canonical/status", (_req, res) => {
    try {
      const runner = canonicalRunnerRef();
      if (!runner) return server.json(res, 503, { error: "canonical runner not wired" });
      server.json(res, 200, runner.snapshot());
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  server.post("/api/cinema/canonical/start", async (req, res) => {
    try {
      const runner = canonicalRunnerRef();
      if (!runner) return server.json(res, 503, { error: "canonical runner not wired" });
      const body = await server.parseBody<{
        phase?: string; slices_per_pass?: number; batch_size?: number;
      }>(req);
      // Only a phase the runner actually has; anything else starts from the
      // beginning rather than throwing at the user.
      const phase = (["corpus", "match", "ratings"] as const)
        .find((p) => p === body?.phase) as CanonicalPhase | undefined;
      const snap = runner.start({
        phase,
        slicesPerPass: body?.slices_per_pass,
        batchSize: body?.batch_size,
      });
      server.json(res, 200, snap);
    } catch (err) {
      log.error("cinema: canonical start failed", err);
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  server.post("/api/cinema/canonical/stop", async (_req, res) => {
    try {
      const runner = canonicalRunnerRef();
      if (!runner) return server.json(res, 503, { error: "canonical runner not wired" });
      server.json(res, 200, await runner.stop());
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  server.get("/api/cinema/canonical/review", (req, res) => {
    try {
      const canonical = canonicalRef();
      if (!canonical) return server.json(res, 503, { error: "canonical service not wired" });
      const url = new URL(req.url ?? "/", "http://localhost");
      const limit = clampInt(url.searchParams.get("limit"), 50, 1, 200);
      const offset = clampInt(url.searchParams.get("offset"), 0, 0, 1_000_000);
      server.json(res, 200, {
        items: canonical.reviewQueue(limit, offset),
        total: canonical.countReview(),
        limit,
        offset,
      });
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  server.post("/api/cinema/canonical/decide", async (req, res) => {
    try {
      const canonical = canonicalRef();
      if (!canonical) return server.json(res, 503, { error: "canonical service not wired" });
      const body = await server.parseBody<{ identifier?: string; qid?: string }>(req);
      const identifier = (body?.identifier ?? "").trim();
      if (!identifier) return server.json(res, 400, { error: "identifier required" });
      // An empty qid is a deliberate "none of these", not a missing field —
      // it records a rejection so the matcher stops proposing the same
      // candidates on every re-run.
      const qid = (body?.qid ?? "").trim();
      const ok = canonical.decide(identifier, qid);
      if (!ok) return server.json(res, 404, { error: "no match row for that identifier" });
      server.json(res, 200, { identifier, qid, state: qid ? "confirmed" : "rejected" });
    } catch (err) {
      log.error("cinema: canonical decide failed", err);
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // POST /api/cinema/tags/rebuild — rebuild cinema_tags from subject_json.
  // Cheap (~1-2s on 150k rows). Idempotent: drops the table contents and
  // re-populates. Caller-driven so the UI can refresh after big ingests.
  server.post("/api/cinema/tags/rebuild", async (_req, res) => {
    try {
      const t0 = Date.now();
      const result = service.rebuildTags();
      const ms = Date.now() - t0;
      server.json(res, 200, { ...result, duration_ms: ms });
    } catch (err) {
      log.error("cinema: tags rebuild failed", err);
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // ── Subtitle marketplace ───────────────────────────────────────

  // GET /api/cinema/subs/by-video/:identifier
  // Returns local subs (we have the bytes), federated subs from our
  // discovery index, and optionally a fresh provider sweep when
  // ?refresh=1 is set. The frontend renders three sections: LOCAL,
  // FEDERADOS (with trust grouping), and grouped per provider.
  server.get("/api/cinema/subs/by-video/:identifier", async (req, res) => {
    try {
      const id = (req as unknown as { params: { identifier: string } }).params.identifier;
      const url = new URL(req.url ?? "/", "http://localhost");
      const refresh = url.searchParams.get("refresh") === "1";

      let providerErrors: Array<{ providerId: string; error: string }> = [];
      if (refresh) {
        const reg = registryRef();
        if (reg) {
          const result = await reg.queryAll({ identifier: id, limit: 100 });
          for (const ann of result.items) subs.upsertIndex(ann);
          providerErrors = result.errors;
        }
      }

      const local = subs.listLocalByVideo(id);
      const federated = subs.listIndexByVideo(id);

      // Hydrate trust info for each unique signer so the UI can colour
      // rows without making N+1 calls.
      const pubkeys = new Set<string>();
      for (const f of federated) if (f.signerPubkey) pubkeys.add(f.signerPubkey);
      const publishers: Record<string, { trust: PublisherTrust; alias: string }> = {};
      for (const pk of pubkeys) {
        const p = subs.getPublisher(pk);
        publishers[pk] = p ? { trust: p.trust, alias: p.alias } : { trust: "unknown", alias: "" };
      }

      server.json(res, 200, {
        identifier: id,
        local,
        federated,
        publishers,
        provider_errors: providerErrors,
        providers: registryRef()?.list().map((p) => ({
          id: p.id, label: p.label, canPublish: p.canPublish,
        })) ?? [],
      });
    } catch (err) {
      log.error("cinema: subs by-video failed", err);
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // POST /api/cinema/subs/publish
  //   { identifier, src_lang, tgt_lang, engine, engine_version,
  //     vtt_path?, srt_path?, sha256, size_bytes, magnet, webseed_url, content }
  //
  // Records the sub locally (cinema_subs) and broadcasts via every
  // publishable provider. Returns the new local row + per-provider
  // outcomes so the caller can show a "published to: nostr" toast.
  server.post("/api/cinema/subs/publish", async (req, res) => {
    try {
      const body = await server.parseBody<{
        identifier: string;
        src_lang?: string;
        tgt_lang: string;
        engine: string;
        engine_version?: string;
        vtt_path?: string;
        srt_path?: string;
        sha256?: string;
        size_bytes?: number;
        magnet?: string;
        webseed_url?: string;
        content?: string;
        signer_pubkey?: string;
        manifest?: Record<string, unknown>;
      }>(req);
      if (!body?.identifier || !body.tgt_lang || !body.engine) {
        return server.json(res, 400, { error: "identifier, tgt_lang and engine are required" });
      }

      const local = subs.insertLocal({
        identifier: body.identifier,
        src_lang: body.src_lang ?? "",
        tgt_lang: body.tgt_lang,
        engine: body.engine,
        engine_version: body.engine_version ?? "",
        origin: "local",
        signer_pubkey: body.signer_pubkey ?? "",
        manifest: body.manifest ?? {},
        vtt_path: body.vtt_path ?? "",
        srt_path: body.srt_path ?? "",
        sha256: body.sha256 ?? "",
        size_bytes: body.size_bytes ?? 0,
        magnet: body.magnet ?? "",
        webseed_url: body.webseed_url ?? "",
      });

      const reg = registryRef();
      if (!reg) {
        return server.json(res, 200, { local, publish: { successes: [], failures: [] } });
      }
      const publish = await reg.publishAll({
        identifier: body.identifier,
        srcLang: body.src_lang ?? "",
        tgtLang: body.tgt_lang,
        engine: body.engine,
        engineVersion: body.engine_version ?? "",
        magnet: body.magnet ?? "",
        webseedUrl: body.webseed_url ?? "",
        sha256: body.sha256 ?? "",
        sizeBytes: body.size_bytes ?? 0,
        content: body.content ?? "",
      });
      if (publish.successes.length > 0) subs.markPublished(local.id);

      server.json(res, 200, { local, publish });
    } catch (err) {
      log.error("cinema: sub publish failed", err);
      server.json(res, 502, { error: extractMessage(err) });
    }
  });

  // POST /api/cinema/subs/trust  { pubkey, trust, alias?, notes? }
  server.post("/api/cinema/subs/trust", async (req, res) => {
    try {
      const body = await server.parseBody<{
        pubkey: string;
        trust: PublisherTrust;
        alias?: string;
        notes?: string;
      }>(req);
      const pk = (body?.pubkey ?? "").trim();
      const trust = body?.trust;
      if (!pk) return server.json(res, 400, { error: "pubkey required" });
      if (!trust || !["mine", "trusted", "blocked", "unknown"].includes(trust)) {
        return server.json(res, 400, { error: "trust must be one of mine|trusted|blocked|unknown" });
      }
      const updated = subs.setTrust(pk, trust, body?.alias, body?.notes);
      server.json(res, 200, { publisher: updated });
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // GET /api/cinema/subs/publishers
  server.get("/api/cinema/subs/publishers", (req, res) => {
    try {
      server.json(res, 200, { publishers: subs.listPublishers() });
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // GET /api/cinema/subs/providers — registry status for the UI
  server.get("/api/cinema/subs/providers", (req, res) => {
    try {
      const reg = registryRef();
      const providers = reg?.list().map((p) => ({
        id: p.id, label: p.label, canPublish: p.canPublish,
      })) ?? [];
      server.json(res, 200, { providers });
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // POST /api/cinema/subs/download  { rowId }
  // Materialises a federated announcement: fetches the webseed bytes,
  // (optionally) checks sha256, converts SRT→VTT if needed, writes the
  // file to the SAME cache the legacy torrents/subs pipeline uses
  // (data/subtitles/<sha1>.vtt + sidecar), then inserts a cinema_subs
  // row marked origin=federated|archive_org so the player can serve it
  // back via /api/torrents/subs/file?key=<sha1> with no extra plumbing.
  server.post("/api/cinema/subs/download", async (req, res) => {
    try {
      const body = await server.parseBody<{ rowId: string }>(req);
      const rowId = (body?.rowId ?? "").trim();
      if (!rowId) return server.json(res, 400, { error: "rowId required" });

      const ann = subs.getIndex(rowId);
      if (!ann) return server.json(res, 404, { error: "row not found" });
      if (!ann.webseedUrl) {
        return server.json(res, 400, { error: "row has no webseed_url; magnet-only download not supported in stage 4b" });
      }
      if (ann.downloadedSubId) {
        const existing = subs.getLocal(ann.downloadedSubId);
        if (existing) return server.json(res, 200, { local: existing, cached: true });
      }

      // SSRF guard — federated rows can carry attacker-supplied URLs that
      // resolve to private/loopback addresses. Reject before any fetch().
      const guard = await guardOutboundUrl(ann.webseedUrl);
      if (!guard.ok) {
        return server.json(res, 400, { error: `webseed url rejected: ${guard.reason}` });
      }

      // Fetch — 15s timeout, follow redirects (archive.org loves them).
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      let raw: string;
      try {
        const r = await fetch(guard.parsed.toString(), {
          headers: { "user-agent": "Kernl/cinema-subs-download" },
          signal: controller.signal,
          redirect: "follow",
        });
        if (!r.ok) {
          return server.json(res, 502, { error: `webseed ${r.status} ${r.statusText}` });
        }
        // Most subtitle files fit in a single response; cap to 4 MiB to
        // avoid an attacker-controlled URL flooding the cache.
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 4_194_304) {
          return server.json(res, 413, { error: `subtitle too large (${buf.length} bytes)` });
        }
        raw = buf.toString("utf8");
      } finally {
        clearTimeout(timer);
      }

      // Optional integrity check. Archive.org doesn't ship sha256 so we
      // skip when missing; for Nostr-announced subs we ENFORCE.
      if (ann.sha256 && ann.providerId !== "archive_org") {
        const got = createHash("sha256").update(raw, "utf8").digest("hex");
        if (got.toLowerCase() !== ann.sha256.toLowerCase()) {
          return server.json(res, 409, {
            error: "sha256 mismatch",
            expected: ann.sha256,
            got,
          });
        }
      }

      // Parse + re-encode as VTT. parseSubs handles both SRT and VTT
      // input transparently — gives us a single output format the
      // browser <track> element accepts directly.
      const cues = parseSubs(raw);
      if (cues.length === 0) {
        return server.json(res, 422, { error: "could not parse any subtitle cues — bad SRT/VTT?" });
      }
      const vtt = encodeVtt(cues);

      // sha1 key matches the legacy cache convention so the existing
      // /api/torrents/subs/file?key=… serves these without changes.
      const cacheKey = createHash("sha1").update(vtt, "utf8").digest("hex");
      const cacheDir = path.join(process.cwd(), "data", "subtitles");
      await mkdir(cacheDir, { recursive: true });
      const vttPath = path.join(cacheDir, `${cacheKey}.vtt`);
      if (!existsSync(vttPath)) {
        await writeFile(vttPath, vtt, "utf8");
      }
      // Sidecar so the legacy /subs/list endpoint enumerates this file too.
      const sidecarPath = path.join(cacheDir, `${cacheKey}.json`);
      const sidecar = {
        key: cacheKey,
        kind: "translation" as const,
        url: ann.webseedUrl,
        src_lang: ann.srcLang,
        tgt_lang: ann.tgtLang,
        engine: ann.engine,
        model: ann.engine,
        cue_count: cues.length,
        created_at: Date.now(),
        federated: { provider: ann.providerId, signer: ann.signerPubkey },
      };
      await writeFile(sidecarPath, JSON.stringify(sidecar, null, 2), "utf8");

      const origin = ann.providerId === "archive_org" ? "archive_org" as const : "federated" as const;
      const local = subs.insertLocal({
        identifier: ann.identifier,
        src_lang: ann.srcLang,
        tgt_lang: ann.tgtLang,
        engine: ann.engine,
        engine_version: "",
        origin,
        signer_pubkey: ann.signerPubkey,
        manifest: { provider_event_id: ann.providerEventId, providerId: ann.providerId },
        vtt_path: vttPath,
        srt_path: "",
        sha256: ann.sha256,
        size_bytes: Buffer.byteLength(vtt, "utf8"),
        magnet: ann.magnet,
        webseed_url: ann.webseedUrl,
      });
      subs.markDownloaded(rowId, local.id);

      server.json(res, 200, {
        local,
        cache_key: cacheKey,
        play_url: `/api/torrents/subs/file?key=${cacheKey}`,
        cue_count: cues.length,
      });
    } catch (err) {
      log.error("cinema: sub download failed", err);
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // ── Community directories ──────────────────────────────────────
  // Local CRUD + Nostr-federated discover/follow/sync. Visible at
  // /cinema/directories in the dashboard.

  server.get("/api/cinema/directories", (req, res) => {
    try {
      const dirs = dirsRef();
      if (!dirs) return server.json(res, 503, { error: "directories service not wired" });
      const url = new URL(req.url ?? "/", "http://localhost");
      const origin = (url.searchParams.get("origin") || undefined) as "local" | "federated" | undefined;
      const subscribedOnly = url.searchParams.get("subscribed") === "1";
      const category = url.searchParams.get("category") || undefined;
      const ownerPubkey = url.searchParams.get("owner") || undefined;
      const limit = clampInt(url.searchParams.get("limit"), 50, 1, 500);
      const offset = clampInt(url.searchParams.get("offset"), 0, 0, 1_000_000);
      const list = dirs.list({ origin, category, ownerPubkey, subscribedOnly, limit, offset });
      // Hydrate cover_identifier into a small CinemaTitle preview when possible.
      const hydrated = list.map((d) => {
        const cover = d.cover_identifier ? service.getByIdentifier(d.cover_identifier) : null;
        return {
          ...d,
          item_count: d.items.length,
          cover: cover ? { identifier: cover.identifier, title: cover.title, year: cover.year } : null,
        };
      });
      server.json(res, 200, { directories: hydrated, total: hydrated.length });
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  server.get("/api/cinema/directories/discover", async (req, res) => {
    try {
      const provider = dirsProviderRef();
      if (!provider) return server.json(res, 503, { error: "directories nostr provider not wired" });
      const url = new URL(req.url ?? "/", "http://localhost");
      const category = url.searchParams.get("category") || undefined;
      const ownerPubkey = url.searchParams.get("owner") || undefined;
      const limit = clampInt(url.searchParams.get("limit"), 50, 1, 500);
      const events = await provider.discover({ category, ownerPubkey, limit });
      // Don't auto-write: the user must actively follow. Return previews.
      const previews = events.map((e) => ({
        id: e.directoryId,
        owner_pubkey: e.payload.owner_pubkey,
        title: e.payload.title,
        description: e.payload.description,
        category: e.payload.category,
        cover_identifier: e.payload.cover_identifier,
        item_count: e.payload.items.length,
        version: e.payload.version,
        updated_at: e.payload.updated_at,
        signer_pubkey: e.signerPubkey,
        event_id: e.eventId,
      }));
      server.json(res, 200, { directories: previews, total: previews.length });
    } catch (err) {
      log.error("cinema: directories discover failed", err);
      server.json(res, 502, { error: extractMessage(err) });
    }
  });

  server.get("/api/cinema/directories/:id", (req, res) => {
    try {
      const dirs = dirsRef();
      if (!dirs) return server.json(res, 503, { error: "directories service not wired" });
      const id = (req as unknown as { params: { id: string } }).params.id;
      const d = dirs.get(id);
      if (!d) return server.json(res, 404, { error: "not found" });
      // Hydrate items with full title rows so the UI doesn't need N+1 calls.
      const items = d.items.map((it) => {
        const t = service.getByIdentifier(it.identifier);
        return {
          identifier: it.identifier,
          note: it.note ?? null,
          added_at: it.added_at,
          title: t ?? null,    // null when our local catalog hasn't ingested this id yet
        };
      });
      server.json(res, 200, { directory: d, items });
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // Auto-publish helper: when a directory is public/unlisted and we own
  // a publishable Nostr identity, broadcast it after each mutation. No
  // separate "publish" button — the data is treated as live the moment
  // the user said "make it public". Failures here log + ignore (the row
  // is still saved locally; the cron sync re-tries later).
  async function autoPublishIfPublic(directoryId: string): Promise<void> {
    const dirs = dirsRef();
    const provider = dirsProviderRef();
    if (!dirs || !provider || !provider.canPublish) return;
    const d = dirs.get(directoryId);
    if (!d || d.origin !== "local") return;
    if (d.visibility === "private") return;
    try {
      const result = await provider.publish(d);
      dirs.markPublished(directoryId, result.eventId);
    } catch (err) {
      log.warn(`cinema: auto-publish ${directoryId} failed — ${err instanceof Error ? err.message : err}`);
    }
  }

  server.post("/api/cinema/directories", async (req, res) => {
    try {
      const dirs = dirsRef();
      const identity = localIdentityRef();
      if (!dirs) return server.json(res, 503, { error: "directories service not wired" });
      if (!identity) return server.json(res, 503, { error: "local nostr identity not initialised — cannot own a directory" });
      const body = await server.parseBody<CreateDirectoryInput & { owner_pubkey?: string }>(req);
      if (!body?.title) return server.json(res, 400, { error: "title required" });
      const created = dirs.create({
        ...body,
        owner_pubkey: identity.pubkeyHex,
      });
      // Don't await — let the user see the response immediately. Auto-
      // publish runs as a fire-and-forget side effect.
      autoPublishIfPublic(created.id);
      server.json(res, 200, { directory: created });
    } catch (err) {
      log.error("cinema: directory create failed", err);
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  server.post("/api/cinema/directories/:id/update", async (req, res) => {
    try {
      const dirs = dirsRef();
      if (!dirs) return server.json(res, 503, { error: "directories service not wired" });
      const id = (req as unknown as { params: { id: string } }).params.id;
      const body = await server.parseBody<UpdateDirectoryInput>(req);
      const updated = dirs.update(id, body ?? {});
      if (!updated) return server.json(res, 404, { error: "not found or not editable" });
      autoPublishIfPublic(id);
      server.json(res, 200, { directory: updated });
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  server.post("/api/cinema/directories/:id/delete", (req, res) => {
    try {
      const dirs = dirsRef();
      if (!dirs) return server.json(res, 503, { error: "directories service not wired" });
      const id = (req as unknown as { params: { id: string } }).params.id;
      const ok = dirs.delete(id);
      server.json(res, 200, { ok });
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  server.post("/api/cinema/directories/:id/items", async (req, res) => {
    try {
      const dirs = dirsRef();
      if (!dirs) return server.json(res, 503, { error: "directories service not wired" });
      const id = (req as unknown as { params: { id: string } }).params.id;
      const body = await server.parseBody<{ identifier: string; note?: string }>(req);
      if (!body?.identifier) return server.json(res, 400, { error: "identifier required" });
      const updated = dirs.addItem(id, body.identifier, body.note);
      if (!updated) return server.json(res, 404, { error: "not found" });
      autoPublishIfPublic(id);
      server.json(res, 200, { directory: updated });
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  server.post("/api/cinema/directories/:id/items/remove", async (req, res) => {
    try {
      const dirs = dirsRef();
      if (!dirs) return server.json(res, 503, { error: "directories service not wired" });
      const id = (req as unknown as { params: { id: string } }).params.id;
      const body = await server.parseBody<{ identifier: string }>(req);
      if (!body?.identifier) return server.json(res, 400, { error: "identifier required" });
      const updated = dirs.removeItem(id, body.identifier);
      if (!updated) return server.json(res, 404, { error: "not found" });
      autoPublishIfPublic(id);
      server.json(res, 200, { directory: updated });
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  server.post("/api/cinema/directories/:id/publish", async (req, res) => {
    try {
      const dirs = dirsRef();
      const provider = dirsProviderRef();
      if (!dirs) return server.json(res, 503, { error: "directories service not wired" });
      if (!provider || !provider.canPublish) {
        return server.json(res, 503, { error: "nostr identity not configured — cannot publish" });
      }
      const id = (req as unknown as { params: { id: string } }).params.id;
      const d = dirs.get(id);
      if (!d) return server.json(res, 404, { error: "not found" });
      if (d.origin !== "local") {
        return server.json(res, 400, { error: "only local-owned directories can be published" });
      }
      const result = await provider.publish(d);
      dirs.markPublished(id, result.eventId);
      server.json(res, 200, { event_id: result.eventId, relays: result.relays });
    } catch (err) {
      log.error("cinema: directory publish failed", err);
      server.json(res, 502, { error: extractMessage(err) });
    }
  });

  server.post("/api/cinema/directories/:id/follow", async (req, res) => {
    try {
      const dirs = dirsRef();
      const provider = dirsProviderRef();
      if (!dirs) return server.json(res, 503, { error: "directories service not wired" });
      const id = (req as unknown as { params: { id: string } }).params.id;
      const body = await server.parseBody<{ owner_pubkey: string }>(req);
      const owner = body?.owner_pubkey?.trim();
      if (!owner) return server.json(res, 400, { error: "owner_pubkey required" });
      // Try to fetch the latest event so the user can browse it immediately,
      // not after the next cron tick. If Nostr is offline we still record
      // the subscription — the cron will catch up when it's available.
      if (provider) {
        try {
          const events = await provider.discover({ ownerPubkey: owner, directoryId: id, limit: 1 });
          for (const ev of events) {
            dirs.applyFederated({
              directoryId: ev.directoryId,
              signerPubkey: ev.signerPubkey,
              eventId: ev.eventId,
              eventCreatedAtSec: ev.createdAtSec,
              payload: ev.payload,
            });
          }
        } catch (err) {
          log.warn(`cinema: follow: initial fetch failed — ${err instanceof Error ? err.message : err}`);
        }
      }
      const sub = dirs.follow(id, owner);
      server.json(res, 200, { subscription: sub, directory: dirs.get(id) });
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  server.post("/api/cinema/directories/:id/unfollow", async (req, res) => {
    try {
      const dirs = dirsRef();
      if (!dirs) return server.json(res, 503, { error: "directories service not wired" });
      const id = (req as unknown as { params: { id: string } }).params.id;
      const body = await server.parseBody<{ owner_pubkey: string }>(req);
      if (!body?.owner_pubkey) return server.json(res, 400, { error: "owner_pubkey required" });
      const ok = dirs.unfollow(id, body.owner_pubkey);
      server.json(res, 200, { ok });
    } catch (err) {
      server.json(res, 500, { error: extractMessage(err) });
    }
  });

  // POST /api/cinema/directories/sync — pull latest for every subscribed dir.
  // Bulk variant that the UI / agent calls; the singular-dir version is
  // implicit in /follow above.
  server.post("/api/cinema/directories/sync", async (_req, res) => {
    try {
      const dirs = dirsRef();
      const provider = dirsProviderRef();
      if (!dirs) return server.json(res, 503, { error: "directories service not wired" });
      if (!provider) return server.json(res, 503, { error: "directories provider not wired" });
      const subs = dirs.listSubscriptions();
      let pulled = 0;
      let updated = 0;
      let created = 0;
      let rejected = 0;
      for (const sub of subs) {
        try {
          const events = await provider.discover({
            ownerPubkey: sub.owner_pubkey,
            directoryId: sub.directory_id,
            limit: 1,
          });
          pulled += events.length;
          for (const ev of events) {
            const r = dirs.applyFederated({
              directoryId: ev.directoryId,
              signerPubkey: ev.signerPubkey,
              eventId: ev.eventId,
              eventCreatedAtSec: ev.createdAtSec,
              payload: ev.payload,
            });
            if (r === "created") created++;
            else if (r === "updated") updated++;
            else if (r.startsWith("rejected")) rejected++;
          }
          dirs.markSynced(sub.directory_id, sub.owner_pubkey);
        } catch (err) {
          log.warn(`cinema: directory sync ${sub.directory_id} failed — ${err instanceof Error ? err.message : err}`);
        }
      }
      server.json(res, 200, { subscriptions: subs.length, pulled, created, updated, rejected });
    } catch (err) {
      log.error("cinema: directories sync failed", err);
      server.json(res, 500, { error: extractMessage(err) });
    }
  });
}
