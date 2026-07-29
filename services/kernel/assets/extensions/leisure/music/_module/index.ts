import type {
  DashboardDescriptor,
  ExtensibleModule,
  ModuleContext,
} from "../../../../../src/core/types.js";
import { runMigrations } from "../../../../../src/core/db/migrations.js";
import { log } from "../../../../../src/core/logger.js";
import { musicMigrations } from "./migrations/001_music.js";
import { MusicService } from "./service.js";
import { registerMusicRoutes } from "./api-routes.js";
import { archiveCatalogMigrations, ingestNextChunk } from "../../_lib/archive-catalog/index.js";

export interface MusicModule extends ExtensibleModule {
  getService(): MusicService;
}

/**
 * Background ingest cadence. Tuning notes:
 *   - 60s between passes is well below archive.org's rate limits and
 *     paces a steady ~12k titles/hr (200 rows/page).
 *   - With ~3.6M music items across our collections this means a full
 *     first pass takes ~12 days. That's fine — tags become useful
 *     after the first 5-10k titles (~1h), and improve continuously.
 */
const INGEST_TICK_MS = 60_000;
/**
 * Music collections to ingest. Picked for relevance + diversity:
 *   - 78rpm, georgeblood: vinyl shellac (~210k items, jazz + classical + popular)
 *   - lps: vinyl LPs (long-play)
 *   - netlabels: free/CC netlabels (electronic, ambient, experimental)
 *   - audio_music: general user-uploaded music
 *   - etree: Live Music Archive (jam bands, taper culture)
 *
 * Deliberately omitted:
 *   - opensource_audio: dominated by Quran recordings + sermons, not music
 *   - librivoxaudio:    audiobooks, not music — pollutes the genre tag cloud
 *                       with "chapter X" / "librivox" / author names
 *   - oldtimeradio:     radio shows, not music
 */
const MUSIC_INGEST_COLLECTIONS = [
  "78rpm", "georgeblood", "netlabels", "audio_music", "lps", "etree",
];
/** How many ingest passes between tag rebuilds. Tag rebuild is cheap
 *  (~1-2s on 200k rows) but we don't need it after every page. */
const REBUILD_TAGS_EVERY_N_PASSES = 5;

export function createMusicModule(): MusicModule {
  let service: MusicService | null = null;
  let tickHandle: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;
  let passesSinceRebuild = 0;

  return {
    name: "music",

    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "music", musicMigrations);
      // Catalog tables (music_titles, music_titles_fts, music_tags,
      // music_ingest_runs) — same schema cinema uses, parameterized by
      // prefix. Idempotent migrations, safe to re-run.
      runMigrations(ctx.sqlite, "music_catalog", archiveCatalogMigrations("music"));
      service = new MusicService(ctx.sqlite);

      // Kick off the background ingester. The very first tick fires
      // ~60s after boot — long enough that we don't fight kernel boot
      // for CPU/network, short enough that fresh installs see tags
      // populate within the first minute the page is open.
      const svc = service;
      tickHandle = setInterval(() => {
        if (inFlight) return;
        inFlight = true;
        ingestNextChunk(svc.catalog, MUSIC_INGEST_COLLECTIONS, { mediatype: "audio" }, "music-ingester")
          .then((result) => {
            if (!result) return;
            log.info(
              `music-ingester: ${result.collection} +${result.inserted} new, ~${result.updated} refreshed`
              + ` (${result.fetched} fetched in ${result.durationMs}ms${result.finished ? ", finished" : ""})`,
            );
            passesSinceRebuild++;
            if (passesSinceRebuild >= REBUILD_TAGS_EVERY_N_PASSES) {
              passesSinceRebuild = 0;
              const r = svc.catalog.rebuildTags();
              log.info(`music-ingester: tags rebuilt — ${r.tags} unique from ${r.titlesScanned} titles (${r.durationMs}ms)`);
            }
          })
          .catch((e) => log.warn(`music-ingester: pass failed — ${e instanceof Error ? e.message : e}`))
          .finally(() => { inFlight = false; });
      }, INGEST_TICK_MS);
    },

    getTools() { return []; },

    async shutdown() {
      if (tickHandle) clearInterval(tickHandle);
      tickHandle = null;
    },

    getService() {
      if (!service) throw new Error("MusicService not initialized");
      return service;
    },

    getDashboardDescriptor(): DashboardDescriptor | null {
      if (!service) return null;
      const svc = service;
      return {
        registerRoutes: (server) => registerMusicRoutes(server, svc),
      };
    },
  };
}
