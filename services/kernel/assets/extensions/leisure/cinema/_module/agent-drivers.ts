/**
 * Cinema agent drivers — scheduled no-LLM agents owned by this extension.
 *
 * Moved here from the kernel's builtin-handlers.ts: the kernel no longer
 * names cinema anywhere. Each driver closes over this module's own services
 * (via live getters, since several refs are rebound post-init by
 * setSearchInfra / setNostrIdentity). Handler ids are stable — existing
 * `agents` rows keep resolving by `builtin_handler`.
 *
 * The cache-warmer is the one driver with a cross-extension dependency
 * (torrents owns the archive.org search cache); it resolves the torrents
 * module lazily through ctx.getModule at run time and degrades to a skip
 * message when torrents isn't installed.
 */

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type { AgentDriver, KernelModule, ModuleContext } from "../../../../../src/core/types.js";
import type { GraphDriver } from "../../../../../src/core/db-drivers/graph-driver.js";
import type { EmbeddingsClient } from "../../../../../src/core/embeddings/index.js";
import { log } from "../../../../../src/core/logger.js";

import type { CinemaService } from "./service.js";
import type { CinemaSubsService } from "./subs-service.js";
import type { CinemaDirectoriesService } from "./directories-service.js";
import type { DiscoveryRegistry } from "./discovery/registry.js";
import type { NostrDirectoriesProvider } from "./discovery/nostr-directories-provider.js";
import { ingestNextChunk } from "./ingester.js";
import { watchRssFeeds } from "./rss-watcher.js";
import { embedPending } from "./embeddings.js";

export interface CinemaDriverDeps {
  /** Live getters — all of these can be rebound after module init. */
  service: () => CinemaService | null;
  subs: () => CinemaSubsService | null;
  registry: () => DiscoveryRegistry | null;
  directories: () => CinemaDirectoriesService | null;
  directoriesProvider: () => NostrDirectoriesProvider | null;
  embedder: () => EmbeddingsClient | null;
  graph: () => GraphDriver | null;
  /** Module context captured at initialize() — config + sibling lookup. */
  ctx: () => ModuleContext | null;
}

// ── Cache warmer constants (unchanged from the kernel-era handler) ──
const CINEMA_COLLECTIONS = [
  "feature_films",
  "silent_films",
  "classic_cartoons",
  "classic_tv",
  "film_noir",
  "horror",
  "sci-fi_horror",
  "prelinger",
  "opensource_movies",
];
const CINEMA_PAGES = 8;          // depth per collection (rows × pages = max items cached)
const CINEMA_ROWS = 60;          // matches the dashboard default
const CINEMA_PER_RUN = 3;        // upstream fetches per scheduler tick (every 30 min)
const CINEMA_TTL_MS = 6 * 60 * 60 * 1000; // 6h, same as the API endpoint
const CINEMA_DELAY_MS = 2_000;   // throttle between archive.org fetches

/** Structural view of the torrents module (paid extension — no type import). */
interface TorrentsModuleLike extends KernelModule {
  getService?: () => {
    getArchiveSearchCache: <T>(key: string, maxAgeMs: number) => T[] | null;
    setArchiveSearchCache: <T>(key: string, items: T[]) => void;
  } | null;
  getArchiveHelpers?: () => {
    searchArchive: (q: Record<string, unknown>) => Promise<unknown[]>;
    archiveCacheKey: (q: Record<string, unknown>) => string;
  };
}

function resolveTorrents(ctx: ModuleContext | null): TorrentsModuleLike | null {
  if (!ctx?.getModule) return null;
  return (ctx.getModule("ext:torrents") ?? ctx.getModule("torrents")) as TorrentsModuleLike | null;
}

/** Extract archive.org identifier from a download URL.
 *  https://archive.org/download/<id>/... → <id>. Returns "" if URL
 *  doesn't match the archive.org pattern. */
function archiveIdFromUrl(url: string): string {
  const m = /^https?:\/\/(?:www\.)?archive\.org\/download\/([^/]+)\//.exec(url);
  return m ? decodeURIComponent(m[1]) : "";
}

export function cinemaAgentDrivers(deps: CinemaDriverDeps): AgentDriver[] {
  return [
    // ── Cache warmer ─────────────────────────────────────────────
    // Iterates the curated /cinema collections × pages, picks the entries
    // that are missing or stale in archive_search_cache, and refreshes them
    // against archive.org with a polite delay.
    {
      handler: "cinema:cache-warmer",
      name: "Cinema Cache Warmer",
      description: "Pre-fetches archive.org movie pages into the SQLite cache so /cinema renders without hitting upstream. Runs every 30 min, picks 3 missing/stale pages per tick.",
      cron: "*/30 * * * *",
      flow: "Leisure",
      run: async () => {
        const torrents = resolveTorrents(deps.ctx());
        const ts = torrents?.getService?.() ?? null;
        const archive = torrents?.getArchiveHelpers?.() ?? null;
        if (!ts || !archive) {
          return "Cinema warmer skipped: torrents extension not active (owns the archive.org cache).";
        }

        // Build the full (collection, page) matrix and pick entries that are
        // missing or stale. Walk in a stable order so successive ticks
        // naturally cover different cells before circling back.
        const candidates: Array<{ collection: string; page: number; key: string }> = [];
        for (const collection of CINEMA_COLLECTIONS) {
          for (let page = 1; page <= CINEMA_PAGES; page++) {
            const params = { collection, rows: CINEMA_ROWS, page };
            const key = archive.archiveCacheKey(params);
            const fresh = ts.getArchiveSearchCache(key, CINEMA_TTL_MS);
            if (!fresh) candidates.push({ collection, page, key });
          }
        }

        if (candidates.length === 0) {
          return `Cinema cache fully warm — ${CINEMA_COLLECTIONS.length} collections × ${CINEMA_PAGES} pages all fresh.`;
        }

        const todo = candidates.slice(0, CINEMA_PER_RUN);
        const logLines: string[] = [];
        let totalItems = 0;
        let upstreamErrors = 0;

        for (let i = 0; i < todo.length; i++) {
          const { collection, page, key } = todo[i];
          try {
            const items = await archive.searchArchive({ collection, rows: CINEMA_ROWS, page });
            ts.setArchiveSearchCache(key, items);
            totalItems += items.length;
            logLines.push(`• ${collection} p${page}: ${items.length} items`);
            // Be polite to archive.org between successive upstream calls.
            if (i < todo.length - 1) await new Promise((r) => setTimeout(r, CINEMA_DELAY_MS));
          } catch (err) {
            upstreamErrors++;
            const msg = err instanceof Error ? err.message : String(err);
            logLines.push(`• ${collection} p${page}: error — ${msg}`);
          }
        }

        const remaining = candidates.length - todo.length;
        return [
          `🎬 Cinema warmer · ${todo.length} pages refreshed · ${totalItems} items`,
          ...logLines,
          remaining > 0
            ? `still cold/stale: ${remaining} entries (next tick will pick more)`
            : "all entries warm — next tick will refresh stale ones",
          upstreamErrors > 0 ? `errors: ${upstreamErrors}` : "",
        ].filter(Boolean).join("\n");
      },
    },

    // ── Archive ingester (Stage 1) ───────────────────────────────
    {
      handler: "cinema:archive-ingester",
      name: "Cinema Archive Ingester",
      description: "Walks the archive.org scrape API, upserts titles into cinema_titles. One page per tick (~200 rows). Resumes via cursor across kernel restarts.",
      cron: "*/15 * * * *",
      flow: "Automations",
      run: async () => {
        const svc = deps.service();
        const config = deps.ctx()?.config;
        if (!svc || !config) return "Cinema ingester skipped: cinema service not wired.";

        const result = await ingestNextChunk(svc);
        if (!result) return "Cinema ingester: no work picked (collections empty?).";

        const totalCatalog = svc.countAll();
        const remaining = svc.pendingEmbeddingIds(
          config.embeddings.model,
          config.embeddings.dim,
          99999,
        ).length;

        return [
          `🎬 Cinema ingest · ${result.collection} · ${result.fetched} fetched`,
          `inserted=${result.inserted}  updated=${result.updated}  ${result.finished ? "✓ collection complete" : "more pages remain"}`,
          `catalog now: ${totalCatalog} titles · ${remaining} pending embedding (${config.embeddings.model})`,
        ].join("\n");
      },
    },

    // ── RSS watcher (near-real-time newest uploads) ──────────────
    {
      handler: "cinema:rss-watcher",
      name: "Cinema RSS Watcher",
      description: "Polls the per-collection RSS feeds for the newest uploads, hydrates ONLY new identifiers via a batch scrape call, upserts into cinema_titles. Near-real-time complement to the full ingester.",
      cron: "*/10 * * * *",
      flow: "Automations",
      run: async () => {
        const svc = deps.service();
        if (!svc) return "Cinema rss-watcher skipped: cinema service not wired.";

        const result = await watchRssFeeds(svc);

        // Per-collection summary, but only for feeds that actually had new
        // material — keeps the log readable on uneventful ticks.
        const lively = result.perCollection.filter((c) => c.new > 0);
        const livelyLine = lively.length === 0
          ? "no new uploads detected"
          : lively.map((c) => `${c.collection}+${c.new}`).join(" · ");

        return [
          `🎬 Cinema RSS · ${result.feedsOk}/${result.feedsOk + result.feedsErr} feeds OK · ${result.rssIds} items seen`,
          `${result.newIds} new identifiers · ${result.upserted} upserted via scrape · ${result.durationMs}ms`,
          livelyLine,
        ].join("\n");
      },
    },

    // ── Embeddings worker (Stage 2) ──────────────────────────────
    {
      handler: "cinema:embed-pending",
      name: "Cinema Embeddings Worker",
      description: "Embeds pending cinema_titles via LMStudio bge-m3 (or local MiniLM fallback) and stores vectors as (:CinemaTitle) nodes in Neo4j. Up to 96 titles per tick. No-ops gracefully if Neo4j/embeddings unavailable.",
      cron: "*/5 * * * *",
      flow: "Automations",
      timeout_ms: 180_000,
      run: async () => {
        const svc = deps.service();
        const client = deps.embedder();
        const graph = deps.graph();
        if (!svc) return "Cinema embedder skipped: cinema service not wired.";
        if (!client) return "Cinema embedder skipped: embeddings client not wired.";
        if (!graph?.capabilities.cypher) {
          return "Cinema embedder: skipped — no graph driver active with cypher support. Activate one in /extensions.";
        }

        // 96 rows ≈ 3 batches of 32 ≈ ~6 sec on LMStudio bge-m3. Good per-tick
        // budget when running every few minutes; tune via cron frequency, not
        // here — bigger per-tick batches just make logs noisier.
        const batchTarget = 96;
        let totalEmbedded = 0;
        let totalGraph = 0;
        let totalMs = 0;
        while (totalEmbedded < batchTarget) {
          const r = await embedPending(svc, client, graph, Math.min(32, batchTarget - totalEmbedded));
          if (r.embedded === 0) break;
          totalEmbedded += r.embedded;
          totalGraph += r.graphWrites;
          totalMs += r.durationMs;
        }
        if (totalEmbedded === 0) {
          return `🎬 Cinema embedder: catalog fully embedded (${client.model}, ${client.dim}d).`;
        }
        const stillPending = svc.pendingEmbeddingIds(client.model, client.dim, 99999).length;
        return [
          `🎬 Cinema embed · ${totalEmbedded} titles · ${totalGraph} graph writes · ${totalMs} ms (${(totalMs / Math.max(1, totalEmbedded)).toFixed(0)} ms/title)`,
          `model=${client.model} dim=${client.dim} provider=${client.provider}`,
          `pending after batch: ${stillPending}`,
        ].join("\n");
      },
    },

    // ── Subtitle marketplace federation (Stage 4b) ───────────────
    {
      handler: "cinema:subs-federation",
      name: "Cinema Subs Federation",
      description: "For every watchlist title: fan-out to discovery providers (Nostr, archive.org), upsert announcements into the subtitle marketplace index. Also re-broadcasts our own subs that are >24h stale on relays.",
      cron: "*/30 * * * *",
      flow: "Leisure",
      run: async () => {
        const cinema = deps.service();
        const subs = deps.subs();
        const reg = deps.registry();
        if (!cinema || !subs || !reg) {
          return "Cinema federation skipped: cinema services not wired.";
        }

        // ── 1) Index refresh ───────────────────────────────────────
        // Limit to ~25 watchlist titles per tick so we don't hammer
        // relays. Skip when watchlist is empty.
        const watchlist = cinema.list({ watchlist: true, limit: 25 });
        if (watchlist.length === 0) {
          return "🎬 Cinema federation: watchlist empty — nothing to refresh.";
        }

        let totalSeen = 0;
        let providerErrors = 0;
        for (const t of watchlist) {
          try {
            const r = await reg.queryAll({ identifier: t.identifier, limit: 50 });
            for (const ann of r.items) subs.upsertIndex(ann);
            totalSeen += r.items.length;
            providerErrors += r.errors.length;
          } catch (err) {
            providerErrors++;
            log.warn(`cinema federation: ${t.identifier} query failed`, err);
          }
          // Be polite — small jitter between videos.
          await new Promise((r) => setTimeout(r, 300));
        }

        // ── 2) Re-broadcast stale local subs ────────────────────────
        // NIP-78 events on relays expire without traffic. Re-publish
        // anything we own that hasn't been pushed in 24h. Limit per tick
        // to keep relay rate-limiters happy.
        const staleSinceMs = 24 * 60 * 60 * 1000;
        const now = Date.now();
        let republished = 0;
        let republishFailed = 0;
        const REPUBLISH_LIMIT = 10;

        for (const t of watchlist) {
          if (republished >= REPUBLISH_LIMIT) break;
          const locals = subs.listLocalByVideo(t.identifier);
          for (const local of locals) {
            if (republished >= REPUBLISH_LIMIT) break;
            if (local.origin !== "local") continue;
            const lastPub = local.published_at ? new Date(local.published_at).getTime() : 0;
            if (now - lastPub < staleSinceMs) continue;
            try {
              const result = await reg.publishAll({
                identifier: local.identifier,
                srcLang: local.src_lang,
                tgtLang: local.tgt_lang,
                engine: local.engine,
                engineVersion: local.engine_version,
                magnet: local.magnet,
                webseedUrl: local.webseed_url,
                sha256: local.sha256,
                sizeBytes: local.size_bytes,
                content: `Re-broadcast for ${local.identifier} (${local.tgt_lang})`,
              });
              if (result.successes.length > 0) {
                subs.markPublished(local.id);
                republished++;
              } else {
                republishFailed++;
              }
            } catch {
              republishFailed++;
            }
          }
        }

        return [
          `🎬 Cinema federation · watchlist=${watchlist.length}`,
          `index: ${totalSeen} announcements seen · ${providerErrors} provider errors`,
          `republish: ${republished} pushed${republishFailed ? ` · ${republishFailed} failed` : ""}`,
        ].join("\n");
      },
    },

    // ── Auto-publish locally generated subs (Stage 5) ────────────
    // Watches data/subtitles/*.json sidecars produced by the torrents
    // transcribe + translate pipeline. For any sidecar whose upstream URL
    // points at archive.org and we DON'T already track it in cinema_subs,
    // insert a local row and (if DASHBOARD_PUBLIC_URL is set) broadcast via
    // the discovery registry. A cron handler (not an inline hook) keeps
    // torrents agnostic of cinema and stays idempotent across crashes.
    {
      handler: "cinema:auto-publish-subs",
      name: "Cinema Auto-Publish Subs",
      description: "Scans the data/subtitles/ cache for subs produced locally for archive.org videos and announces them via the discovery registry. Idempotent — only records new files. Set DASHBOARD_PUBLIC_URL so peers can fetch the bytes via webseed.",
      cron: "*/10 * * * *",
      flow: "Leisure",
      run: async () => {
        const cinema = deps.service();
        const subs = deps.subs();
        const reg = deps.registry();
        if (!cinema || !subs || !reg) {
          return "Cinema auto-publish skipped: cinema services not wired.";
        }

        const cacheDir = path.join(process.cwd(), "data", "subtitles");
        if (!existsSync(cacheDir)) {
          return "Cinema auto-publish: no data/subtitles/ yet — nothing to do.";
        }

        let entries: string[];
        try {
          entries = await readdir(cacheDir);
        } catch (err) {
          return `Cinema auto-publish: readdir failed — ${err instanceof Error ? err.message : err}`;
        }
        const sidecars = entries.filter((f) => f.endsWith(".json"));
        if (sidecars.length === 0) {
          return "Cinema auto-publish: no sidecars in cache.";
        }

        // Without a public URL, peers can't fetch the bytes. We still
        // record local rows; the federation agent can re-broadcast later
        // once DASHBOARD_PUBLIC_URL is set.
        const publicBase = (process.env.DASHBOARD_PUBLIC_URL ?? "").replace(/\/$/, "");

        let recorded = 0;
        let published = 0;
        let failed = 0;
        let skipped = 0;
        const PER_TICK_LIMIT = 12; // bound LMStudio relay traffic

        for (const fname of sidecars) {
          if (recorded >= PER_TICK_LIMIT) break;
          try {
            const raw = await readFile(path.join(cacheDir, fname), "utf8");
            const meta = JSON.parse(raw) as {
              key: string;
              kind: "transcribe" | "translation";
              url: string;
              src_lang: string;
              tgt_lang: string;
              engine?: string;
              model?: string;
              cue_count?: number;
              created_at?: number;
              federated?: { provider: string; signer: string };
            };

            // Skip subs we already know about: federated downloads carry
            // a `federated` block in their sidecar; we don't want to re-publish
            // somebody else's sub as our own.
            if (meta.federated) { skipped++; continue; }

            const identifier = archiveIdFromUrl(meta.url);
            if (!identifier) { skipped++; continue; }

            // Already tracked locally? Match by vtt_path (canonical key).
            const vttPath = path.join(cacheDir, `${meta.key}.vtt`);
            const existing = subs.listLocalByVideo(identifier);
            if (existing.some((l) => l.vtt_path === vttPath || l.sha256 === meta.key)) {
              skipped++;
              continue;
            }

            const local = subs.insertLocal({
              identifier,
              src_lang: meta.src_lang ?? "",
              tgt_lang: meta.tgt_lang,
              engine: meta.engine ?? meta.kind,
              engine_version: meta.model ?? "",
              origin: "local",
              vtt_path: vttPath,
              sha256: meta.key,
              size_bytes: 0, // file size — could stat() but not load-bearing
              webseed_url: publicBase ? `${publicBase}/api/torrents/subs/file?key=${meta.key}` : "",
              manifest: { auto_published_at: new Date().toISOString() },
            });
            recorded++;

            if (!publicBase) continue; // no broadcast possible

            try {
              const result = await reg.publishAll({
                identifier,
                srcLang: meta.src_lang ?? "",
                tgtLang: meta.tgt_lang,
                engine: meta.engine ?? meta.kind,
                engineVersion: meta.model ?? "",
                magnet: "",
                webseedUrl: local.webseed_url,
                sha256: "", // sidecar key is sha1, not sha256 — leave empty
                sizeBytes: 0,
                content: `${meta.kind} ${meta.src_lang || "?"}→${meta.tgt_lang} via ${meta.engine || "?"} (auto-published)`,
              });
              if (result.successes.length > 0) {
                subs.markPublished(local.id);
                published++;
              } else {
                failed++;
              }
            } catch {
              failed++;
            }
          } catch {
            // Malformed sidecar — skip silently. The legacy /subs/list
            // endpoint already tolerates these.
            skipped++;
          }
        }

        return [
          `🎬 Cinema auto-publish · sidecars=${sidecars.length}`,
          `recorded=${recorded}  published=${published}  failed=${failed}  skipped=${skipped}`,
          publicBase ? `webseed base: ${publicBase}` : "DASHBOARD_PUBLIC_URL not set — bytes not reachable, broadcast skipped",
        ].join("\n");
      },
    },

    // ── Community directory sync (Stage 7) ───────────────────────
    {
      handler: "cinema:directory-sync",
      name: "Cinema Directory Sync",
      description: "For every subscribed community directory: queries Nostr for the latest version (kind 30079) and applies it via the co-sign-validating upsert path. Idempotent and bounded.",
      cron: "*/30 * * * *",
      flow: "Leisure",
      run: async () => {
        const dirs = deps.directories();
        const provider = deps.directoriesProvider();
        if (!dirs || !provider) return "Cinema directory sync skipped: services not wired.";

        const subs = dirs.listSubscriptions();
        if (subs.length === 0) return "🎬 Cinema directory sync · no subscriptions";

        let pulled = 0, created = 0, updated = 0, rejected = 0, stale = 0, errors = 0;

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
              else if (r === "stale") stale++;
              else if (r.startsWith("rejected")) rejected++;
            }
            dirs.markSynced(sub.directory_id, sub.owner_pubkey);
            await new Promise((r) => setTimeout(r, 200));
          } catch (err) {
            errors++;
            log.warn(`cinema directory-sync: ${sub.directory_id} — ${err instanceof Error ? err.message : err}`);
          }
        }
        return [
          `🎬 Cinema directory sync · subs=${subs.length}`,
          `pulled=${pulled} created=${created} updated=${updated} stale=${stale} rejected=${rejected}${errors ? " errors=" + errors : ""}`,
        ].join("\n");
      },
    },
  ];
}
