import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { configMigrations } from "../src/modules/config/migrations/001_config.js";
import { ConfigService } from "../src/modules/config/service.js";
import { EventBus } from "../src/core/event-bus.js";
import {
  ExtensionSettingsRegistry,
  type ExtensionServiceLike,
} from "../src/modules/config/extension-settings.js";
import type { KernelConfig } from "../src/core/config.js";

function fakeExtensions(rows: Array<{ slug: string; name?: string; status?: string; manifest: Record<string, unknown> }>): ExtensionServiceLike {
  return {
    list: (filters?: { status?: string }) =>
      rows
        .filter((r) => !filters?.status || (r.status ?? "active") === filters.status)
        .map((r) => ({
          slug: r.slug,
          name: r.name ?? r.slug,
          status: r.status ?? "active",
          manifest_json: JSON.stringify(r.manifest),
        })),
  };
}

const TRADING_MANIFEST = {
  slug: "trading",
  settings: {
    section: { id: "trading", label: { es: "Trading", en: "Trading" }, icon: "chart" },
    fields: [
      { key: "default_exchange", type: "string", label: { en: "Default exchange" }, default: "kraken" },
      { key: "ext.trading.api_key", type: "secret", label: "API key" },
    ],
  },
};

describe("ExtensionSettingsRegistry", () => {
  it("namespaces keys to ext.<slug>.* and builds sections from active extensions", () => {
    const registry = new ExtensionSettingsRegistry();
    registry.sync(fakeExtensions([{ slug: "trading", manifest: TRADING_MANIFEST }]));

    const sections = registry.getSections();
    expect(sections).toHaveLength(1);
    expect(sections[0].id).toBe("trading");
    const keys = sections[0].fields.map((f) => f.key);
    expect(keys).toEqual(["ext.trading.default_exchange", "ext.trading.api_key"]);
    expect(sections[0].fields[1].sensitive).toBe(true);
  });

  it("passes env-style keys through unprefixed but blocks core-catalog shadowing", () => {
    const registry = new ExtensionSettingsRegistry();
    registry.sync(
      fakeExtensions([{
        slug: "torrents",
        manifest: {
          settings: {
            fields: [
              { key: "TORRENTS_1337X_BASE", type: "string", label: "1337x base URL", default: "https://1337x.to" },
              { key: "ANTHROPIC_API_KEY", type: "secret", label: "shadow attempt" },
            ],
          },
        },
      }]),
      (k) => k === "ANTHROPIC_API_KEY",
    );
    const keys = registry.getSections()[0].fields.map((f) => f.key);
    expect(keys).toEqual(["TORRENTS_1337X_BASE"]);
  });

  it("ignores inactive extensions, invalid fields, and rebuilds wholesale on re-sync", () => {
    const registry = new ExtensionSettingsRegistry();
    registry.sync(fakeExtensions([
      { slug: "trading", manifest: TRADING_MANIFEST },
      { slug: "disabled-ext", status: "error", manifest: TRADING_MANIFEST },
      { slug: "bad", manifest: { settings: { fields: [{ key: "x", type: "nope", label: "X" }] } } },
      { slug: "none", manifest: {} },
    ]));
    expect(registry.getSections()).toHaveLength(1);
    expect(registry.defs.size).toBe(2);

    // Extension uninstalled → next sync drops its section and defs.
    registry.sync(fakeExtensions([]));
    expect(registry.getSections()).toHaveLength(0);
    expect(registry.defs.size).toBe(0);
  });
});

describe("ConfigService + extension settings", () => {
  let db: Database;
  let svc: ConfigService;
  let registry: ExtensionSettingsRegistry;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, "config", configMigrations);
    svc = new ConfigService(db, {} as KernelConfig, new EventBus());
    registry = new ExtensionSettingsRegistry();
    svc.attachExtensionDefs(registry.defs);
    registry.sync(fakeExtensions([{ slug: "trading", manifest: TRADING_MANIFEST }]));
  });

  afterEach(() => {
    db.close();
  });

  it("seedDefs inserts extension defaults idempotently and preserves user values", () => {
    const defs = registry.allDefs();
    const defaults = Object.fromEntries(defs.map((d) => [d.key, d.default]));

    svc.seedDefs(defs, defaults);
    expect(svc.get("ext.trading.default_exchange")?.value).toBe("kraken");

    // Simulate a user change, then re-seed (as a catalog fetch would).
    db.prepare("UPDATE app_settings SET value='bitvavo' WHERE key='ext.trading.default_exchange'").run();
    svc.seedDefs(defs, defaults);
    expect(svc.get("ext.trading.default_exchange")?.value).toBe("bitvavo");
  });

  it("resolveDef finds extension defs for validation", () => {
    expect(svc.resolveDef("ext.trading.api_key")?.sensitive).toBe(true);
    expect(svc.resolveDef("ext.trading.api_key")?.type).toBe("secret");
    expect(svc.resolveDef("AGENTS_DEFAULT_PROVIDER")).toBeDefined(); // core still works
    expect(svc.resolveDef("ext.ghost.key")).toBeUndefined();
  });

  it("maskValue never leaks full secrets", () => {
    expect(svc.maskValue("sk-abcdefghijklmnop")).toContain("***");
    expect(svc.maskValue("sk-abcdefghijklmnop")).not.toContain("ijklm");
  });
});
