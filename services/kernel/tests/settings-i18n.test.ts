import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { ConfigService } from "../src/modules/config/service.js";
import { extensionManifestSchema } from "../src/modules/extensions/schema.js";
import { runMigrations } from "../src/core/db/migrations.js";
import { configMigrations } from "../src/modules/config/migrations/001_config.js";
import { EventBus } from "../src/core/event-bus.js";
import { loadConfig } from "../src/core/config.js";

/** ConfigService needs a live config + bus; neither is exercised by these tests. */
function svcOn(db: Database) {
  return new ConfigService(db, loadConfig(), new EventBus());
}

/*
 * The dashboard renders every settings label through resolveText(), which takes
 * a plain string or a { locale: text } map. The core catalog shipped bare
 * English while the extension-contributed fields beside it were localizable, so
 * a Spanish install rendered the kernel's own settings in English.
 */
describe("core settings catalog is localizable", () => {
  const catalog = svcOn(new Database(":memory:")).getCatalog();

  it("carries a Spanish label and description for every entry", () => {
    const bare = catalog.filter((d) => typeof d.label === "string");
    expect(bare.map((d) => d.key)).toEqual([]);

    const missingEs = catalog.filter((d) => {
      const l = d.label as Record<string, string>;
      return !l.es || !l.en;
    });
    expect(missingEs.map((d) => d.key)).toEqual([]);
  });

  it("translates the two fields the operator sees first", () => {
    const tz = catalog.find((d) => d.key === "TIMEZONE");
    const lang = catalog.find((d) => d.key === "KERNEL_DEFAULT_LANGUAGE");
    expect((tz?.label as Record<string, string>).es).toBe("Zona horaria");
    expect((lang?.label as Record<string, string>).es).toBe("Idioma por defecto");
    expect((tz?.description as Record<string, string>).es).toContain("Zona horaria IANA");
  });

  /*
   * app_settings keeps a denormalized copy of the label, and SQLite cannot bind
   * an object. Seeding must flatten it rather than throw — a regression here
   * takes the whole config module down at boot, not just the label.
   */
  it("seeds without tripping over the localized labels", () => {
    const db = new Database(":memory:");
    runMigrations(db, "config", configMigrations);
    const svc = svcOn(db);
    expect(() => svc.seed()).not.toThrow();

    const row = db.prepare("SELECT label FROM app_settings WHERE key = ?").get("TIMEZONE") as
      | { label: string }
      | undefined;
    expect(typeof row?.label).toBe("string");
    expect(row?.label).toBe("Timezone"); // English text, catalog stays the source of truth
  });
});

/*
 * navItemSchema.label was a bare z.string() while settingsFieldSchema.label in
 * the same file was localizable — an extension could translate its settings but
 * not its own tab.
 */
describe("extension nav labels are localizable", () => {
  const base = {
    $schema: "kernl://extension/v1",
    id: "com.t.demo",
    slug: "demo-ext",
    name: "Demo",
    version: "1.0.0",
    type: "module",
    description: "d",
    author: "a",
    license: "MIT",
    category: "leisure",
  };

  const parse = (frontend: unknown) => extensionManifestSchema.safeParse({ ...base, frontend });

  it("accepts a { locale: text } map on nav items and groups", () => {
    const r = parse({
      navGroups: [{ id: "leisure", label: { en: "Leisure", es: "Ocio" }, icon: "🎭" }],
      navItems: [{ id: "tv", group: "leisure", label: { en: "TV", es: "Tele" }, icon: "📺" }],
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.frontend?.navGroups?.[0].label).toEqual({ en: "Leisure", es: "Ocio" });
    expect(r.data.frontend?.navItems?.[0].label).toEqual({ en: "TV", es: "Tele" });
  });

  it("still accepts a plain string, so installed manifests keep parsing", () => {
    const r = parse({ navItems: [{ id: "books", group: "leisure", label: "Books", icon: "📚" }] });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.frontend?.navItems?.[0].label).toBe("Books");
  });

  /*
   * localizedTextSchema is declared above its first use on purpose: a const is
   * in the temporal dead zone until its own line runs, so referencing it from
   * navItemSchema while it sat further down threw at import time — something
   * tsc cannot see.
   */
  it("evaluates the module without a temporal-dead-zone throw", () => {
    expect(typeof extensionManifestSchema.safeParse).toBe("function");
  });
});
