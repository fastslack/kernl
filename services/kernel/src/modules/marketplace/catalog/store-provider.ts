/**
 * StoreProvider — the paid shelf, folded into the same catalog as everything else.
 *
 * The free kernel ships the *mechanism* to buy add-ons, never the paid code.
 * This provider is that mechanism on the browse side: it fetches the store
 * catalog (default https://issuer.lifekernl.com/store/catalog), synthesizes an
 * ExtensionManifest per item so the marketplace UI can render it like any other
 * card, and reports one of two pre-install statuses:
 *
 *   • "owned"    — the current license carries the item's `pro:<slug>` feature.
 *                  Installing is a plain authenticated download.
 *   • "for_sale" — it doesn't. The dashboard shows the price and a Buy button.
 *
 * Installation does NOT go through this provider's origin directory (there is
 * none) — CatalogRegistry routes store items to the license-authenticated
 * download in modules/store/client.ts.
 *
 * The catalog is cached in memory for a few minutes: browse() is called on
 * every keystroke of the dashboard's search box, and the store is a network hop.
 */

import { log } from "../../../core/logger.js";
import { fetchStoreCatalogFull, type StoreAllAccess, type StoreCatalogItem } from "../../store/client.js";
import type { ExtensionManifest } from "../../extensions/schema.js";
import type { CatalogFilter, CatalogItem, CatalogProvider } from "./types.js";

/** Provider name — also the value of `origin.provider` on every item it emits. */
export const STORE_PROVIDER_NAME = "store";

const CACHE_TTL_MS = 5 * 60 * 1000;

export interface StoreProviderOptions {
  /** Store base URL, e.g. https://issuer.lifekernl.com */
  storeUrl: string;
  /** Whether the local license carries a feature. Drives owned vs for_sale. */
  licenseHas: (feature: string) => boolean;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Override the cache window (tests pass 0 to disable). */
  cacheTtlMs?: number;
}

export class StoreProvider implements CatalogProvider {
  readonly name = STORE_PROVIDER_NAME;
  readonly label = "Kernl store";

  private cache: { at: number; items: StoreCatalogItem[]; allAccess: StoreAllAccess | null } | null = null;
  /** Set after a failed fetch so we don't hammer an unreachable store. */
  private lastError: { at: number; message: string } | null = null;

  constructor(private readonly opts: StoreProviderOptions) {}

  async list(filter?: CatalogFilter): Promise<CatalogItem[]> {
    const { items } = await this.load();
    return applyFilter(items.map((it) => this.toCatalogItem(it)), filter);
  }

  async get(id: string): Promise<CatalogItem | null> {
    const { items } = await this.load();
    const hit = items.find((i) => i.slug === id || storeItemId(i) === id);
    return hit ? this.toCatalogItem(hit) : null;
  }

  async refresh(): Promise<void> {
    this.cache = null;
    this.lastError = null;
    await this.load();
  }

  /** The All-Access upsell, for the dashboard's "unlock everything" affordance. */
  async allAccess(): Promise<StoreAllAccess | null> {
    return (await this.load()).allAccess;
  }

  /** Last fetch error, if the store is unreachable. Surfaced in the UI. */
  getLastError(): string | null {
    return this.lastError?.message ?? null;
  }

  /** The raw store row for a slug — the installer needs `feature` and `type`. */
  async storeItem(slug: string): Promise<StoreCatalogItem | null> {
    const { items } = await this.load();
    return items.find((i) => i.slug === slug) ?? null;
  }

  // ── Internals ───────────────────────────────────────────────────────

  private async load(): Promise<{ items: StoreCatalogItem[]; allAccess: StoreAllAccess | null }> {
    const ttl = this.opts.cacheTtlMs ?? CACHE_TTL_MS;
    const now = Date.now();
    if (this.cache && now - this.cache.at < ttl) {
      return { items: this.cache.items, allAccess: this.cache.allAccess };
    }
    // Back off for one TTL window after a failure — a kernel with no internet
    // shouldn't stall every browse() on a connect timeout.
    if (this.lastError && now - this.lastError.at < ttl) {
      return { items: this.cache?.items ?? [], allAccess: this.cache?.allAccess ?? null };
    }

    try {
      const catalog = await fetchStoreCatalogFull(this.opts.storeUrl, this.opts.fetchImpl ?? fetch);
      this.cache = { at: now, items: catalog.items, allAccess: catalog.allAccess };
      this.lastError = null;
      return { items: catalog.items, allAccess: catalog.allAccess };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = { at: now, message };
      log.warn(`StoreProvider: catalog fetch failed: ${message}`);
      // Serve the stale cache if we have one — a flaky network shouldn't make
      // paid items vanish from a page the user is looking at.
      return { items: this.cache?.items ?? [], allAccess: this.cache?.allAccess ?? null };
    }
  }

  private toCatalogItem(it: StoreCatalogItem): CatalogItem {
    const owned = this.opts.licenseHas(it.feature);
    const manifest: ExtensionManifest = {
      $schema: "kernl://extension/v1",
      id: storeItemId(it),
      slug: it.slug,
      name: it.name,
      version: it.version,
      type: (it.ext_type ?? "module") as ExtensionManifest["type"],
      description: it.description ?? `${it.name} — a paid Kernl extension.`,
      author: "Kernl",
      author_url: "https://lifekernl.com",
      license: "Commercial",
      icon: it.icon ?? "🔒",
      category: it.category ?? "utility",
      tags: ["pro", "store"],
      pricing: {
        amount_cents: it.price_cents ?? 0,
        currency: (it.currency ?? "USD").toUpperCase(),
        model: it.kind === "subscription" ? "subscription" : "one-time",
      },
    };

    return {
      id: manifest.id,
      slug: it.slug,
      origin: {
        provider: this.name,
        source: { type: "url", url: `${this.opts.storeUrl.replace(/\/+$/, "")}/store/download?slug=${encodeURIComponent(it.slug)}` },
      },
      manifest,
      status: owned ? "owned" : "for_sale",
      price_cents: it.price_cents ?? 0,
      currency: (it.currency ?? "USD").toUpperCase(),
      price_id: it.price_id ?? null,
      feature: it.feature,
      install_count: 0,
      avg_rating: 0,
      review_count: 0,
      featured: true, // paid items lead the shelf
      verified: true,
    };
  }
}

/**
 * Store items need a reverse-DNS id like every other manifest. `com.lifekernl.<slug>`
 * is stable and collision-free against the in-tree `com.mtwkernel.*` bundles.
 */
export function storeItemId(it: { slug: string }): string {
  return `com.lifekernl.${it.slug}`;
}

function applyFilter(items: CatalogItem[], filter?: CatalogFilter): CatalogItem[] {
  let out = items;
  if (filter?.type) out = out.filter((i) => i.manifest.type === filter.type);
  if (filter?.category) out = out.filter((i) => i.manifest.category === filter.category);
  if (filter?.query) {
    const q = filter.query.toLowerCase();
    out = out.filter((i) =>
      [i.slug, i.manifest.name, i.manifest.description, ...(i.manifest.tags ?? [])]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }
  if (filter?.limit) out = out.slice(0, filter.limit);
  return out;
}
