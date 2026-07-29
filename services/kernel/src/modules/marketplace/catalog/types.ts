/**
 * Catalog types — shared shape for "things you can install from the marketplace".
 *
 * A CatalogItem is the marketplace-facing projection of an ExtensionManifest
 * + status (available / installed / active / disabled). Providers hand back
 * CatalogItems; the marketplace UI renders them; install/uninstall delegates
 * to ExtensionService which writes a row in `installed_extensions`.
 *
 * Why not reuse ExtensionManifest directly? Two reasons:
 *   1. Items from remote providers may carry additional fields (price, install
 *      counts, ratings) that don't belong in the on-disk manifest.
 *   2. The provider needs to advertise *where* the bundle lives without forcing
 *      the consumer to know the provider's transport (file path, URL, git ref).
 */
import type { ExtensionManifest } from "../../extensions/schema.js";
import type { ExtensionSource } from "../../extensions/types.js";

export type CatalogItemStatus =
  | "available"   // present in catalog, not installed
  | "installed"   // installed but disabled
  | "active"      // installed and active
  | "disabled"    // installed and explicitly disabled
  | "error";      // installed but in error state

/**
 * A normalized item in the catalog. The manifest is the source of truth for
 * type/permissions/dependencies; the rest are provider/installation hints.
 */
export interface CatalogItem {
  /** Stable id across the provider — usually the manifest.id. */
  id: string;
  /** URL-safe slug (manifest.slug). */
  slug: string;
  /** Where this item came from (which provider, and how to fetch it). */
  origin: CatalogOrigin;
  /** The full ExtensionManifest, normalized from whatever native format the source uses. */
  manifest: ExtensionManifest;
  /** Current install status, computed by the registry by joining provider items with `installed_extensions`. */
  status: CatalogItemStatus;
  /** When status='installed/active/disabled/error', the row id in `installed_extensions`. */
  installed_id?: string;
  /** Pricing hint surfaced from manifest.pricing or remote metadata. */
  price_cents: number;
  currency: string;
  /** Aggregated stats — providers may leave these at 0. */
  install_count: number;
  avg_rating: number;
  review_count: number;
  /** Promotion flags from the catalog (provider-supplied). */
  featured: boolean;
  verified: boolean;
}

/**
 * Where a catalog item came from. The provider is the namespace ("bundled",
 * "git:org/repo", "remote:purma"); the source is what gets persisted into the
 * installed_extensions.source_json column.
 */
export interface CatalogOrigin {
  provider: string;
  source: ExtensionSource;
  /**
   * For providers backed by a directory on disk (the bundled provider),
   * an absolute path to the bundle root. Lets the installer skip the
   * tarball pack/unpack dance.
   */
  directory?: string;
}

/**
 * Filters accepted by `CatalogProvider.list()`. All optional; an empty filter
 * returns everything the provider knows about.
 */
export interface CatalogFilter {
  type?: ExtensionManifest["type"];
  category?: string;
  query?: string;
  /** Limit applied per-provider; the registry concatenates across providers. */
  limit?: number;
}

/**
 * One source of installable artifacts. Implementations:
 *   - BundledProvider: scans assets/bundles, assets/skills, assets/plugins, assets/extensions
 *   - RemoteProvider:  fetches a JSON catalog from an HTTP(S) endpoint (TODO)
 *   - GitProvider:     resolves a git URL → manifest preview (TODO)
 */
export interface CatalogProvider {
  /** Stable identifier (e.g. "bundled", "remote:purma.community"). */
  readonly name: string;
  /** Human-readable label for the dashboard. */
  readonly label: string;
  /** Return all items this provider can offer that match the filter. */
  list(filter?: CatalogFilter): Promise<CatalogItem[]>;
  /** Get a single item by id; null if the provider doesn't know about it. */
  get(id: string): Promise<CatalogItem | null>;
  /**
   * Optional refresh hook. Default behavior is to re-scan on every list().
   * Remote providers should implement this to avoid hammering the network.
   */
  refresh?(): Promise<void>;
}
