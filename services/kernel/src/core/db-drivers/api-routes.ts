/**
 * Admin HTTP routes for the DbDriverRegistry.
 *
 *   GET  /api/db-drivers                  → list + statuses (every kind)
 *   GET  /api/db-drivers/:slug            → one driver's status
 *   GET  /api/db-drivers/:slug/schema     → config schema for the form
 *   GET  /api/db-drivers/:slug/config     → current settings_json
 *   PUT  /api/db-drivers/:slug/config     → save settings_json (hot-reload if running)
 *   POST /api/db-drivers/:slug/activate   → set this slug active for its kind
 *   POST /api/db-drivers/:slug/start      → start without changing active
 *   POST /api/db-drivers/:slug/stop       → stop a driver
 *
 * `activate` is the killer endpoint: a single click in the dashboard switches
 * the kernel between graph backends (noop ↔ neo4j ↔ kuzu when added). The
 * registry enforces the single-active-per-kind invariant in the same DB
 * transaction that flips the row.
 */

import { HttpError, type KernelHttpServer } from "../http-server.js";
import type { DbDriverRegistry } from "./db-driver-registry.js";

function slugOf(req: unknown): string | null {
  const params = (req as { params?: Record<string, string> }).params;
  const slug = params?.slug;
  if (!slug || !/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(slug)) return null;
  return slug;
}

/** The validated `:slug`, or a 400. */
function requireSlug(params: Record<string, string>): string {
  const slug = slugOf({ params });
  if (!slug) throw new HttpError(400, "invalid slug");
  return slug;
}

export function registerDbDriverRoutes(
  server: KernelHttpServer,
  registry: DbDriverRegistry,
): void {
  server.route("GET", "/api/db-drivers", () => ({ drivers: registry.getAllStatuses() }));

  server.route("GET", "/api/db-drivers/:slug", ({ params }) => {
    const slug = requireSlug(params);
    const row = registry.getAllStatuses().find((r) => {
      const s = r.status as { slug?: string };
      return s.slug === slug;
    });
    if (!row) throw new HttpError(404, "driver not found");
    return row;
  });

  server.route("GET", "/api/db-drivers/:slug/schema", ({ params }) => {
    const schema = registry.getConfigSchema(requireSlug(params));
    if (!schema) throw new HttpError(404, "driver not found");
    return { schema };
  });

  server.route("GET", "/api/db-drivers/:slug/config", ({ params }) => {
    const config = registry.loadConfig(requireSlug(params));
    if (config === null) throw new HttpError(404, "driver not found");
    return { config };
  });

  // Left on the raw handler: an empty or malformed body must stay a 400.
  // The helper reads an empty body as `{}`, which would reach validation
  // and, for a driver with no required fields, save an empty config.
  server.put("/api/db-drivers/:slug/config", async (req, res) => {
    const slug = slugOf(req);
    if (!slug) {
      server.json(res, 400, { error: "invalid slug" });
      return;
    }
    let parsed: unknown;
    try {
      parsed = await server.parseBody(req);
    } catch (err) {
      server.json(res, 400, { error: `body: ${String(err)}` });
      return;
    }
    const config =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? ((parsed as { config?: Record<string, unknown> }).config ??
          (parsed as Record<string, unknown>))
        : null;
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      server.json(res, 400, { error: "body must be a JSON object" });
      return;
    }

    const validation = registry.validateConfig(slug, config);
    if (validation === null) {
      server.json(res, 404, { error: "driver not found" });
      return;
    }
    if (!validation.valid) {
      server.json(res, 400, { error: "invalid config", errors: validation.errors });
      return;
    }

    const ok = registry.saveConfig(slug, config);
    if (!ok) {
      server.json(res, 500, { error: "failed to persist config" });
      return;
    }

    // Hot-reload: if this is the active driver, restart so new config takes
    // effect. The registry's setActive() handles stop+start in one shot.
    const allStatuses = registry.getAllStatuses();
    const row = allStatuses.find((r) => {
      const s = r.status as { slug?: string };
      return s.slug === slug;
    });
    if (row?.active) {
      const restarted = await registry.setActive(slug);
      if (!restarted) {
        server.json(res, 200, {
          saved: true,
          running: false,
          error: registry.lastStartError,
        });
        return;
      }
    }

    server.json(res, 200, { saved: true, running: !!row?.active });
  });

  server.route("POST", "/api/db-drivers/:slug/activate", async ({ params }) => {
    const ok = await registry.setActive(requireSlug(params));
    if (!ok) {
      const error = registry.lastStartError ?? "activate failed";
      throw new HttpError(500, error, { ok: false, error });
    }
    return { ok: true };
  });

  server.route("POST", "/api/db-drivers/:slug/start", async ({ params }) => {
    const ok = await registry.startDriver(requireSlug(params));
    if (!ok) {
      const error = registry.lastStartError ?? "start failed";
      throw new HttpError(500, error, { ok: false, error });
    }
    return { ok: true };
  });

  server.route("POST", "/api/db-drivers/:slug/stop", async ({ params }) => {
    const ok = await registry.stopDriver(requireSlug(params));
    if (!ok) throw new HttpError(404, "driver not running", { ok });
    return { ok };
  });
}
