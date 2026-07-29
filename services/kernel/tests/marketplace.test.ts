import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { marketplaceMigrations } from "../src/modules/marketplace/migrations.js";
import { MarketplaceService } from "../src/modules/marketplace/service.js";
import { seedBundledItems, seedDefaultThemes } from "../src/modules/marketplace/seeders.js";
import { EventBus } from "../src/core/event-bus.js";
import type { SqliteDb } from "../src/core/db/sqlite.js";

function createDb(): SqliteDb {
  const db = new Database(":memory:");
  runMigrations(db, "marketplace", marketplaceMigrations);
  return db;
}

describe("Marketplace Service", () => {
  let db: SqliteDb;
  let events: EventBus;
  let service: MarketplaceService;

  beforeEach(() => {
    db = createDb();
    events = new EventBus();
    service = new MarketplaceService(db, events);
  });

  // ── Item CRUD ──────────────────────────────────────

  it("should create an item", () => {
    const item = service.createItem({
      type: "extension",
      slug: "test-ext",
      name: "Test Extension",
      description: "A test",
      tags: ["test"],
    });
    expect(item.id).toBeTruthy();
    expect(item.slug).toBe("test-ext");
    expect(item.type).toBe("extension");
    expect(item.status).toBe("available");
    expect(JSON.parse(item.tags)).toEqual(["test"]);
  });

  it("should get item by slug", () => {
    service.createItem({ type: "agent", slug: "my-agent", name: "My Agent" });
    const found = service.getItemBySlug("my-agent");
    expect(found).toBeDefined();
    expect(found!.name).toBe("My Agent");
  });

  it("should list items with filters", () => {
    service.createItem({ type: "extension", slug: "ext-1", name: "Ext 1" });
    service.createItem({ type: "agent", slug: "agent-1", name: "Agent 1" });
    service.createItem({ type: "theme", slug: "theme-1", name: "Theme 1" });

    expect(service.listItems().length).toBe(3);
    expect(service.listItems({ type: "extension" }).length).toBe(1);
    expect(service.listItems({ type: "agent" }).length).toBe(1);
  });

  it("should search items by query", () => {
    service.createItem({ type: "extension", slug: "weather-skill", name: "Weather Skill", description: "Shows weather data" });
    service.createItem({ type: "agent", slug: "task-bot", name: "Task Bot" });

    const results = service.searchItems("weather");
    expect(results.length).toBe(1);
    expect(results[0].slug).toBe("weather-skill");
  });

  it("should update an item", () => {
    const item = service.createItem({ type: "extension", slug: "upd", name: "Original" });
    const updated = service.updateItem(item.id, { name: "Updated", featured: true });
    expect(updated!.name).toBe("Updated");
    expect(updated!.featured).toBe(1);
  });

  it("should delete an item", () => {
    const item = service.createItem({ type: "extension", slug: "del", name: "To Delete" });
    expect(service.deleteItem(item.id)).toBe(true);
    expect(service.getItem(item.id)).toBeNull();
  });

  // ── Install / Uninstall ──────────────────────────────

  it("should install and uninstall an item", () => {
    const item = service.createItem({ type: "extension", slug: "inst", name: "Installable" });

    const installed = service.installItem(item.id);
    expect(installed!.status).toBe("installed");
    expect(installed!.installed_at).toBeTruthy();
    expect(installed!.install_count).toBe(1);

    const uninstalled = service.uninstallItem(item.id);
    expect(uninstalled!.status).toBe("available");
    expect(uninstalled!.installed_at).toBeNull();
  });

  it("should enable and disable an item", () => {
    const item = service.createItem({ type: "extension", slug: "toggle", name: "Toggle" });
    service.installItem(item.id);

    const enabled = service.enableItem(item.id);
    expect(enabled!.status).toBe("active");

    const disabled = service.disableItem(item.id);
    expect(disabled!.status).toBe("disabled");
  });

  // ── Reviews ──────────────────────────────────────

  it("should add reviews and calculate avg_rating", () => {
    const item = service.createItem({ type: "extension", slug: "rated", name: "Rated" });

    service.addReview({ item_id: item.id, rating: 5, title: "Great!" });
    service.addReview({ item_id: item.id, rating: 3, title: "OK" });

    const updated = service.getItem(item.id);
    expect(updated!.avg_rating).toBe(4);
    expect(updated!.review_count).toBe(2);
  });

  it("should delete review and recalculate", () => {
    const item = service.createItem({ type: "extension", slug: "rev-del", name: "Rev Del" });
    const r1 = service.addReview({ item_id: item.id, rating: 5 });
    service.addReview({ item_id: item.id, rating: 1 });

    service.deleteReview(r1.id);
    const updated = service.getItem(item.id);
    expect(updated!.avg_rating).toBe(1);
    expect(updated!.review_count).toBe(1);
  });

  it("should get reviews for an item", () => {
    const item = service.createItem({ type: "extension", slug: "rev-list", name: "Rev List" });
    service.addReview({ item_id: item.id, rating: 4, body: "Nice" });
    service.addReview({ item_id: item.id, rating: 5, body: "Excellent" });

    const reviews = service.getReviews(item.id);
    expect(reviews.length).toBe(2);
  });

  // ── Purchases ──────────────────────────────────────

  it("should purchase a free item", () => {
    const item = service.createItem({ type: "extension", slug: "free-item", name: "Free" });
    const purchase = service.purchaseItem(item.id);
    expect(purchase.price_cents).toBe(0);
    expect(purchase.payment_method).toBe("free");
    expect(service.hasPurchased(item.id)).toBe(true);
  });

  it("should list purchases", () => {
    const item = service.createItem({ type: "extension", slug: "purch-list", name: "Purch" });
    service.purchaseItem(item.id);
    const purchases = service.getPurchases();
    expect(purchases.length).toBe(1);
  });

  // ── Themes ──────────────────────────────────────

  it("should activate and deactivate themes", () => {
    // Create two themes
    const t1 = service.createItem({ type: "theme", slug: "theme-a", name: "Theme A" });
    const t2 = service.createItem({ type: "theme", slug: "theme-b", name: "Theme B" });

    // Insert theme rows
    db.prepare(
      `INSERT INTO marketplace_themes (id, item_id, active, variables, fonts, custom_css, preview_colors)
       VALUES (?, ?, 0, '{"--bg":"#000"}', '[]', '', '["#000"]')`,
    ).run("ta", t1.id);
    db.prepare(
      `INSERT INTO marketplace_themes (id, item_id, active, variables, fonts, custom_css, preview_colors)
       VALUES (?, ?, 0, '{"--bg":"#fff"}', '[]', '', '["#fff"]')`,
    ).run("tb", t2.id);

    // Activate theme A
    const activated = service.activateTheme(t1.id);
    expect(activated!.active).toBe(1);

    // Activate theme B (should deactivate A)
    service.activateTheme(t2.id);
    const aAfter = service.getThemeData(t1.id);
    expect(aAfter!.active).toBe(0);

    // Get active theme
    const active = service.getActiveTheme();
    expect(active).toBeDefined();
    expect(active!.name).toBe("Theme B");
  });

  // ── Import / Export ──────────────────────────────────

  it("should import and export an agent package", () => {
    const pkg = {
      $schema: "kernl://marketplace/agent/v1",
      slug: "imported-agent",
      name: "Imported Agent",
      version: "1.0.0",
      description: "An imported agent",
      author: "Test",
      icon: "🤖",
      category: "agent",
      tags: ["test"],
      agent: {
        system_prompt: "You are helpful",
        goal_template: "Do the thing",
        allowed_tools: [],
        denied_tools: [],
        provider: "claude",
        model: "claude-3",
        max_iterations: 10,
        timeout_ms: 60000,
        variables: {},
      },
    };

    const item = service.importItem(pkg);
    expect(item.type).toBe("agent");
    expect(item.slug).toBe("imported-agent");
    expect(item.source_type).toBe("import");

    // Export
    const exported = service.exportItem(item.id);
    expect(exported).toBeTruthy();
    expect((exported as Record<string, unknown>).$schema).toBe("kernl://marketplace/agent/v1");
    expect((exported as Record<string, unknown>).slug).toBe("imported-agent");
  });

  it("should import a theme with theme row", () => {
    const pkg = {
      $schema: "kernl://marketplace/theme/v1",
      slug: "custom-theme",
      name: "Custom Theme",
      version: "1.0.0",
      description: "A custom theme",
      author: "Test",
      icon: "🎨",
      variables: { "--bg": "#123456", "--text-1": "#FFFFFF" },
      fonts: ["https://fonts.googleapis.com/css2?family=Inter"],
      customCss: ".custom { color: red; }",
      previewColors: ["#123456", "#FFFFFF"],
    };

    const item = service.importItem(pkg as Record<string, unknown>);
    expect(item.type).toBe("theme");

    const themeData = service.getThemeData(item.id);
    expect(themeData).toBeDefined();
    expect(JSON.parse(themeData!.variables)["--bg"]).toBe("#123456");
  });

  it("should update existing item on re-import", () => {
    const pkg1 = {
      $schema: "kernl://marketplace/agent/v1",
      slug: "reimport-test",
      name: "V1",
      version: "1.0.0",
    };
    const item1 = service.importItem(pkg1);

    const pkg2 = {
      $schema: "kernl://marketplace/agent/v1",
      slug: "reimport-test",
      name: "V2",
      version: "2.0.0",
    };
    const item2 = service.importItem(pkg2);

    expect(item2.id).toBe(item1.id);
    expect(item2.name).toBe("V2");
    expect(item2.version).toBe("2.0.0");
  });

  // ── Stats ──────────────────────────────────────

  it("should return stats", () => {
    service.createItem({ type: "extension", slug: "s1", name: "S1" });
    service.createItem({ type: "agent", slug: "s2", name: "S2" });
    service.createItem({ type: "theme", slug: "s3", name: "S3" });
    service.installItem(service.getItemBySlug("s1")!.id);

    const stats = service.getStats();
    expect(stats.total).toBe(3);
    expect(stats.installed).toBe(1);
    expect(stats.byType.extension).toBe(1);
    expect(stats.byType.agent).toBe(1);
    expect(stats.byType.theme).toBe(1);
  });

  it("should get featured items", () => {
    service.createItem({ type: "extension", slug: "f1", name: "Featured", featured: true });
    service.createItem({ type: "extension", slug: "f2", name: "Not Featured" });

    const featured = service.getFeatured();
    expect(featured.length).toBe(1);
    expect(featured[0].slug).toBe("f1");
  });

  // ── Seeders ──────────────────────────────────────

  it("should seed bundled items", () => {
    // Bundled extensions migrated to the assets/extensions catalog —
    // BUNDLED_EXTENSIONS is intentionally empty, so seeding is a no-op.
    seedBundledItems(db);
    const items = service.listItems({ type: "extension" });
    expect(items.length).toBe(0);
  });

  it("should seed default themes", () => {
    seedDefaultThemes(db);
    const themes = service.listItems({ type: "theme" });
    expect(themes.length).toBe(6);

    // Midnight Gold should be active by default
    const midnightGold = service.getItemBySlug("midnight-gold");
    expect(midnightGold).toBeDefined();
    expect(midnightGold!.status).toBe("active");

    // Should have theme data
    const themeData = service.getThemeData(midnightGold!.id);
    expect(themeData).toBeDefined();
    expect(themeData!.active).toBe(1);
  });

  it("should not duplicate seeded items on re-run", () => {
    seedDefaultThemes(db);
    seedDefaultThemes(db);
    expect(service.listItems({ type: "theme" }).length).toBe(6);
  });

  it("should ignore skill registry statuses for unseeded slugs", () => {
    // With BUNDLED_EXTENSIONS empty, a skill status for an unknown slug
    // must not create items or throw.
    seedBundledItems(db, { "morning-briefing": "enabled" });
    expect(service.getItemBySlug("morning-briefing")).toBeFalsy();
  });
});

describe("Marketplace Dashboard Query", () => {
  it("should return null when table doesn't exist", async () => {
    const db = new Database(":memory:") as unknown as SqliteDb;
    const { queryMarketplace } = await import("../src/modules/marketplace/dashboard-query.js");
    expect(queryMarketplace(db)).toBeNull();
  });

  it("should return marketplace data", async () => {
    const db = createDb();
    const events = new EventBus();
    const service = new MarketplaceService(db, events);
    seedBundledItems(db);
    seedDefaultThemes(db);

    const { queryMarketplace } = await import("../src/modules/marketplace/dashboard-query.js");
    const result = queryMarketplace(db);
    expect(result).toBeTruthy();
    expect(result!.items.length).toBe(6);
    expect(result!.stats.total).toBe(6);
    expect(result!.activeTheme).toBeTruthy();
    expect(result!.activeTheme!.slug).toBe("midnight-gold");
    expect(result!.themes.length).toBe(6);
  });
});
