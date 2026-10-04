/**
 * Admin HTTP routes for the SandboxDriverRegistry.
 *
 *   GET  /api/sandbox-drivers                 → list + statuses
 *   GET  /api/sandbox-drivers/:slug           → one driver's status
 *   GET  /api/sandbox-drivers/:slug/schema    → config schema for the form
 *   GET  /api/sandbox-drivers/:slug/config    → current settings_json
 *   PUT  /api/sandbox-drivers/:slug/config    → save settings_json
 *   POST /api/sandbox-drivers/:slug/start     → (re)start the driver
 *   POST /api/sandbox-drivers/:slug/stop      → stop the driver
 */

import { HttpError, type KernelHttpServer } from "../http-server.js";
import type { SandboxDriverRegistry } from "./registry.js";

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

export function registerSandboxDriverRoutes(
  server: KernelHttpServer,
  registry: SandboxDriverRegistry,
): void {
  server.route("GET", "/api/sandbox-drivers", () => ({ drivers: registry.getStatuses() }));

  server.route("GET", "/api/sandbox-drivers/:slug", ({ params }) => {
    const slug = requireSlug(params);
    const status = registry.getStatuses().find((s) => s.slug === slug);
    if (!status) throw new HttpError(404, "driver not found");
    return { status };
  });

  server.route("GET", "/api/sandbox-drivers/:slug/schema", ({ params }) => {
    const schema = registry.getConfigSchema(requireSlug(params));
    if (!schema) throw new HttpError(404, "driver not found");
    return { schema };
  });

  server.route("GET", "/api/sandbox-drivers/:slug/config", ({ params }) => ({
    config: registry.loadConfig(requireSlug(params)),
  }));

  // Left on the raw handler: an empty or malformed body must stay a 400.
  // The helper reads an empty body as `{}`, which would pass the object
  // check below and save an empty config over the stored one.
  server.put("/api/sandbox-drivers/:slug/config", async (req, res) => {
    const slug = slugOf(req);
    if (!slug) { server.json(res, 400, { error: "invalid slug" }); return; }
    let parsed: unknown;
    try {
      parsed = await server.parseBody(req);
    } catch (err) {
      server.json(res, 400, { error: `body: ${String(err)}` });
      return;
    }
    const config = (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
      ? ((parsed as { config?: Record<string, unknown> }).config ?? (parsed as Record<string, unknown>))
      : null;
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      server.json(res, 400, { error: "body must be a JSON object" });
      return;
    }
    // Validate via the driver (if we can instantiate it).
    const schema = registry.getConfigSchema(slug);
    if (!schema) { server.json(res, 404, { error: "driver not found" }); return; }
    const running = registry.getDriver(slug);
    if (running) {
      const v = running.validateConfig(config);
      if (!v.valid) {
        server.json(res, 400, { error: "invalid config", errors: v.errors });
        return;
      }
    }
    const ok = registry.saveConfig(slug, config);
    if (!ok) { server.json(res, 500, { error: "failed to persist config" }); return; }

    // Hot-reload: if driver was running, restart to apply new config.
    if (running) {
      await registry.stopDriver(slug);
      const started = await registry.startDriver(slug);
      if (!started) {
        server.json(res, 200, {
          saved: true,
          running: false,
          error: registry.lastStartError,
        });
        return;
      }
    }
    server.json(res, 200, { saved: true, running: !!registry.getDriver(slug) });
  });

  server.route("POST", "/api/sandbox-drivers/:slug/start", async ({ params }) => {
    const ok = await registry.startDriver(requireSlug(params));
    if (!ok) {
      const error = registry.lastStartError ?? "start failed";
      throw new HttpError(500, error, { ok: false, error });
    }
    return { ok: true };
  });

  server.route("POST", "/api/sandbox-drivers/:slug/stop", async ({ params }) => {
    const ok = await registry.stopDriver(requireSlug(params));
    if (!ok) throw new HttpError(404, "driver not running", { ok });
    return { ok };
  });
}
