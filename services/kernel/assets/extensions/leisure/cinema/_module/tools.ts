/**
 * MCP tools for the cinema module. Each tool is a thin wrapper around
 * the existing service / API behavior so agents can reach the same
 * surface the dashboard already uses.
 *
 * The factory takes lazy getters for neo4j + embeddings + registry
 * because those are wired post-bootstrap (same pattern as the routes).
 */

import { z } from "zod";
import type { ToolDefinition } from "../../../../../src/core/types.js";
import { errorResult, extractErrorMessage, textResult } from "../../../../../src/core/helpers.js";
import type { GraphDriver } from "../../../../../src/core/db-drivers/graph-driver.js";
import type { EmbeddingsClient } from "../../../../../src/core/embeddings/index.js";
import type { CinemaService } from "./service.js";
import type { CinemaSubsService } from "./subs-service.js";
import type { DiscoveryRegistry } from "./discovery/registry.js";
import { searchSimilar } from "./embeddings.js";
import { ingestNextChunk, CINEMA_COLLECTIONS } from "./ingester.js";

interface CinemaToolDeps {
  service: CinemaService;
  subs: CinemaSubsService;
  graph: () => GraphDriver | null;
  embedder: () => EmbeddingsClient | null;
  registry: () => DiscoveryRegistry | null;
}

const SortEnum = z.enum(["downloads", "year_desc", "year_asc", "added_desc", "rating"]);

export function cinemaTools(deps: CinemaToolDeps): ToolDefinition[] {
  return [
    {
      name: "kernel_cinema_list",
      description:
        "List titles from the local cinema catalog (archive.org mirror). Filter by collection, year range, watchlist, and free-text query. Use this for browsing the catalog without semantic search.",
      inputSchema: z.object({
        query: z.string().optional().describe("free text — matches title, description, creator"),
        collection: z.string().optional().describe("e.g. 'feature_films', 'silent_films'"),
        year_min: z.number().optional(),
        year_max: z.number().optional(),
        watchlist: z.boolean().optional().describe("when true, return only watchlist items"),
        sort: SortEnum.optional().describe("default 'downloads'"),
        limit: z.number().int().min(1).max(200).optional().describe("default 20"),
        offset: z.number().int().min(0).optional(),
      }),
      handler: async (args) => {
        try {
          const a = args as {
            query?: string; collection?: string;
            year_min?: number; year_max?: number;
            watchlist?: boolean; sort?: z.infer<typeof SortEnum>;
            limit?: number; offset?: number;
          };
          const items = deps.service.list({
            query: a.query, collection: a.collection,
            yearMin: a.year_min, yearMax: a.year_max,
            watchlist: a.watchlist, sort: a.sort,
            limit: a.limit ?? 20, offset: a.offset ?? 0,
          });
          const total = deps.service.countAll({
            query: a.query, collection: a.collection,
            yearMin: a.year_min, yearMax: a.year_max,
            watchlist: a.watchlist,
          });
          const lines = items.map((t) =>
            `• ${t.identifier.padEnd(36)}  ${t.title.slice(0, 60).padEnd(60)}  ${t.year || "????"}  ↓${t.downloads.toLocaleString()}`,
          );
          return textResult(
            `${items.length}/${total} titles\n${lines.join("\n") || "(empty)"}`,
          );
        } catch (err) {
          return errorResult(`list failed: ${extractErrorMessage(err)}`);
        }
      },
    },

    {
      name: "kernel_cinema_search",
      description:
        "Semantic search over the cinema catalog. Returns titles ranked by cosine similarity to the query embedding (multilingual, Spanish-friendly via bge-m3). Use this when the user describes what they want in natural language instead of giving keywords.",
      inputSchema: z.object({
        query: z.string().describe("natural-language query, e.g. 'silent films with vampires'"),
        limit: z.number().int().min(1).max(50).optional().describe("default 10"),
      }),
      handler: async (args) => {
        try {
          const a = args as { query: string; limit?: number };
          const graph = deps.graph();
          const embedder = deps.embedder();
          if (!graph?.capabilities.cypher) {
            return errorResult("semantic search unavailable: activate a graph driver with cypher support in /extensions");
          }
          if (!embedder) {
            return errorResult("semantic search unavailable: embeddings client not initialised");
          }
          const hits = await searchSimilar(embedder, graph, a.query, a.limit ?? 10);
          if (hits.length === 0) {
            return textResult(`no hits for "${a.query}"`);
          }
          const lines = hits.map((h) => {
            const t = deps.service.getByIdentifier(h.identifier);
            const title = (t?.title ?? h.title ?? h.identifier).slice(0, 60).padEnd(60);
            return `${h.score.toFixed(3)}  ${title}  ${h.year || "????"}  [${h.identifier}]`;
          });
          return textResult(
            `${hits.length} hits for "${a.query}":\n${lines.join("\n")}`,
          );
        } catch (err) {
          return errorResult(`search failed: ${extractErrorMessage(err)}`);
        }
      },
    },

    {
      name: "kernel_cinema_get",
      description:
        "Fetch the full metadata for a single archive.org title (description, subjects, runtime, watchlist state, rating, etc.).",
      inputSchema: z.object({
        identifier: z.string().describe("archive.org item identifier"),
      }),
      handler: async (args) => {
        try {
          const a = args as { identifier: string };
          const t = deps.service.getByIdentifier(a.identifier);
          if (!t) return errorResult(`not found: ${a.identifier}`);
          const lines = [
            `${t.title}  (${t.year || "????"})`,
            `identifier: ${t.identifier}`,
            `creator: ${t.creator || "—"}`,
            `collection: ${t.collection.join(", ") || "—"}`,
            `subject: ${t.subject.slice(0, 8).join(", ") || "—"}`,
            `language: ${t.language || "—"}`,
            `runtime_sec: ${t.runtime_sec || "?"}`,
            `downloads: ${t.downloads.toLocaleString()}  rating: ${t.avg_rating.toFixed(2)}/${t.num_reviews}`,
            `has_torrent: ${t.has_torrent ? "yes" : "no"}`,
            `watchlist: ${t.watchlist ? "★" : "—"}  watched: ${t.watched_at ?? "—"}`,
            "",
            t.description ? t.description.slice(0, 800) + (t.description.length > 800 ? "…" : "") : "(no description)",
          ];
          return textResult(lines.join("\n"));
        } catch (err) {
          return errorResult(extractErrorMessage(err));
        }
      },
    },

    {
      name: "kernel_cinema_watchlist",
      description:
        "Toggle a title in the watchlist. Idempotent — set 'watchlist' to true to add, false to remove.",
      inputSchema: z.object({
        identifier: z.string(),
        watchlist: z.boolean(),
      }),
      handler: async (args) => {
        try {
          const a = args as { identifier: string; watchlist: boolean };
          deps.service.setWatchlist(a.identifier, a.watchlist);
          const t = deps.service.getByIdentifier(a.identifier);
          if (!t) return errorResult(`not found: ${a.identifier}`);
          return textResult(
            `${t.title} → watchlist=${t.watchlist ? "★" : "—"}`,
          );
        } catch (err) {
          return errorResult(extractErrorMessage(err));
        }
      },
    },

    {
      name: "kernel_cinema_watched",
      description:
        "Mark a title as watched (timestamps watched_at) or unmark it.",
      inputSchema: z.object({
        identifier: z.string(),
        watched: z.boolean(),
      }),
      handler: async (args) => {
        try {
          const a = args as { identifier: string; watched: boolean };
          deps.service.setWatched(a.identifier, a.watched);
          const t = deps.service.getByIdentifier(a.identifier);
          if (!t) return errorResult(`not found: ${a.identifier}`);
          return textResult(`${t.title} → watched_at=${t.watched_at ?? "—"}`);
        } catch (err) {
          return errorResult(extractErrorMessage(err));
        }
      },
    },

    {
      name: "kernel_cinema_subs_list",
      description:
        "List subtitles available for a movie: LOCAL (locally generated), FEDERATED (Nostr / archive.org index, may not be downloaded). Set refresh=true to fan-out to providers in real time.",
      inputSchema: z.object({
        identifier: z.string(),
        refresh: z.boolean().optional().describe("default false"),
      }),
      handler: async (args) => {
        try {
          const a = args as { identifier: string; refresh?: boolean };
          if (a.refresh) {
            const reg = deps.registry();
            if (reg) {
              const r = await reg.queryAll({ identifier: a.identifier, limit: 100 });
              for (const ann of r.items) deps.subs.upsertIndex(ann);
            }
          }
          const local = deps.subs.listLocalByVideo(a.identifier);
          const federated = deps.subs.listIndexByVideo(a.identifier);
          const localLines = local.map((l) =>
            `  · ${l.tgt_lang.padEnd(4)}  ${l.engine.padEnd(10)}  origin=${l.origin}  ${l.size_bytes}B  ${l.published_at ? "published" : "not published"}`,
          );
          const fedLines = federated.map((r) => {
            const status = r.downloadedSubId ? "✓ downloaded" : "available";
            return `  · ${r.providerId.padEnd(12)} ${r.tgtLang.padEnd(4)} ${r.engine.padEnd(10)} signer=${r.signerPubkey ? r.signerPubkey.slice(0, 12) + "…" : "—"} ${status}`;
          });
          return textResult([
            `Subtitles for ${a.identifier}:`,
            `LOCAL (${local.length}):`,
            localLines.join("\n") || "  (none)",
            "",
            `FEDERATED (${federated.length}):`,
            fedLines.join("\n") || "  (none — try refresh=true)",
          ].join("\n"));
        } catch (err) {
          return errorResult(extractErrorMessage(err));
        }
      },
    },

    {
      name: "kernel_cinema_subs_publish",
      description:
        "Announce a locally-generated subtitle to every publishable discovery provider (Nostr, archive.org S3 if configured). Records the local row first, then broadcasts. Caller is responsible for the file already existing on disk (or a webseed URL).",
      inputSchema: z.object({
        identifier: z.string(),
        src_lang: z.string().optional(),
        tgt_lang: z.string(),
        engine: z.string(),
        engine_version: z.string().optional(),
        webseed_url: z.string().optional(),
        magnet: z.string().optional(),
        sha256: z.string().optional(),
        size_bytes: z.number().optional(),
        content: z.string().optional().describe("free-form description for the announcement"),
      }),
      handler: async (args) => {
        try {
          const a = args as {
            identifier: string; src_lang?: string; tgt_lang: string;
            engine: string; engine_version?: string;
            webseed_url?: string; magnet?: string;
            sha256?: string; size_bytes?: number; content?: string;
          };
          const local = deps.subs.insertLocal({
            identifier: a.identifier,
            src_lang: a.src_lang ?? "",
            tgt_lang: a.tgt_lang,
            engine: a.engine,
            engine_version: a.engine_version ?? "",
            origin: "local",
            webseed_url: a.webseed_url ?? "",
            magnet: a.magnet ?? "",
            sha256: a.sha256 ?? "",
            size_bytes: a.size_bytes ?? 0,
          });
          const reg = deps.registry();
          if (!reg) {
            return textResult(`Local row created (${local.id}); no discovery registry — broadcast skipped`);
          }
          const result = await reg.publishAll({
            identifier: a.identifier,
            srcLang: a.src_lang ?? "",
            tgtLang: a.tgt_lang,
            engine: a.engine,
            engineVersion: a.engine_version ?? "",
            magnet: a.magnet ?? "",
            webseedUrl: a.webseed_url ?? "",
            sha256: a.sha256 ?? "",
            sizeBytes: a.size_bytes ?? 0,
            content: a.content ?? "",
          });
          if (result.successes.length > 0) deps.subs.markPublished(local.id);
          const ok = result.successes.map((s) => `  ✓ ${s.providerId} ${s.detail}`).join("\n");
          const fail = result.failures.map((f) => `  ✗ ${f.providerId} ${f.error.slice(0, 80)}`).join("\n");
          return textResult([
            `Local row ${local.id}`,
            `Published to ${result.successes.length} provider(s):`,
            ok || "  (none)",
            result.failures.length > 0 ? `Failures:\n${fail}` : "",
          ].filter(Boolean).join("\n"));
        } catch (err) {
          return errorResult(extractErrorMessage(err));
        }
      },
    },

    {
      name: "kernel_cinema_publisher_trust",
      description:
        "Set trust level for a subtitle publisher (Nostr pubkey, hex). Affects which subs the player surfaces by default.",
      inputSchema: z.object({
        pubkey: z.string().describe("x-only secp256k1 hex (Nostr-style)"),
        trust: z.enum(["mine", "trusted", "blocked", "unknown"]),
        alias: z.string().optional(),
        notes: z.string().optional(),
      }),
      handler: async (args) => {
        try {
          const a = args as {
            pubkey: string;
            trust: "mine" | "trusted" | "blocked" | "unknown";
            alias?: string; notes?: string;
          };
          const p = deps.subs.setTrust(a.pubkey, a.trust, a.alias, a.notes);
          return textResult(
            `${p.pubkey.slice(0, 16)}…  alias=${p.alias || "—"}  trust=${p.trust}`,
          );
        } catch (err) {
          return errorResult(extractErrorMessage(err));
        }
      },
    },

    {
      name: "kernel_cinema_ingest_status",
      description:
        "Report on the cinema catalog ingester: total titles, embedding backlog, recent runs per collection, embedder info.",
      inputSchema: z.object({}),
      handler: async () => {
        try {
          const total = deps.service.countAll();
          const embedder = deps.embedder();
          const pending = embedder
            ? deps.service.pendingEmbeddingIds(embedder.model, embedder.dim, 99999).length
            : 0;
          const runs = deps.service.recentRuns(10);
          const runLines = runs.map((r) =>
            `  · ${r.collection.padEnd(20)} status=${r.status.padEnd(7)} fetched=${String(r.fetched).padStart(5)} cursor=${r.cursor ? "…" + r.cursor.slice(-12) : "—"}`,
          );
          return textResult([
            `Cinema catalog: ${total} titles`,
            embedder
              ? `Embedder: ${embedder.provider} ${embedder.model} dim=${embedder.dim}  pending=${pending}`
              : `Embedder: not initialised  pending=?`,
            `Collections: ${CINEMA_COLLECTIONS.join(", ")}`,
            "",
            "Recent runs:",
            runLines.join("\n") || "  (none yet)",
          ].join("\n"));
        } catch (err) {
          return errorResult(extractErrorMessage(err));
        }
      },
    },

    {
      name: "kernel_cinema_ingest_run",
      description:
        "Trigger one ingest pass against the archive.org scrape API right now (same code path as the cron). Useful when the user wants to populate a fresh kernel without waiting 15 min.",
      inputSchema: z.object({
        collection: z.string().optional().describe("optional — restrict to one collection (default: rotate through all)"),
        max_pages: z.number().int().min(1).max(10).optional().describe("default 1"),
      }),
      handler: async (args) => {
        try {
          const a = args as { collection?: string; max_pages?: number };
          const collections = a.collection ? [a.collection] : CINEMA_COLLECTIONS;
          const result = await ingestNextChunk(deps.service, collections, {
            maxPages: a.max_pages ?? 1,
          });
          if (!result) return textResult("no work picked");
          return textResult(
            `${result.collection}: pages=${result.pages} fetched=${result.fetched} ` +
              `inserted=${result.inserted} updated=${result.updated} ` +
              `${result.finished ? "✓ finished" : "more remain"} (${result.durationMs} ms)`,
          );
        } catch (err) {
          return errorResult(extractErrorMessage(err));
        }
      },
    },
  ];
}
