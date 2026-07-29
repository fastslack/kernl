/**
 * Generic Settings Catalog Routes — the REST face of the settings catalog.
 *
 * GET /api/settings/catalog — every known setting (core + extension-contributed)
 *   with metadata and current values (secrets masked). The dashboard Settings UI
 *   renders itself from this response; extensions appear automatically.
 * PUT /api/settings — batch update { entries: { KEY: "value", ... } }.
 *   Persists via ConfigService.setMany(): SQLite + .env + process.env +
 *   live-config hot-reload + config:changed event.
 *
 * Extension settings are re-synced from the extensions table on each catalog
 * fetch, so installing/activating an extension surfaces its section without
 * restarts or event plumbing.
 */

import type { KernelHttpServer } from "../../core/http-server.js";
import type { KernelConfig } from "../../core/config.js";
import type { EventBus } from "../../core/event-bus.js";
import type { SqliteDb } from "../../core/db/sqlite.js";
import { ConfigService } from "./service.js";
import {
  ExtensionSettingsRegistry,
  type ExtensionServiceLike,
} from "./extension-settings.js";
import type { AppSetting } from "./types.js";

interface CatalogItem {
  key: string;
  type: string;
  label: unknown;
  description: unknown;
  category: string;
  sensitive: boolean;
  readonly: boolean;
  /** Masked when sensitive; raw otherwise. */
  value: string;
  configured: boolean;
  /** Slug of the contributing extension; absent for core settings. */
  extension?: string;
  updated_at?: string;
}

export function registerSettingsRoutes(
  server: KernelHttpServer,
  deps: {
    sqlite: SqliteDb;
    config: KernelConfig;
    events: EventBus;
    extensionService: ExtensionServiceLike;
  },
): void {
  const svc = new ConfigService(deps.sqlite, deps.config, deps.events);
  const extRegistry = new ExtensionSettingsRegistry();
  svc.attachExtensionDefs(extRegistry.defs);

  const coreKeys = new Set(svc.getCatalog().map((d) => d.key));
  const syncExtensions = () => {
    extRegistry.sync(deps.extensionService, (k) => coreKeys.has(k));
    const defs = extRegistry.allDefs();
    if (defs.length) {
      svc.seedDefs(defs, Object.fromEntries(defs.map((d) => [d.key, d.default])));
    }
  };

  const toItem = (
    def: { key: string; type: string; label: unknown; description: unknown; category: string; sensitive?: boolean; readonly?: boolean },
    row: AppSetting | undefined,
    extension?: string,
  ): CatalogItem => {
    const raw = row?.value ?? "";
    return {
      key: def.key,
      type: def.type,
      label: def.label,
      description: def.description,
      category: def.category,
      sensitive: !!def.sensitive,
      readonly: !!def.readonly,
      value: def.sensitive && raw ? svc.maskValue(raw) : raw,
      configured: raw.length > 0,
      ...(extension ? { extension } : {}),
      updated_at: row?.updated_at,
    };
  };

  // ── GET /api/settings/catalog ─────────────────────────────
  server.get("/api/settings/catalog", (_req, res) => {
    syncExtensions();
    const rows = new Map(svc.list().map((r) => [r.key, r]));

    const core = svc.getCatalog().map((def) => toItem(def, rows.get(def.key)));
    const extensionSections = extRegistry.getSections().map((section) => ({
      extension: section.extension,
      id: section.id,
      label: section.label,
      icon: section.icon,
      fields: section.fields.map((f) =>
        toItem(
          { ...f, label: f.labelI18n, description: f.descriptionI18n },
          rows.get(f.key),
          section.extension,
        ),
      ),
    }));

    server.json(res, 200, { settings: core, extensionSections });
  });

  // ── PUT /api/settings ─────────────────────────────────────
  server.put("/api/settings", async (req, res) => {
    let body: { entries?: Record<string, unknown> };
    try {
      body = await server.parseBody<{ entries?: Record<string, unknown> }>(req);
    } catch {
      return server.json(res, 400, { error: "Invalid JSON body" });
    }
    const entries = body?.entries;
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
      return server.json(res, 400, { error: "Body must be { entries: { KEY: value } }" });
    }

    syncExtensions();

    const list: Array<{ key: string; value: string }> = [];
    const rejected: Array<{ key: string; error: string }> = [];
    for (const [key, value] of Object.entries(entries)) {
      const def = svc.resolveDef(key);
      if (!def) {
        rejected.push({ key, error: "Unknown setting key" });
        continue;
      }
      if (def.sensitive && typeof value === "string" && value.includes("***")) {
        // The UI echoes masked values back for untouched secrets — skip them.
        continue;
      }
      list.push({ key, value: String(value ?? "") });
    }

    const { updated, errors } = svc.setMany(list, "user");
    server.json(res, 200, { updated, errors: [...rejected, ...errors] });
  });
}
