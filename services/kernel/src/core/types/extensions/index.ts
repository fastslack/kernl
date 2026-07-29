/**
 * Type re-exports for kernel modules that live as extensions
 * (assets/extensions/<slug>/). Centralizing these here lets `src/index.ts`
 * import a single grouped barrel instead of poking each module's source
 * tree directly.
 *
 * While the source modules still live under `src/modules/<slug>/`, we
 * re-export their concrete types so dashboard/api-routes/rpc-actions
 * consumers (which still import from the source paths) keep matching
 * strict signatures. Once a module's source moves into
 * `assets/extensions/<slug>/_module/` (Tier 5), the re-export here can
 * be flipped to a narrow stand-in interface and the source deleted.
 */

// ── Paid modules (provided separately): opaque stand-in contracts ──
// These modules do not ship in the public core. The kernel loads them
// dynamically at runtime and treats their services as opaque handles — it only
// declares the factory methods it actually calls. Keep in sync with the
// real module exports when installed.
export interface MeshServiceHandle extends MeshServiceLike {
  pairPeer(opts: unknown): Promise<{ record: { peer_id: string; endpoint: string; display_name: string; status: string } }>;
  trustPeer(peerId: string): boolean;
  revokePeer(peerId: string): boolean;
}
export interface MeshModule extends KernelModule {
  getService(): MeshServiceHandle | null;
  startMdns(opts: unknown): void;
}
export interface MeshDashboardModule extends KernelModule {
  bind(args: { meshService: MeshServiceHandle | null; selfFingerprint: string | null }): void;
}
export interface GraphIntelModule extends KernelModule { getAnalyticsService(): AnalyticsService | null; }
export type AnalyticsService = any;
export type { RemindersModule } from "../../../../assets/extensions/productivity/reminders/_module/index.js";
export type { ShoppingService } from "../../../../assets/extensions/home/shopping/_module/service.js";
export type { CommsModule } from "../../../../assets/extensions/people/comms/_module/index.js";
export type { TasksModule } from "../../../../assets/extensions/productivity/tasks/_module/index.js";
export type { CrmModule } from "../../../../assets/extensions/people/crm/_module/index.js";
export type { LightsModule } from "../../../../assets/extensions/house/lights/_module/index.js";
export type { SandboxAgentsModule } from "../../../../assets/extensions/agents/sandbox-agents/_module/index.js";
export type { ApiRegistryModule } from "../../../../assets/extensions/ai/api-registry/_module/index.js";
export interface TradingModule extends KernelModule {
  getService(): any;
  getMarketGraph(): any;
  getFeeder(): any;
  getMonitor(): any;
}
export interface FederationModule extends KernelModule { getSyncEngine(): any; }
// Social is a PAID module (provided separately) — opaque stand-in
// contract, same pattern as Mesh/Trading/Torrents. Only the members the
// kernel actually calls (bootstrap wires cinema's Nostr identity from it);
// the real module satisfies it structurally.
export interface SocialModule extends KernelModule {
  getService(): unknown;
  getNostrBridge(): { getRelayPool(): NostrRelayPool } | null;
  deriveNostrIdentity(): NostrIdentity | null;
}
// Torrents is a PAID module (provided separately) — opaque stand-in
// contract, same pattern as Mesh/Trading/Federation above. Only the members
// the kernel actually calls; the real module satisfies it structurally.
export interface TorrentsModule extends KernelModule {
  getService(): any;
  getRustBackend(): any;
  getArchiveHelpers(): {
    searchArchive: (q: Record<string, unknown>) => Promise<unknown[]>;
    archiveCacheKey: (q: Record<string, unknown>) => string;
  };
  setRustBridge(bridge: unknown, mode?: "auto" | "rust" | "legacy"): Promise<void>;
}
// Cameras is a PAID module (provided separately) — opaque stand-in
// contract, same pattern as Mesh/Trading/Torrents/Social above. Only the
// member the kernel actually calls: bootstrap's http stage attaches the
// camera WebSocket stream hub to the live HTTP server, and the shutdown
// stage calls `.shutdown()` on the returned handle. The real module
// satisfies it structurally.
export interface CamerasModule extends KernelModule {
  attachStreamHub(httpServer: import("node:http").Server): { shutdown(): void } | null;
}
export type { CinemaModule } from "../../../../assets/extensions/leisure/cinema/_module/index.js";
export type { BooksModule } from "../../../../assets/extensions/leisure/books/_module/index.js";
export type { MusicModule } from "../../../../assets/extensions/leisure/music/_module/index.js";
export type { TwitterModule } from "../../../../assets/extensions/crm/twitter/_module/index.js";
export type { GoogleSyncModule } from "../../../../assets/extensions/integration/google-sync/_module/index.js";
export type { LifeModule } from "../../../../assets/extensions/home/life/_module/index.js";
export type { LifeService } from "../../../../assets/extensions/home/life/_module/life-service.js";
export type { NewsModule } from "../../../../assets/extensions/home/news/_module/index.js";
export type { NewsService } from "../../../../assets/extensions/home/news/_module/news-service.js";

import type { KernelModule } from "../../types.js";
import type { MeshServiceLike } from "../../extension-seams.js";
import type { NostrIdentity } from "../../nostr/nostr-identity.js";
import type { NostrRelayPool } from "../../nostr/nostr-relay-pool.js";
import type { ShoppingService } from "../../../../assets/extensions/home/shopping/_module/service.js";

export type ShoppingModule = KernelModule & { getService(): ShoppingService | null };
