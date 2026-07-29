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

import type { KernelHttpServer } from "../http-server.js";
import type { SandboxDriverRegistry } from "./registry.js";

function slugOf(req: unknown): string | null {
  const params = (req as { params?: Record<string, string> }).params;
  const slug = params?.slug;
  if (!slug || !/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(slug)) return null;
  return slug;
}

export function registerSandboxDriverRoutes(
  server: KernelHttpServer,
  registry: SandboxDriverRegistry,
): void {
  server.get("/api/sandbox-drivers", (_req, res) => {
    server.json(res, 200, { drivers: registry.getStatuses() });
  });

  server.get("/api/sandbox-drivers/:slug", (req, res) => {
    const slug = slugOf(req);
    if (!slug) { server.json(res, 400, { error: "invalid slug" }); return; }
    const status = registry.getStatuses().find((s) => s.slug === slug);
    if (!status) { server.json(res, 404, { error: "driver not found" }); return; }
    server.json(res, 200, { status });
  });

  server.get("/api/sandbox-drivers/:slug/schema", (req, res) => {
    const slug = slugOf(req);
    if (!slug) { server.json(res, 400, { error: "invalid slug" }); return; }
    const schema = registry.getConfigSchema(slug);
    if (!schema) { server.json(res, 404, { error: "driver not found" }); return; }
    server.json(res, 200, { schema });
  });

  server.get("/api/sandbox-drivers/:slug/config", (req, res) => {
    const slug = slugOf(req);
    if (!slug) { server.json(res, 400, { error: "invalid slug" }); return; }
    server.json(res, 200, { config: registry.loadConfig(slug) });
  });

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

  server.post("/api/sandbox-drivers/:slug/start", async (req, res) => {
    const slug = slugOf(req);
    if (!slug) { server.json(res, 400, { error: "invalid slug" }); return; }
    const ok = await registry.startDriver(slug);
    if (!ok) {
      server.json(res, 500, { ok: false, error: registry.lastStartError ?? "start failed" });
      return;
    }
    server.json(res, 200, { ok: true });
  });

  server.post("/api/sandbox-drivers/:slug/stop", async (req, res) => {
    const slug = slugOf(req);
    if (!slug) { server.json(res, 400, { error: "invalid slug" }); return; }
    const ok = await registry.stopDriver(slug);
    server.json(res, ok ? 200 : 404, { ok });
  });
}
