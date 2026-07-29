import type { SqliteDb } from "../../core/db/sqlite.js";
import type { EventBus } from "../../core/event-bus.js";
import { newId, isoNow } from "../../core/helpers.js";
import { log } from "../../core/logger.js";
import type { CatalogRegistry } from "./catalog/registry.js";
import type { CatalogFilter, CatalogItem } from "./catalog/types.js";
import type { CatalogReposService } from "./catalog-repos-service.js";
import type { InstalledExtension } from "../extensions/types.js";
import type { Identity } from "../../core/attestation.js";
import type {
  MarketplaceItem,
  MarketplaceReview,
  MarketplacePurchase,
  ThemeRow,
  ItemType,
  ItemStatus,
} from "./types.js";

export class MarketplaceService {
  private catalog: CatalogRegistry | null = null;
  private identity: Identity | null = null;

  constructor(
    private db: SqliteDb,
    private events: EventBus,
  ) {}

  /** Set after construction — the catalog registry is built once the extensions
   *  service is online (later in bootstrap). */
  setCatalogRegistry(registry: CatalogRegistry): void {
    this.catalog = registry;
  }

  getCatalogRegistry(): CatalogRegistry | null {
    return this.catalog;
  }

  /** Late-bind the kernel attestation identity so the watermark endpoint can
   *  sign download receipts. */
  setIdentity(identity: Identity | null): void {
    this.identity = identity;
  }

  getIdentity(): Identity | null {
    return this.identity;
  }

  /** Expose the underlying SQLite handle for collaborators that need to read /
   *  write marketplace tables (e.g. CatalogReposService). */
  getDb(): SqliteDb {
    return this.db;
  }

  // ── Subscribed catalog repos (path C) ──────────────────────────────

  private reposService: CatalogReposService | null = null;

  setReposService(svc: CatalogReposService | null): void {
    this.reposService = svc;
  }

  getReposService(): CatalogReposService | null {
    return this.reposService;
  }

  // ── Catalog (unified marketplace surface) ──────────────────────────

  async browseCatalog(filter?: CatalogFilter): Promise<CatalogItem[]> {
    if (!this.catalog) return [];
    return this.catalog.browse(filter);
  }

  async getCatalogItem(idOrSlug: string): Promise<CatalogItem | null> {
    if (!this.catalog) return null;
    return this.catalog.getItem(idOrSlug);
  }

  async installFromCatalog(idOrSlug: string): Promise<InstalledExtension> {
    if (!this.catalog) throw new Error("Catalog registry not initialized");
    const row = await this.catalog.install(idOrSlug);
    this.events.emit("data.changed", { module: "marketplace", action: "catalog_installed" });
    return row;
  }

  async uninstallFromCatalog(idOrSlug: string, opts?: { force?: boolean }): Promise<void> {
    if (!this.catalog) throw new Error("Catalog registry not initialized");
    await this.catalog.uninstall(idOrSlug, opts);
    this.events.emit("data.changed", { module: "marketplace", action: "catalog_uninstalled" });
  }

  listCatalogProviders(): Array<{ name: string; label: string }> {
    return this.catalog?.listProviders() ?? [];
  }

  // ── Item CRUD ──────────────────────────────────────────

  createItem(input: {
    type: ItemType;
    slug: string;
    name: string;
    description?: string;
    long_description?: string;
    version?: string;
    author?: string;
    author_url?: string;
    icon?: string;
    category?: string;
    tags?: string[];
    license?: string;
    price_cents?: number;
    currency?: string;
    source_type?: "bundled" | "local" | "import" | "community";
    source_ref?: string;
    package_data?: Record<string, unknown>;
    min_kernel_version?: string;
    dependencies?: string[];
    featured?: boolean;
    verified?: boolean;
  }): MarketplaceItem {
    const now = isoNow();
    const id = newId();

    this.db.prepare(
      `INSERT INTO marketplace_items (id, type, slug, name, description, long_description,
       version, author, author_url, icon, category, tags, license, price_cents, currency,
       source_type, source_ref, package_data, min_kernel_version, dependencies,
       featured, verified, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, input.type, input.slug, input.name,
      input.description ?? "", input.long_description ?? "",
      input.version ?? "1.0.0", input.author ?? "Kernl",
      input.author_url ?? "", input.icon ?? "",
      input.category ?? "utility", JSON.stringify(input.tags ?? []),
      input.license ?? "MIT", input.price_cents ?? 0,
      input.currency ?? "EUR", input.source_type ?? "local",
      input.source_ref ?? "", JSON.stringify(input.package_data ?? {}),
      input.min_kernel_version ?? "", JSON.stringify(input.dependencies ?? []),
      input.featured ? 1 : 0, input.verified ? 1 : 0,
      now, now,
    );

    this.events.emit("data.changed", { module: "marketplace", action: "item_created" });
    return this.getItem(id)!;
  }

  getItem(id: string): MarketplaceItem | undefined {
    return this.db
      .prepare("SELECT * FROM marketplace_items WHERE id = ?")
      .get(id) as MarketplaceItem | undefined;
  }

  getItemBySlug(slug: string): MarketplaceItem | undefined {
    return this.db
      .prepare("SELECT * FROM marketplace_items WHERE slug = ?")
      .get(slug) as MarketplaceItem | undefined;
  }

  listItems(filters?: {
    type?: ItemType;
    category?: string;
    status?: ItemStatus;
    query?: string;
    featured?: boolean;
    sort?: "popular" | "rating" | "newest" | "name";
    limit?: number;
  }): MarketplaceItem[] {
    let sql = "SELECT * FROM marketplace_items WHERE 1=1";
    const params: unknown[] = [];

    if (filters?.type) {
      sql += " AND type = ?";
      params.push(filters.type);
    }
    if (filters?.category) {
      sql += " AND category = ?";
      params.push(filters.category);
    }
    if (filters?.status) {
      sql += " AND status = ?";
      params.push(filters.status);
    }
    if (filters?.featured) {
      sql += " AND featured = 1";
    }
    if (filters?.query) {
      sql += " AND (name LIKE ? OR description LIKE ? OR tags LIKE ?)";
      const q = `%${filters.query}%`;
      params.push(q, q, q);
    }

    switch (filters?.sort) {
      case "popular":
        sql += " ORDER BY install_count DESC";
        break;
      case "rating":
        sql += " ORDER BY avg_rating DESC, review_count DESC";
        break;
      case "name":
        sql += " ORDER BY name ASC";
        break;
      default:
        sql += " ORDER BY featured DESC, created_at DESC";
    }

    if (filters?.limit) {
      sql += " LIMIT ?";
      params.push(filters.limit);
    }

    return this.db.prepare(sql).all(...params) as MarketplaceItem[];
  }

  searchItems(query: string, limit = 20): MarketplaceItem[] {
    return this.listItems({ query, limit });
  }

  updateItem(id: string, updates: {
    name?: string;
    description?: string;
    long_description?: string;
    version?: string;
    author?: string;
    author_url?: string;
    icon?: string;
    category?: string;
    tags?: string[];
    license?: string;
    price_cents?: number;
    featured?: boolean;
    verified?: boolean;
    package_data?: Record<string, unknown>;
  }): MarketplaceItem | undefined {
    const item = this.getItem(id);
    if (!item) return undefined;

    const sets: string[] = [];
    const params: unknown[] = [];

    if (updates.name !== undefined) { sets.push("name = ?"); params.push(updates.name); }
    if (updates.description !== undefined) { sets.push("description = ?"); params.push(updates.description); }
    if (updates.long_description !== undefined) { sets.push("long_description = ?"); params.push(updates.long_description); }
    if (updates.version !== undefined) { sets.push("version = ?"); params.push(updates.version); }
    if (updates.author !== undefined) { sets.push("author = ?"); params.push(updates.author); }
    if (updates.author_url !== undefined) { sets.push("author_url = ?"); params.push(updates.author_url); }
    if (updates.icon !== undefined) { sets.push("icon = ?"); params.push(updates.icon); }
    if (updates.category !== undefined) { sets.push("category = ?"); params.push(updates.category); }
    if (updates.tags !== undefined) { sets.push("tags = ?"); params.push(JSON.stringify(updates.tags)); }
    if (updates.license !== undefined) { sets.push("license = ?"); params.push(updates.license); }
    if (updates.price_cents !== undefined) { sets.push("price_cents = ?"); params.push(updates.price_cents); }
    if (updates.featured !== undefined) { sets.push("featured = ?"); params.push(updates.featured ? 1 : 0); }
    if (updates.verified !== undefined) { sets.push("verified = ?"); params.push(updates.verified ? 1 : 0); }
    if (updates.package_data !== undefined) { sets.push("package_data = ?"); params.push(JSON.stringify(updates.package_data)); }

    if (sets.length === 0) return item;

    sets.push("updated_at = ?");
    params.push(isoNow());
    params.push(id);

    this.db.prepare(`UPDATE marketplace_items SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    this.events.emit("data.changed", { module: "marketplace", action: "item_updated" });
    return this.getItem(id);
  }

  deleteItem(id: string): boolean {
    const item = this.getItem(id);
    if (!item) return false;
    this.db.prepare("DELETE FROM marketplace_items WHERE id = ?").run(id);
    this.events.emit("data.changed", { module: "marketplace", action: "item_deleted" });
    return true;
  }

  // ── Install / Uninstall / Enable / Disable ─────────────

  installItem(id: string): MarketplaceItem | undefined {
    const item = this.getItem(id);
    if (!item) return undefined;
    if (item.status === "active" || item.status === "installed") return item;

    const now = isoNow();
    this.db.prepare(
      `UPDATE marketplace_items SET status = 'installed', installed_at = ?,
       installed_version = version, install_count = install_count + 1, updated_at = ?
       WHERE id = ?`,
    ).run(now, now, id);

    this.events.emit("data.changed", { module: "marketplace", action: "item_installed" });
    return this.getItem(id);
  }

  uninstallItem(id: string): MarketplaceItem | undefined {
    const item = this.getItem(id);
    if (!item) return undefined;
    if (item.status === "available") return item;

    const now = isoNow();
    this.db.prepare(
      `UPDATE marketplace_items SET status = 'available', installed_at = NULL,
       installed_version = '', updated_at = ? WHERE id = ?`,
    ).run(now, id);

    // If it's a theme, deactivate it
    if (item.type === "theme") {
      this.db.prepare("UPDATE marketplace_themes SET active = 0 WHERE item_id = ?").run(id);
    }

    this.events.emit("data.changed", { module: "marketplace", action: "item_uninstalled" });
    return this.getItem(id);
  }

  enableItem(id: string): MarketplaceItem | undefined {
    const item = this.getItem(id);
    if (!item) return undefined;

    const now = isoNow();
    this.db.prepare("UPDATE marketplace_items SET status = 'active', updated_at = ? WHERE id = ?")
      .run(now, id);

    this.events.emit("data.changed", { module: "marketplace", action: "item_enabled" });
    return this.getItem(id);
  }

  disableItem(id: string): MarketplaceItem | undefined {
    const item = this.getItem(id);
    if (!item) return undefined;

    const now = isoNow();
    this.db.prepare("UPDATE marketplace_items SET status = 'disabled', updated_at = ? WHERE id = ?")
      .run(now, id);

    // If it's a theme, deactivate it
    if (item.type === "theme") {
      this.db.prepare("UPDATE marketplace_themes SET active = 0 WHERE item_id = ?").run(id);
    }

    this.events.emit("data.changed", { module: "marketplace", action: "item_disabled" });
    return this.getItem(id);
  }

  // ── Reviews ──────────────────────────────────────────

  addReview(input: {
    item_id: string;
    rating: number;
    title?: string;
    body?: string;
    author?: string;
  }): MarketplaceReview {
    const now = isoNow();
    const id = newId();

    this.db.prepare(
      `INSERT INTO marketplace_reviews (id, item_id, rating, title, body, author, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.item_id, input.rating, input.title ?? "", input.body ?? "", input.author ?? "local", now, now);

    // Recalculate avg_rating
    this.recalcRating(input.item_id);
    this.events.emit("data.changed", { module: "marketplace", action: "review_added" });

    return this.db.prepare("SELECT * FROM marketplace_reviews WHERE id = ?").get(id) as MarketplaceReview;
  }

  getReviews(itemId: string): MarketplaceReview[] {
    return this.db
      .prepare("SELECT * FROM marketplace_reviews WHERE item_id = ? ORDER BY created_at DESC")
      .all(itemId) as MarketplaceReview[];
  }

  deleteReview(id: string): boolean {
    const review = this.db.prepare("SELECT item_id FROM marketplace_reviews WHERE id = ?").get(id) as { item_id: string } | undefined;
    if (!review) return false;

    this.db.prepare("DELETE FROM marketplace_reviews WHERE id = ?").run(id);
    this.recalcRating(review.item_id);
    this.events.emit("data.changed", { module: "marketplace", action: "review_deleted" });
    return true;
  }

  private recalcRating(itemId: string): void {
    const row = this.db.prepare(
      "SELECT COALESCE(AVG(rating), 0) as avg, COUNT(*) as cnt FROM marketplace_reviews WHERE item_id = ?",
    ).get(itemId) as { avg: number; cnt: number };

    this.db.prepare(
      "UPDATE marketplace_items SET avg_rating = ?, review_count = ?, updated_at = ? WHERE id = ?",
    ).run(Math.round(row.avg * 10) / 10, row.cnt, isoNow(), itemId);
  }

  // ── Purchases ──────────────────────────────────────────

  purchaseItem(itemId: string): MarketplacePurchase {
    const item = this.getItem(itemId);
    if (!item) throw new Error("Item not found");

    const now = isoNow();
    const id = newId();

    this.db.prepare(
      `INSERT INTO marketplace_purchases (id, item_id, price_cents, currency, payment_method, purchased_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, itemId, item.price_cents, item.currency, item.price_cents === 0 ? "free" : "pending", now);

    return this.db.prepare("SELECT * FROM marketplace_purchases WHERE id = ?").get(id) as MarketplacePurchase;
  }

  getPurchases(): MarketplacePurchase[] {
    return this.db
      .prepare("SELECT * FROM marketplace_purchases ORDER BY purchased_at DESC")
      .all() as MarketplacePurchase[];
  }

  hasPurchased(itemId: string): boolean {
    const row = this.db
      .prepare("SELECT id FROM marketplace_purchases WHERE item_id = ? LIMIT 1")
      .get(itemId);
    return !!row;
  }

  // ── Themes ──────────────────────────────────────────

  activateTheme(itemId: string): ThemeRow | undefined {
    const item = this.getItem(itemId);
    if (!item || item.type !== "theme") return undefined;

    const now = isoNow();

    // Deactivate all themes
    this.db.prepare("UPDATE marketplace_themes SET active = 0").run();
    this.db.prepare("UPDATE marketplace_items SET status = 'installed' WHERE type = 'theme' AND status = 'active'").run();

    // Activate this one
    this.db.prepare("UPDATE marketplace_themes SET active = 1, applied_at = ? WHERE item_id = ?").run(now, itemId);
    this.db.prepare("UPDATE marketplace_items SET status = 'active', updated_at = ? WHERE id = ?").run(now, itemId);

    this.events.emit("data.changed", { module: "marketplace", action: "theme_activated" });
    return this.db.prepare("SELECT * FROM marketplace_themes WHERE item_id = ?").get(itemId) as ThemeRow;
  }

  deactivateTheme(): void {
    this.db.prepare("UPDATE marketplace_themes SET active = 0").run();
    this.db.prepare("UPDATE marketplace_items SET status = 'installed' WHERE type = 'theme' AND status = 'active'").run();

    // Re-activate the default theme (midnight-gold)
    const defaultItem = this.getItemBySlug("midnight-gold");
    if (defaultItem) {
      const now = isoNow();
      this.db.prepare("UPDATE marketplace_themes SET active = 1, applied_at = ? WHERE item_id = ?").run(now, defaultItem.id);
      this.db.prepare("UPDATE marketplace_items SET status = 'active', updated_at = ? WHERE id = ?").run(now, defaultItem.id);
    }

    this.events.emit("data.changed", { module: "marketplace", action: "theme_deactivated" });
  }

  getActiveTheme(): (ThemeRow & { name: string; icon: string; slug: string }) | null {
    const row = this.db.prepare(
      `SELECT t.*, i.name, i.icon, i.slug
       FROM marketplace_themes t
       JOIN marketplace_items i ON i.id = t.item_id
       WHERE t.active = 1`,
    ).get() as (ThemeRow & { name: string; icon: string; slug: string }) | undefined;

    return row ?? null;
  }

  /** All installed themes joined with their item metadata — used by the
   *  global theme switcher to render a picker with name/icon/swatches. */
  listThemes(): Array<{
    item_id: string;
    name: string;
    slug: string;
    icon: string;
    active: boolean;
    preview_colors: string;
  }> {
    return this.db.prepare(
      `SELECT t.item_id, i.name, i.slug, i.icon, t.active, t.preview_colors
       FROM marketplace_themes t
       JOIN marketplace_items i ON i.id = t.item_id
       ORDER BY t.active DESC, i.name ASC`,
    ).all() as Array<{
      item_id: string;
      name: string;
      slug: string;
      icon: string;
      active: boolean;
      preview_colors: string;
    }>;
  }

  getThemeData(itemId: string): ThemeRow | undefined {
    return this.db
      .prepare("SELECT * FROM marketplace_themes WHERE item_id = ?")
      .get(itemId) as ThemeRow | undefined;
  }

  // ── Import / Export ──────────────────────────────────

  exportItem(id: string): Record<string, unknown> | null {
    const item = this.getItem(id);
    if (!item) return null;

    const base = {
      slug: item.slug,
      name: item.name,
      version: item.version,
      description: item.description,
      author: item.author,
      icon: item.icon,
      category: item.category,
      tags: JSON.parse(item.tags),
    };

    if (item.type === "theme") {
      const theme = this.getThemeData(item.id);
      return {
        $schema: "kernl://marketplace/theme/v1",
        ...base,
        variables: theme ? JSON.parse(theme.variables) : {},
        fonts: theme ? JSON.parse(theme.fonts) : [],
        customCss: theme?.custom_css ?? "",
        previewColors: theme ? JSON.parse(theme.preview_colors) : [],
      };
    }

    // For other types, return the stored package_data
    const packageData = JSON.parse(item.package_data);
    return {
      $schema: `kernl://marketplace/${item.type}/v1`,
      ...base,
      ...packageData,
    };
  }

  importItem(pkg: Record<string, unknown>): MarketplaceItem {
    const schema = pkg.$schema as string;
    const slug = pkg.slug as string;
    const name = pkg.name as string;

    // Determine type from schema
    let type: ItemType = "template";
    if (schema?.includes("/extension/")) type = "extension";
    else if (schema?.includes("/agent/")) type = "agent";
    else if (schema?.includes("/flow/")) type = "flow";
    else if (schema?.includes("/theme/")) type = "theme";

    // Check for existing slug
    const existing = this.getItemBySlug(slug);
    if (existing) {
      // Update existing
      return this.updateItem(existing.id, {
        name,
        description: pkg.description as string ?? existing.description,
        version: pkg.version as string ?? existing.version,
        package_data: pkg as Record<string, unknown>,
      })!;
    }

    const item = this.createItem({
      type,
      slug,
      name,
      description: pkg.description as string,
      version: pkg.version as string,
      author: pkg.author as string,
      icon: pkg.icon as string,
      category: pkg.category as string,
      tags: pkg.tags as string[],
      source_type: "import",
      package_data: pkg as Record<string, unknown>,
    });

    // If theme, also create theme row
    if (type === "theme") {
      const now = isoNow();
      const vars = (pkg as { variables?: Record<string, string> }).variables ?? {};
      const fonts = (pkg as { fonts?: string[] }).fonts ?? [];
      const customCss = (pkg as { customCss?: string }).customCss ?? "";
      const previewColors = (pkg as { previewColors?: string[] }).previewColors ?? [];

      this.db.prepare(
        `INSERT INTO marketplace_themes (id, item_id, active, variables, fonts, custom_css, preview_colors, applied_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        newId(), item.id, 0,
        JSON.stringify(vars), JSON.stringify(fonts),
        customCss, JSON.stringify(previewColors), null,
      );
    }

    return item;
  }

  // ── Stats ──────────────────────────────────────────

  getStats(): {
    total: number;
    byType: Record<string, number>;
    installed: number;
    active: number;
    reviews: number;
    avgRating: number;
  } {
    const total = (this.db.prepare("SELECT COUNT(*) as cnt FROM marketplace_items").get() as { cnt: number }).cnt;
    const installed = (this.db.prepare("SELECT COUNT(*) as cnt FROM marketplace_items WHERE status IN ('installed','active')").get() as { cnt: number }).cnt;
    const active = (this.db.prepare("SELECT COUNT(*) as cnt FROM marketplace_items WHERE status = 'active'").get() as { cnt: number }).cnt;
    const reviews = (this.db.prepare("SELECT COUNT(*) as cnt FROM marketplace_reviews").get() as { cnt: number }).cnt;
    const avgRow = this.db.prepare("SELECT COALESCE(AVG(avg_rating), 0) as avg FROM marketplace_items WHERE review_count > 0").get() as { avg: number };

    const typeRows = this.db
      .prepare("SELECT type, COUNT(*) as cnt FROM marketplace_items GROUP BY type")
      .all() as Array<{ type: string; cnt: number }>;
    const byType: Record<string, number> = {};
    for (const r of typeRows) byType[r.type] = r.cnt;

    return { total, byType, installed, active, reviews, avgRating: Math.round(avgRow.avg * 10) / 10 };
  }

  getFeatured(limit = 10): MarketplaceItem[] {
    return this.listItems({ featured: true, limit });
  }

  getPopular(limit = 10): MarketplaceItem[] {
    return this.listItems({ sort: "popular", limit });
  }
}
