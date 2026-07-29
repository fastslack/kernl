/**
 * Cinema module — local catalog of archive.org movie titles + semantic
 * search over Spanish text via the kernel's embeddings client.
 *
 * Owns:
 *   - cinema_titles + cinema_ingest_runs SQLite tables
 *   - the scrape-API ingester
 *   - the embeddings worker that writes (:CinemaTitle) nodes to Neo4j
 *   - HTTP API: /api/cinema/titles, /search, /title/:id, /watchlist,
 *     /watched, /ingest/{status,run}
 *
 * Does NOT own (lives elsewhere on purpose):
 *   - Torrent transfer / playback / transcoding → torrents module
 *   - Discovery layer for shared subtitles (Nostr + archive.org)
 *     → cinema/discovery/ in stage 4
 *
 * Boot order: index.ts initialises the module before the embeddings
 * client exists. We expose `setSearchInfra(neo4j, client)` so index.ts
 * can wire those in once they're built; the API routes resolve them
 * lazily on each request via getter closures.
 */

import type {
  DashboardDescriptor,
  ExtensibleModule,
  ModuleContext,
  ToolDefinition,
} from "../../../../../src/core/types.js";
import type { GraphDriver } from "../../../../../src/core/db-drivers/graph-driver.js";
import type { EmbeddingsClient } from "../../../../../src/core/embeddings/index.js";
import { NostrIdentity } from "../../../../../src/core/nostr/nostr-identity.js";
import type { NostrRelayPool } from "../../../../../src/core/nostr/nostr-relay-pool.js";
import { runMigrations } from "../../../../../src/core/db/migrations.js";
import { cinemaMigrations } from "./migrations/001_cinema_titles.js";
import { CinemaService } from "./service.js";
import { CinemaSubsService } from "./subs-service.js";
import { CinemaDirectoriesService } from "./directories-service.js";
import { DiscoveryRegistry } from "./discovery/registry.js";
import { NostrSubsProvider } from "./discovery/nostr-provider.js";
import { ArchiveSubsProvider } from "./discovery/archive-provider.js";
import { NostrDirectoriesProvider } from "./discovery/nostr-directories-provider.js";
import { registerCinemaRoutes } from "./api-routes.js";
import { registerCinemaMediaRoutes } from "./media-routes.js";
import { cinemaTools } from "./tools.js";
import { EmbedRunner } from "./embed-runner.js";
import { TranslateRunner } from "./translate-runner.js";
import { ingestNextChunk } from "./ingester.js";
import { cinemaAgentDrivers } from "./agent-drivers.js";
import type { AgentDriver } from "../../../../../src/core/types.js";
import { log } from "../../../../../src/core/logger.js";

export interface CinemaModule extends ExtensibleModule {
  getService(): CinemaService | null;
  getSubsService(): CinemaSubsService | null;
  getDirectoriesService(): CinemaDirectoriesService | null;
  getDirectoriesProvider(): NostrDirectoriesProvider | null;
  getDiscoveryRegistry(): DiscoveryRegistry | null;
  getEmbedRunner(): EmbedRunner | null;
  getTranslateRunner(): TranslateRunner | null;
  /** Wire the semantic-search dependencies. Called from index.ts AFTER
   *  the embeddings client is created (which itself depends on config
   *  loaded earlier in bootstrap). Idempotent — safe to call again on
   *  reload. */
  setSearchInfra(graph: GraphDriver | null, embeddings: EmbeddingsClient | null): void;
  /** Wire the Nostr identity for subtitle publishing. Pass null to
   *  keep the Nostr provider in read-only mode (queries still work,
   *  publish() throws NotPublishable). Identity is typically derived
   *  from social/index.ts via NostrIdentity.fromEd25519Seed(seed).
   *  Called once after the social module initializes its identity. */
  setNostrIdentity(identity: NostrIdentity | null, sharedPool?: NostrRelayPool | null): void;
  /**
   * If the local catalog is empty, kick off a background ingest pass so
   * the /cinema page isn't empty on a fresh user's first load. Idempotent:
   * does nothing when the catalog already contains titles. Called by the
   * kernel after the embeddings client is wired (we don't need embeddings
   * for the SQL part, but the EmbedRunner picks up newly ingested titles
   * automatically on its next tick).
   */
  maybeFirstRunIngest(): void;
}

export function createCinemaModule(): CinemaModule {
  let tools: ToolDefinition[] = [];
  let service: CinemaService | null = null;
  let subsService: CinemaSubsService | null = null;
  let registry: DiscoveryRegistry | null = null;
  let graphRef: GraphDriver | null = null;
  let embeddingsRef: EmbeddingsClient | null = null;
  let embedRunner: EmbedRunner | null = null;
  let translateRunner: TranslateRunner | null = null;
  let directoriesService: CinemaDirectoriesService | null = null;
  let directoriesProvider: NostrDirectoriesProvider | null = null;
  /** Local kernel's Nostr identity. Held here so we can reuse it for
   *  directory publishing — same npub as subs, so trust unifies. */
  let localIdentity: NostrIdentity | null = null;
  /** Captured at initialize() — the agent drivers need config + getModule. */
  let ctxRef: ModuleContext | null = null;

  return {
    name: "cinema",

    async initialize(ctx: ModuleContext) {
      ctxRef = ctx;
      runMigrations(ctx.sqlite, "cinema", cinemaMigrations);
      service = new CinemaService(ctx.sqlite);
      subsService = new CinemaSubsService(ctx.sqlite);
      // Discovery registry — providers get registered here. Nostr starts
      // in read-only mode (no identity yet); setNostrIdentity flips the
      // canPublish bit later. archive.org is read-only by design (write
      // mode requires S3 creds — pending stage 5b).
      registry = new DiscoveryRegistry();
      registry.register(new NostrSubsProvider(null));
      registry.register(new ArchiveSubsProvider());
      // EmbedRunner — singleton per kernel; the API endpoints (start /
      // stop / status) drive it. Lazy-resolves embedder + graph at run
      // time so it picks up post-bootstrap wiring.
      embedRunner = new EmbedRunner(service, () => embeddingsRef, () => graphRef);
      // TranslateRunner — fills cinema_titles.description_es via the
      // kernel-wide llm() chain. No graph/embedder dependency; writes ES
      // text to SQLite and clears each row's embed bookkeeping so the
      // EmbedRunner re-processes against the Spanish profile.
      translateRunner = new TranslateRunner(service);
      // Community directories — local CRUD now, Nostr publish/discover
      // wires up once setNostrIdentity lands.
      directoriesService = new CinemaDirectoriesService(ctx.sqlite);
      directoriesProvider = new NostrDirectoriesProvider(null);
      // Tools wire to the same lazy refs the API routes use, so they
      // pick up neo4j + embeddings once those land post-bootstrap.
      tools = cinemaTools({
        service,
        subs: subsService,
        graph: () => graphRef,
        embedder: () => embeddingsRef,
        registry: () => registry,
      });
    },

    setSearchInfra(graph, embeddings) {
      graphRef = graph;
      embeddingsRef = embeddings;
      // Auto-start the embed runner if there's work pending and the
      // infra is ready. Without this the runner sits idle after every
      // boot until a human (or the UI) hits POST /api/cinema/embed/start
      // — fine for first-run UX, painful when the catalog is partway
      // through a 5h fill and the container restarts for unrelated
      // reasons (extension hot-reload, host reboot, OOM).
      //
      // Guarded so we only auto-resume when the run got interrupted,
      // never on a fresh install (countAll === 0 will be handled by
      // maybeFirstRunIngest which seeds the catalog first).
      if (embedRunner && embeddings && graph?.capabilities.cypher) {
        try {
          const total = service?.countAll() ?? 0;
          const pending = service?.pendingEmbeddingIds(embeddings.model, embeddings.dim, 1)
            .length ?? 0;
          if (total > 0 && pending > 0) {
            log.info(`cinema: auto-resuming embed runner (catalog has pending rows)`);
            embedRunner.start({ batchSize: 128 });
          }
        } catch (err) {
          log.warn("cinema: embed runner auto-resume check failed", err);
        }
      }
    },

    maybeFirstRunIngest() {
      const svc = service;
      if (!svc) return;
      try {
        const totalTitles = svc.countAll();
        if (totalTitles > 0) return;
        log.info("cinema: catalog empty — kicking off first-run ingest in background");
        ingestNextChunk(svc)
          .then((r) => log.info(`cinema: first-run ingest complete (${r?.inserted ?? 0} new titles, ${r?.updated ?? 0} updated)`))
          .catch((e) => log.warn(`cinema: first-run ingest failed (will retry next agent tick): ${e}`));
      } catch (err) {
        log.warn("cinema: first-run seed check failed", err);
      }
    },

    setNostrIdentity(identity, sharedPool) {
      localIdentity = identity;
      if (!registry) return;
      // Replace the read-only Nostr provider with a publish-capable one.
      // Re-register clobbers the old entry by id ('nostr'). When a pool
      // is shared (typically the social bridge's), reuse it instead of
      // opening a fresh fan of relay sockets — kernel-wide we go from
      // ~12 connections to 5.
      const opts = sharedPool ? { sharedPool } : {};
      registry.register(new NostrSubsProvider(identity, opts));
      directoriesProvider = new NostrDirectoriesProvider(identity, opts);
    },

    getDirectoriesService() {
      return directoriesService;
    },

    getDirectoriesProvider() {
      return directoriesProvider;
    },

    getSubsService() {
      return subsService;
    },

    getDiscoveryRegistry() {
      return registry;
    },

    getEmbedRunner() {
      return embedRunner;
    },

    getTranslateRunner() {
      return translateRunner;
    },

    getTools() {
      return tools;
    },

    getService() {
      return service;
    },

    /**
     * Agent handler factories — consumed by `createBuiltinHandlers()` so the
     * builtin-handlers file no longer dynamic-imports cinema internals.
     */
    getAgentHandlers(): Record<string, () => Promise<unknown>> {
      return {
        "cinema:ingester": () => import("./ingester.js"),
        "cinema:embeddings": () => import("./embeddings.js"),
        "cinema:rss-watcher": () => import("./rss-watcher.js"),
      };
    },

    /**
     * Scheduled agent drivers owned by this extension (cache warmer,
     * catalog ingester, RSS watcher, embeddings worker, subs federation,
     * auto-publish, directory sync). Collected by the kernel's
     * ModuleRegistry.collectAgentDrivers() — the kernel never names cinema.
     * All deps are live getters because graph/embeddings/providers are
     * rebound post-init (setSearchInfra / setNostrIdentity).
     */
    getAgentDrivers(): AgentDriver[] {
      return cinemaAgentDrivers({
        service: () => service,
        subs: () => subsService,
        registry: () => registry,
        directories: () => directoriesService,
        directoriesProvider: () => directoriesProvider,
        embedder: () => embeddingsRef,
        graph: () => graphRef,
        ctx: () => ctxRef,
      });
    },

    getDashboardDescriptor(): DashboardDescriptor {
      const svc = service;
      const subs = subsService;
      // Lazy getters — neo4j + embeddings + registry providers are
      // mutable post-init (rebound by setSearchInfra / setNostrIdentity),
      // so the routes must look them up on each request rather than
      // capturing the value at registration time.
      const getGraph = () => graphRef;
      const getEmbedder = () => embeddingsRef;
      const getRegistry = () => registry;
      const getEmbedRunner = () => embedRunner;
      const getTranslateRunner = () => translateRunner;
      const getDirectories = () => directoriesService;
      const getDirectoriesProvider = () => directoriesProvider;
      const getLocalIdentity = () => localIdentity;
      return {
        // No nav entry yet — /cinema is already registered from the
        // dashboard module's static routes. Stage 3 swaps the data
        // source under the existing /cinema page; stage 5 promotes it
        // to a self-registered nav item with channel + ws-refresh.
        registerRoutes: (server) => {
          if (svc && subs) {
            registerCinemaRoutes(
              server, svc, subs,
              getGraph, getEmbedder, getRegistry, getEmbedRunner,
              getDirectories, getDirectoriesProvider, getLocalIdentity,
              getTranslateRunner,
            );
          }
          // Media-serving layer (archive.org proxy/transcode/probe + subtitle
          // pipeline). Standalone — no service deps, so register unconditionally
          // so the cinema player works even before the graph/embedder wire up.
          registerCinemaMediaRoutes(server);
        },
      };
    },

    async shutdown() {
      // Pure SQLite + Neo4j read-write; nothing to flush at module level.
    },
  };
}
