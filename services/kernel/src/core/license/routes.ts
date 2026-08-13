/**
 * HTTP routes for the license service.
 *
 *   GET  /api/license/status   → { status, claim?, message? }
 *   POST /api/license/set      → { jwt } body. Returns the new status report
 *                                 (200 on accept, 400 on rejection).
 *   POST /api/license/clear    → drops the on-disk license. Always 200.
 *
 * These power the dashboard's "Manage license" pane and the CLI
 * `kernl license set <jwt>` shim. No auth wrapper here — the dashboard
 * is already gated behind the kernel's local-bind / pairing model.
 */

import type { KernelHttpServer } from "../http-server.js";
import type { LicenseService } from "./types.js";
import { LicenseError } from "./types.js";
import { log } from "../logger.js";

export function registerLicenseRoutes(
  server: KernelHttpServer,
  license: LicenseService,
): void {
  // ── GET /api/license/status ──────────────────────────────────────
  // Cheap read of the in-memory cache. The cache is warmed on boot and
  // updated by /set + /clear, so no I/O happens here unless the caller
  // explicitly hits /refresh (not exposed by default).
  server.get("/api/license/status", (_req, res) => {
    const report = license.status();
    // Surface a flattened view that's easier to consume from Svelte —
    // expanding `claim` keeps the API stable when LicenseClaim grows.
    server.json(res, 200, {
      status: report.status,
      isPro: license.isPro(),
      sku: report.claim?.sku ?? null,
      email: report.claim?.email ?? null,
      features: report.claim?.features ?? [],
      issued_at: report.claim?.iat ?? null,
      expires_at: report.claim?.exp ?? null,
      message: report.message ?? null,
    });
  });

  // ── GET /api/license/export ──────────────────────────────────────
  //
  // The raw JWT, deliberately kept out of /status. It exists because the
  // licence carries no machine binding — the same token is valid on every
  // install the owner runs — so moving it to a second machine is a normal
  // thing to want, and the only way to do it was `docker exec … cat` or
  // digging through Application Support for a file whose path differs per
  // platform.
  //
  // Separate from /status on purpose: /status is polled by the settings pane
  // and its response ends up in logs and error reports, and a bearer token
  // good until 2036 should not ride along with every poll. This route is
  // reached only when someone asks for it, and the UI copies the result to
  // the clipboard rather than rendering it on screen.
  server.get("/api/license/export", (_req, res) => {
    const jwt = license.jwt();
    if (!jwt) {
      server.json(res, 404, { error: "No license installed" });
      return;
    }
    server.json(res, 200, { jwt });
  });

  // ── POST /api/license/set ────────────────────────────────────────
  // Body: { jwt: string }. Validates + persists atomically. Returns 400 on
  // any rejection with the typed `status` so the UI can render the right
  // call-to-action (renew vs paste-correct-key vs etc.).
  server.post("/api/license/set", async (req, res) => {
    try {
      const body = await server.parseBody<{ jwt?: string }>(req);
      if (typeof body.jwt !== "string" || body.jwt.trim().length === 0) {
        return server.json(res, 400, { status: "invalid", message: "Missing jwt field" });
      }
      const report = await license.set(body.jwt);
      log.info(`license: accepted ${report.claim?.sku} for ${report.claim?.email}`);
      server.json(res, 200, {
        status: report.status,
        sku: report.claim?.sku ?? null,
        email: report.claim?.email ?? null,
        features: report.claim?.features ?? [],
        expires_at: report.claim?.exp ?? null,
      });
    } catch (err) {
      const kind = err instanceof LicenseError ? err.kind : "invalid";
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`license: set rejected (${kind}): ${message}`);
      server.json(res, 400, { status: kind, message });
    }
  });

  // ── POST /api/license/clear ──────────────────────────────────────
  // Idempotent — calling it twice is fine. We don't return a 404 if there's
  // no license; the caller just wanted the file gone.
  server.post("/api/license/clear", async (_req, res) => {
    await license.clear();
    log.info("license: cleared");
    server.json(res, 200, { status: "none" });
  });
}
