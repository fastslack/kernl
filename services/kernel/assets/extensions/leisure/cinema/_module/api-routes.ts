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

import {
  HttpError,
  isHttpError,
  type KernelHttpServer,
  log,
  guardOutboundUrl,
  type GraphDriver,
  type EmbeddingsClient,
  type SqliteDb,
  clampInt,
  extractErrorMessage,
} from "@kernl/extension-sdk";
import type { NostrIdentity } from "@kernl/extension-sdk/nostr";
import type { CinemaService } from "./service.js";
import type { CinemaSubsService, PublisherTrust } from "./subs-service.js";
import type { DiscoveryRegistry } from "./discovery/registry.js";
import type { EmbedRunner } from "./embed-runner.js";
import type { GraphProjectionRunner } from "./graph-projection-runner.js";
import type { GraphResolveRunner } from "./graph-resolve-runner.js";
import { clearStaleProposalStamps, resolveComponents, revertGraphProposals } from "./graph-resolve.js";
import type { TranslateRunner } from "./translate-runner.js";
import type { CanonicalService } from "./canonical/service.js";
import type { CanonicalRunner, CanonicalPhase } from "./canonical/runner.js";
import type { MediaProbeRunner } from "./media-runner.js";
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
import { searchSimilar, hybridSearch } from "./embeddings.js";
import { ingestNextChunk, CINEMA_COLLECTIONS } from "./ingester.js";
import { parseSubs, encodeVtt } from "./subtitles.js";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function asBool(raw: unknown): boolean {
  if (typeof raw === "boolean") return raw;
  if (raw === 1 || raw === "1" || raw === "true") return true;
  return false;
}

/** A dependency wired in after route registration; 503 until it is. */
function wired<T>(value: T | null, what: string): T {
  if (!value) throw new HttpError(503, `${what} not wired`);
  return value;
}

/**
 * Routes whose failures come from upstream (archive.org, Nostr relays, the
 * embedder) answer 502 with the bare message rather than the default 500.
 * An HttpError the handler threw on purpose passes through untouched.
 */
async function or502<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isHttpError(err)) throw err;
    log.error(`cinema: ${what} failed`, err);
    throw new HttpError(502, extractErrorMessage(err));
  }
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
  graphResolveRunnerRef: () => GraphResolveRunner | null = () => null,
): void {
  // ── GET /api/cinema/titles ──────────────────────────────────────
  server.route("GET", "/api/cinema/titles", async ({ query: params }) => {
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
      return { items, total: filtered.length, limit, offset };
    }

    const items = service.list({ ...filter, limit, offset });
    const total = service.countAll(filter);
    return { items, total, limit, offset };
  });

  // ── GET /api/cinema/title/:identifier ───────────────────────────
  server.route("GET", "/api/cinema/title/:identifier", ({ params: { identifier } }) => {
    const t = service.getByIdentifier(identifier);
    if (!t) throw new HttpError(404, "not found");
    return { title: t };
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
  server.route("GET", "/api/cinema/search", ({ query }) => or502("search", async () => {
    const q = (query.get("q") ?? "").trim();
    if (!q) throw new HttpError(400, "query string `q` required");
    const limit = clampInt(query.get("limit"), 24, 1, 100);

    // ── scope=remote — search archive.org instead of the local catalogue.
    //
    // The local table is only what the ingester has walked so far, and the
    // semantic mode over it wants an embedding per row before the first
    // query. archive.org runs a Solr index over everything it holds and
    // answers for free, so finding a film needs neither.
    if ((query.get("scope") ?? "local").toLowerCase() === "remote") {
      const { searchArchive } = await import("./archive-search.js");
      const page = clampInt(query.get("page"), 1, 1, 500);
      const yearFrom = clampInt(query.get("year_from"), 0, 0, 2999);
      const yearTo = clampInt(query.get("year_to"), 0, 0, 2999);
      const remote = await searchArchive({
        q, rows: limit, page,
        yearFrom: yearFrom || undefined,
        yearTo: yearTo || undefined,
        language: query.get("language") ?? undefined,
        sort: (query.get("sort") as "downloads" | "newest" | null) ?? undefined,
        everywhere: query.get("everywhere") === "1",
      });
      // Rows already in the catalogue are marked, so the UI can show what is
      // downloadable versus what would have to be added first.
      const items = remote.items.map((t) => ({
        ...t,
        _local: !!service.getByIdentifier(t.identifier),
      }));
      return {
        items, query: q, mode: "archive", scope: "remote",
        total: items.length, totalRemote: remote.total, page,
      };
    }

    const modeRaw = (query.get("mode") ?? "hybrid").toLowerCase();
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
        throw new HttpError(503, "semantic search unavailable — graph driver or embedder not ready");
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

    return { items, query: q, mode, total: items.length };
  }));

  // ── POST /api/cinema/watchlist ──────────────────────────────────
  server.route<{ identifier: string; watchlist: boolean | number | string }>(
    "POST", "/api/cinema/watchlist", ({ body }) => {
      const id = (body?.identifier ?? "").trim();
      if (!id) throw new HttpError(400, "identifier required");
      service.setWatchlist(id, asBool(body?.watchlist));
      const t = service.getByIdentifier(id);
      if (!t) throw new HttpError(404, "not found");
      return { title: t };
    },
  );

  // ── POST /api/cinema/watched ────────────────────────────────────
  server.route<{ identifier: string; watched: boolean | number | string }>(
    "POST", "/api/cinema/watched", ({ body }) => {
      const id = (body?.identifier ?? "").trim();
      if (!id) throw new HttpError(400, "identifier required");
      service.setWatched(id, asBool(body?.watched));
      const t = service.getByIdentifier(id);
      if (!t) throw new HttpError(404, "not found");
      return { title: t };
    },
  );

  // ── GET /api/cinema/ingest/status ───────────────────────────────
  server.route("GET", "/api/cinema/ingest/status", () => {
    const runs = service.recentRuns(20);
    const total = service.countAll();
    const embedder = embedderRef();
    const pendingEmbeddings = embedder
      ? service.pendingEmbeddingIds(embedder.model, embedder.dim, 99999).length
      : null;
    return {
      total,
      pending_embeddings: pendingEmbeddings,
      embedder: embedder ? {
        provider: embedder.provider,
        model: embedder.model,
        dim: embedder.dim,
      } : null,
      collections: CINEMA_COLLECTIONS,
      recent_runs: runs,
    };
  });

  // ── POST /api/cinema/ingest/run ─────────────────────────────────
  // Manually trigger one ingest chunk (same code path as the cron handler)
  // — useful when the catalog is empty on first install and the user
  // doesn't want to wait for the 15-minute cron. Optional body:
  //   { collection?: string, pageSize?: number, maxPages?: number }
  server.route<{ collection?: string; pageSize?: number; maxPages?: number }>(
    "POST", "/api/cinema/ingest/run", ({ body }) => or502("manual ingest", async () => {
      const collections = body?.collection ? [body.collection] : CINEMA_COLLECTIONS;
      const result = await ingestNextChunk(service, collections, {
        pageSize: body?.pageSize,
        maxPages: body?.maxPages,
      });
      return { result };
    }),
  );

  // POST /api/cinema/embed/run — trigger one embedding batch now
  // Same code path the cinema:embed-pending agent uses, but exposed
  // over HTTP so an external script can drive a tight loop and fill
  // the catalog much faster than the cron's 5-minute tick. Body:
  //   { batch_size?: number }   default 96, max 256
  server.route<{ batch_size?: number }>("POST", "/api/cinema/embed/run", async ({ body }) => {
    const graph = graphRef();
    const embedder = embedderRef();
    if (!graph?.capabilities.cypher) throw new HttpError(503, "graph driver unavailable — neo4j down");
    if (!embedder) throw new HttpError(503, "embeddings client not initialised");
    const batchSize = Math.max(1, Math.min(body?.batch_size ?? 96, 256));
    const { embedPending } = await import("./embeddings.js");
    const result = await embedPending(service, embedder, graph, batchSize);
    const pending = service.pendingEmbeddingIds(embedder.model, embedder.dim, 99999).length;
    return {
      embedded: result.embedded,
      graph_writes: result.graphWrites,
      duration_ms: result.durationMs,
      pending,
      model: embedder.model,
      dim: embedder.dim,
    };
  });

  // ── Tag catalog ────────────────────────────────────────────────
  // GET /api/cinema/tags?limit=&q=
  //   limit  default 50, max 500
  //   q      optional prefix filter for autocomplete
  // The tags table is populated by POST /api/cinema/tags/rebuild (or the
  // cinema:rebuild-tags handler on cron). UI uses this for the chip row
  // and inline tag-search input.
  server.route("GET", "/api/cinema/tags", ({ query }) => {
    const limit = clampInt(query.get("limit"), 50, 1, 500);
    const q = query.get("q") ?? undefined;
    const tags = service.topTags(limit, q);
    return { tags, total: tags.length };
  });

  // ── Embedding runner (drives the bge-m3 → Neo4j vector indexer) ─
  // GET  /api/cinema/embed/status — full snapshot for the UI progress bar
  // POST /api/cinema/embed/start  { batch_size? }
  // POST /api/cinema/embed/stop   (graceful, finishes current batch)
  server.route("GET", "/api/cinema/embed/status", () =>
    wired(embedRunnerRef(), "embed runner").snapshot());

  server.route<{ batch_size?: number }>("POST", "/api/cinema/embed/start", ({ body }) =>
    wired(embedRunnerRef(), "embed runner").start({ batchSize: body?.batch_size }));

  server.route("POST", "/api/cinema/embed/stop", () =>
    wired(embedRunnerRef(), "embed runner").stop());

  // ── Catalogue → graph projection ─────────────────────────────────
  // GET  /api/cinema/graph/status — per-entity cursors + rate
  // POST /api/cinema/graph/start  { batch_size?, reset? }
  // POST /api/cinema/graph/stop   (graceful, finishes current batch)
  server.route("GET", "/api/cinema/graph/status", () =>
    wired(graphProjectionRunnerRef(), "graph projection runner").snapshot());

  server.route<{ batch_size?: number; reset?: boolean }>("POST", "/api/cinema/graph/start", ({ body }) =>
    wired(graphProjectionRunnerRef(), "graph projection runner")
      .start({ batchSize: body?.batch_size, reset: body?.reset === true }));

  server.route("POST", "/api/cinema/graph/stop", () =>
    wired(graphProjectionRunnerRef(), "graph projection runner").stop());

  // ── Graph-assisted identity recovery ─────────────────────────────
  // GET  /api/cinema/graph/resolve/status
  // POST /api/cinema/graph/resolve/start      { batch_size?, reset? }
  // POST /api/cinema/graph/resolve/stop
  // POST /api/cinema/graph/resolve/components  run WCC, send proposals to review
  // POST /api/cinema/graph/resolve/revert      undo every graph proposal
  server.route("GET", "/api/cinema/graph/resolve/status", () =>
    wired(graphResolveRunnerRef(), "resolve runner").snapshot());

  server.route<{ batch_size?: number; reset?: boolean }>("POST", "/api/cinema/graph/resolve/start", ({ body }) =>
    wired(graphResolveRunnerRef(), "resolve runner")
      .start({ batchSize: body?.batch_size, reset: body?.reset === true }));

  server.route("POST", "/api/cinema/graph/resolve/stop", () =>
    wired(graphResolveRunnerRef(), "resolve runner").stop());

  server.route("POST", "/api/cinema/graph/resolve/components", async () => {
    const db = wired(sqliteRef(), "sqlite");
    const t0 = Date.now();
    const result = await resolveComponents(db, graphRef());
    return { ...result, duration_ms: Date.now() - t0 };
  });

  server.route("POST", "/api/cinema/graph/resolve/revert", () => {
    const db = wired(sqliteRef(), "sqlite");
    const reverted = revertGraphProposals(db);
    return { reverted, stamps_cleared: clearStaleProposalStamps(db) };
  });

  // ── Translation runner ───────────────────────────────────────────
  // GET  /api/cinema/translate/status — snapshot for the UI progress bar
  // POST /api/cinema/translate/start  { concurrency? }
  // POST /api/cinema/translate/stop   (graceful, finishes in-flight calls)
  server.route("GET", "/api/cinema/translate/status", () =>
    wired(translateRunnerRef(), "translate runner").snapshot());

  server.route<{ concurrency?: number }>("POST", "/api/cinema/translate/start", ({ body }) =>
    wired(translateRunnerRef(), "translate runner").start({ concurrency: body?.concurrency }));

  server.route("POST", "/api/cinema/translate/stop", () =>
    wired(translateRunnerRef(), "translate runner").stop());

  // ── Discovery from the vectors ───────────────────────────────────
  // GET /api/cinema/similar/:identifier  the route from one film to the next
  // GET /api/cinema/for-you              the catalogue against your taste
  //
  // Both hydrate to full rows via filterByIds, so the grid renders them with
  // exactly the same card as everything else — badges, canon rails and all.
  server.route("GET", "/api/cinema/similar/:identifier", async ({ params: { identifier }, query }) => {
    const embedder = wired(embedderRef(), "embeddings client");
    const limit = clampInt(query.get("limit"), 12, 1, 60);
    const hits = await similarTo(embedder, graphRef(), identifier, limit);
    // filterByIds preserves the caller's order, so cosine ranking survives.
    const items = service.filterByIds(hits.map((h) => h.identifier), {});
    return { items, total: items.length };
  });

  server.route("GET", "/api/cinema/for-you", async ({ query }) => {
    const db = wired(sqliteRef(), "database");
    const embedder = wired(embedderRef(), "embeddings client");
    const limit = clampInt(query.get("limit"), 24, 1, 60);
    const result = await forYou(db, embedder, graphRef(), limit);
    const items = service.filterByIds(result.hits.map((h) => h.identifier), {});
    // `reason` is passed through rather than collapsed into an empty list:
    // "save a few films first" and "run the embed runner" are different
    // messages and the page needs to tell them apart.
    return {
      items,
      total: items.length,
      profile_size: result.profile_size,
      reason: result.reason,
    };
  });

  // ── Canon rails ──────────────────────────────────────────────────
  // GET  /api/cinema/canon/rails  the lists, and how much of each is held
  // POST /api/cinema/canon/sync   refresh membership from Wikidata
  //
  // `held` lets the page hide a rail the catalogue has nothing from,
  // rather than offering an empty shelf.
  server.route("GET", "/api/cinema/canon/rails", () => ({
    rails: canonRails(wired(sqliteRef(), "database")),
  }));

  server.route("POST", "/api/cinema/canon/sync", async () => {
    const db = wired(sqliteRef(), "database");
    const t0 = Date.now();
    const result = await syncCanonLists(db);
    return { ...result, duration_ms: Date.now() - t0 };
  });

  // ── File-level probe ─────────────────────────────────────────────
  // GET  /api/cinema/media/status      how much of the catalogue is probed
  // POST /api/cinema/media/start       { concurrency? }
  // POST /api/cinema/media/stop
  // POST /api/cinema/media/probe       { identifier } — one item, now
  server.route("GET", "/api/cinema/media/status", () =>
    wired(mediaRunnerRef(), "media runner").snapshot());

  server.route<{ concurrency?: number }>("POST", "/api/cinema/media/start", ({ body }) =>
    wired(mediaRunnerRef(), "media runner").start({ concurrency: body?.concurrency }));

  server.route("POST", "/api/cinema/media/stop", () =>
    wired(mediaRunnerRef(), "media runner").stop());

  // On-demand probe, so opening a title's page fills in its facts without
  // waiting for the background walk to reach it.
  server.route<{ identifier?: string }>("POST", "/api/cinema/media/probe", async ({ body }) => {
    const db = wired(sqliteRef(), "database");
    const identifier = (body?.identifier ?? "").trim();
    if (!identifier) throw new HttpError(400, "identifier required");
    const facts = await probeItem(identifier);
    recordFacts(db, identifier, facts);
    return { identifier, ...facts };
  });

  // ── Work-level dedupe ────────────────────────────────────────────
  // POST /api/cinema/works/rebuild        regroup the whole catalogue
  // GET  /api/cinema/works/stats          how much duplication there is
  // GET  /api/cinema/works/copies/:id     the other uploads of this film
  server.route("POST", "/api/cinema/works/rebuild", () => {
    const t0 = Date.now();
    const result = service.rebuildWorks();
    return { ...result, duration_ms: Date.now() - t0 };
  });

  server.route("GET", "/api/cinema/works/stats", () => service.worksStats());

  server.route("GET", "/api/cinema/works/copies/:identifier", ({ params: { identifier } }) => {
    const items = service.siblingCopies(identifier);
    return { items, total: items.length };
  });

  // ── Canonical identification ─────────────────────────────────────
  // GET  /api/cinema/canonical/status  corpus + match + ratings progress
  // POST /api/cinema/canonical/start   { phase?, slices_per_pass?, batch_size? }
  // POST /api/cinema/canonical/stop    (graceful, finishes current batch)
  // GET  /api/cinema/canonical/review  the grey zone awaiting a human
  // POST /api/cinema/canonical/decide  { identifier, qid }  — "" qid = reject
  server.route("GET", "/api/cinema/canonical/status", () =>
    wired(canonicalRunnerRef(), "canonical runner").snapshot());

  server.route<{ phase?: string; slices_per_pass?: number; batch_size?: number }>(
    "POST", "/api/cinema/canonical/start", ({ body }) => {
      const runner = wired(canonicalRunnerRef(), "canonical runner");
      // Only a phase the runner actually has; anything else starts from the
      // beginning rather than throwing at the user.
      const phase = (["corpus", "match", "ratings"] as const)
        .find((p) => p === body?.phase) as CanonicalPhase | undefined;
      return runner.start({
        phase,
        slicesPerPass: body?.slices_per_pass,
        batchSize: body?.batch_size,
      });
    },
  );

  server.route("POST", "/api/cinema/canonical/stop", () =>
    wired(canonicalRunnerRef(), "canonical runner").stop());

  server.route("GET", "/api/cinema/canonical/review", ({ query }) => {
    const canonical = wired(canonicalRef(), "canonical service");
    const limit = clampInt(query.get("limit"), 50, 1, 200);
    const offset = clampInt(query.get("offset"), 0, 0, 1_000_000);
    return {
      items: canonical.reviewQueue(limit, offset),
      total: canonical.countReview(),
      limit,
      offset,
    };
  });

  server.route<{ identifier?: string; qid?: string }>("POST", "/api/cinema/canonical/decide", ({ body }) => {
    const canonical = wired(canonicalRef(), "canonical service");
    const identifier = (body?.identifier ?? "").trim();
    if (!identifier) throw new HttpError(400, "identifier required");
    // An empty qid is a deliberate "none of these", not a missing field —
    // it records a rejection so the matcher stops proposing the same
    // candidates on every re-run.
    const qid = (body?.qid ?? "").trim();
    if (!canonical.decide(identifier, qid)) throw new HttpError(404, "no match row for that identifier");
    return { identifier, qid, state: qid ? "confirmed" : "rejected" };
  });

  // POST /api/cinema/tags/rebuild — rebuild cinema_tags from subject_json.
  // Cheap (~1-2s on 150k rows). Idempotent: drops the table contents and
  // re-populates. Caller-driven so the UI can refresh after big ingests.
  server.route("POST", "/api/cinema/tags/rebuild", () => {
    const t0 = Date.now();
    const result = service.rebuildTags();
    const ms = Date.now() - t0;
    return { ...result, duration_ms: ms };
  });

  // ── Subtitle marketplace ───────────────────────────────────────

  // GET /api/cinema/subs/by-video/:identifier
  // Returns local subs (we have the bytes), federated subs from our
  // discovery index, and optionally a fresh provider sweep when
  // ?refresh=1 is set. The frontend renders three sections: LOCAL,
  // FEDERADOS (with trust grouping), and grouped per provider.
  server.route("GET", "/api/cinema/subs/by-video/:identifier", async ({ params: { identifier: id }, query }) => {
    const refresh = query.get("refresh") === "1";

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

    return {
      identifier: id,
      local,
      federated,
      publishers,
      provider_errors: providerErrors,
      providers: registryRef()?.list().map((p) => ({
        id: p.id, label: p.label, canPublish: p.canPublish,
      })) ?? [],
    };
  });

  // POST /api/cinema/subs/publish
  //   { identifier, src_lang, tgt_lang, engine, engine_version,
  //     vtt_path?, srt_path?, sha256, size_bytes, magnet, webseed_url, content }
  //
  // Records the sub locally (cinema_subs) and broadcasts via every
  // publishable provider. Returns the new local row + per-provider
  // outcomes so the caller can show a "published to: nostr" toast.
  server.route<{
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
  }>("POST", "/api/cinema/subs/publish", ({ body }) => or502("sub publish", async () => {
    if (!body?.identifier || !body.tgt_lang || !body.engine) {
      throw new HttpError(400, "identifier, tgt_lang and engine are required");
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
    if (!reg) return { local, publish: { successes: [], failures: [] } };
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

    return { local, publish };
  }));

  // POST /api/cinema/subs/trust  { pubkey, trust, alias?, notes? }
  server.route<{ pubkey: string; trust: PublisherTrust; alias?: string; notes?: string }>(
    "POST", "/api/cinema/subs/trust", ({ body }) => {
      const pk = (body?.pubkey ?? "").trim();
      const trust = body?.trust;
      if (!pk) throw new HttpError(400, "pubkey required");
      if (!trust || !["mine", "trusted", "blocked", "unknown"].includes(trust)) {
        throw new HttpError(400, "trust must be one of mine|trusted|blocked|unknown");
      }
      return { publisher: subs.setTrust(pk, trust, body?.alias, body?.notes) };
    },
  );

  // GET /api/cinema/subs/publishers
  server.route("GET", "/api/cinema/subs/publishers", () => ({ publishers: subs.listPublishers() }));

  // GET /api/cinema/subs/providers — registry status for the UI
  server.route("GET", "/api/cinema/subs/providers", () => ({
    providers: registryRef()?.list().map((p) => ({
      id: p.id, label: p.label, canPublish: p.canPublish,
    })) ?? [],
  }));

  // POST /api/cinema/subs/download  { rowId }
  // Materialises a federated announcement: fetches the webseed bytes,
  // (optionally) checks sha256, converts SRT→VTT if needed, writes the
  // file to the SAME cache the legacy torrents/subs pipeline uses
  // (data/subtitles/<sha1>.vtt + sidecar), then inserts a cinema_subs
  // row marked origin=federated|archive_org so the player can serve it
  // back via /api/cinema/media/subs/file?key=<sha1> with no extra plumbing.
  server.route<{ rowId: string }>("POST", "/api/cinema/subs/download", async ({ body }) => {
    const rowId = (body?.rowId ?? "").trim();
    if (!rowId) throw new HttpError(400, "rowId required");

    const ann = subs.getIndex(rowId);
    if (!ann) throw new HttpError(404, "row not found");
    if (!ann.webseedUrl) {
      throw new HttpError(400, "row has no webseed_url; magnet-only download not supported in stage 4b");
    }
    if (ann.downloadedSubId) {
      const existing = subs.getLocal(ann.downloadedSubId);
      if (existing) return { local: existing, cached: true };
    }

    // SSRF guard — federated rows can carry attacker-supplied URLs that
    // resolve to private/loopback addresses. Reject before any fetch().
    const guard = await guardOutboundUrl(ann.webseedUrl);
    if (!guard.ok) throw new HttpError(400, `webseed url rejected: ${guard.reason}`);

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
      if (!r.ok) throw new HttpError(502, `webseed ${r.status} ${r.statusText}`);
      // Most subtitle files fit in a single response; cap to 4 MiB to
      // avoid an attacker-controlled URL flooding the cache.
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 4_194_304) throw new HttpError(413, `subtitle too large (${buf.length} bytes)`);
      raw = buf.toString("utf8");
    } finally {
      clearTimeout(timer);
    }

    // Optional integrity check. Archive.org doesn't ship sha256 so we
    // skip when missing; for Nostr-announced subs we ENFORCE.
    if (ann.sha256 && ann.providerId !== "archive_org") {
      const got = createHash("sha256").update(raw, "utf8").digest("hex");
      if (got.toLowerCase() !== ann.sha256.toLowerCase()) {
        throw new HttpError(409, "sha256 mismatch", {
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
    if (cues.length === 0) throw new HttpError(422, "could not parse any subtitle cues — bad SRT/VTT?");
    const vtt = encodeVtt(cues);

    // sha1 key matches the legacy cache convention so the existing
    // /api/cinema/media/subs/file?key=… serves these without changes.
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

    return {
      local,
      cache_key: cacheKey,
      play_url: `/api/cinema/media/subs/file?key=${cacheKey}`,
      cue_count: cues.length,
    };
  });

  // ── Community directories ──────────────────────────────────────
  // Local CRUD + Nostr-federated discover/follow/sync. Visible at
  // /cinema/directories in the dashboard.
  const requireDirs = () => wired(dirsRef(), "directories service");

  server.route("GET", "/api/cinema/directories", ({ query }) => {
    const dirs = requireDirs();
    const origin = (query.get("origin") || undefined) as "local" | "federated" | undefined;
    const subscribedOnly = query.get("subscribed") === "1";
    const category = query.get("category") || undefined;
    const ownerPubkey = query.get("owner") || undefined;
    const limit = clampInt(query.get("limit"), 50, 1, 500);
    const offset = clampInt(query.get("offset"), 0, 0, 1_000_000);
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
    return { directories: hydrated, total: hydrated.length };
  });

  server.route("GET", "/api/cinema/directories/discover", ({ query }) => or502("directories discover", async () => {
    const provider = wired(dirsProviderRef(), "directories nostr provider");
    const category = query.get("category") || undefined;
    const ownerPubkey = query.get("owner") || undefined;
    const limit = clampInt(query.get("limit"), 50, 1, 500);
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
    return { directories: previews, total: previews.length };
  }));

  server.route("GET", "/api/cinema/directories/:id", ({ params: { id } }) => {
    const d = requireDirs().get(id);
    if (!d) throw new HttpError(404, "not found");
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
    return { directory: d, items };
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

  server.route<CreateDirectoryInput & { owner_pubkey?: string }>("POST", "/api/cinema/directories", ({ body }) => {
    const dirs = requireDirs();
    const identity = localIdentityRef();
    if (!identity) throw new HttpError(503, "local nostr identity not initialised — cannot own a directory");
    if (!body?.title) throw new HttpError(400, "title required");
    const created = dirs.create({
      ...body,
      owner_pubkey: identity.pubkeyHex,
    });
    // Don't await — let the user see the response immediately. Auto-
    // publish runs as a fire-and-forget side effect.
    autoPublishIfPublic(created.id);
    return { directory: created };
  });

  // An empty body is an empty patch: update() leaves the row untouched.
  server.route<UpdateDirectoryInput>("POST", "/api/cinema/directories/:id/update", ({ params: { id }, body }) => {
    const updated = requireDirs().update(id, body ?? {});
    if (!updated) throw new HttpError(404, "not found or not editable");
    autoPublishIfPublic(id);
    return { directory: updated };
  });

  server.route("POST", "/api/cinema/directories/:id/delete", ({ params: { id } }) => ({
    ok: requireDirs().delete(id),
  }));

  server.route<{ identifier: string; note?: string }>(
    "POST", "/api/cinema/directories/:id/items", ({ params: { id }, body }) => {
      const dirs = requireDirs();
      if (!body?.identifier) throw new HttpError(400, "identifier required");
      const updated = dirs.addItem(id, body.identifier, body.note);
      if (!updated) throw new HttpError(404, "not found");
      autoPublishIfPublic(id);
      return { directory: updated };
    },
  );

  server.route<{ identifier: string }>(
    "POST", "/api/cinema/directories/:id/items/remove", ({ params: { id }, body }) => {
      const dirs = requireDirs();
      if (!body?.identifier) throw new HttpError(400, "identifier required");
      const updated = dirs.removeItem(id, body.identifier);
      if (!updated) throw new HttpError(404, "not found");
      autoPublishIfPublic(id);
      return { directory: updated };
    },
  );

  server.route("POST", "/api/cinema/directories/:id/publish", ({ params: { id } }) => or502("directory publish", async () => {
    const dirs = requireDirs();
    const provider = dirsProviderRef();
    if (!provider || !provider.canPublish) {
      throw new HttpError(503, "nostr identity not configured — cannot publish");
    }
    const d = dirs.get(id);
    if (!d) throw new HttpError(404, "not found");
    if (d.origin !== "local") throw new HttpError(400, "only local-owned directories can be published");
    const result = await provider.publish(d);
    dirs.markPublished(id, result.eventId);
    return { event_id: result.eventId, relays: result.relays };
  }));

  server.route<{ owner_pubkey: string }>(
    "POST", "/api/cinema/directories/:id/follow", async ({ params: { id }, body }) => {
      const dirs = requireDirs();
      const provider = dirsProviderRef();
      const owner = body?.owner_pubkey?.trim();
      if (!owner) throw new HttpError(400, "owner_pubkey required");
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
      return { subscription: sub, directory: dirs.get(id) };
    },
  );

  server.route<{ owner_pubkey: string }>(
    "POST", "/api/cinema/directories/:id/unfollow", ({ params: { id }, body }) => {
      const dirs = requireDirs();
      if (!body?.owner_pubkey) throw new HttpError(400, "owner_pubkey required");
      return { ok: dirs.unfollow(id, body.owner_pubkey) };
    },
  );

  // POST /api/cinema/directories/sync — pull latest for every subscribed dir.
  // Bulk variant that the UI / agent calls; the singular-dir version is
  // implicit in /follow above.
  server.route("POST", "/api/cinema/directories/sync", async () => {
    const dirs = requireDirs();
    const provider = wired(dirsProviderRef(), "directories provider");
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
    return { subscriptions: subs.length, pulled, created, updated, rejected };
  });
}
