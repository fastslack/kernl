/**
 * Google OAuth routes for the dashboard HTTP server.
 *
 * GET  /api/google/status       — Auth state + credential check + last sync info
 * POST /api/google/auth/start   — Returns the Google auth URL (redirect to Google)
 * GET  /auth/google/callback    — OAuth redirect handler (Google sends code here)
 * POST /api/google/revoke       — Revoke stored tokens
 */

import type { KernelHttpServer } from "../../../../../src/core/http-server.js";
import type { KernelConfig } from "../../../../../src/core/config.js";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { GoogleAuth } from "./auth.js";
import { log } from "../../../../../src/core/logger.js";

export function registerGoogleOAuthRoutes(
  server: KernelHttpServer,
  db: SqliteDb,
  config: KernelConfig,
): void {
  const { clientId, clientSecret, callbackPort } = config.google;
  const dashboardPort = config.dashboard.port;

  function makeAuth(): GoogleAuth {
    return new GoogleAuth(db, clientId, clientSecret, callbackPort);
  }

  // ── GET /api/google/status ──────────────────────────────
  server.get("/api/google/status", async (_req, res) => {
    const credentialsConfigured = !!(clientId && clientSecret);
    const auth = makeAuth();
    // Live health probe — a dead refresh token surfaces as needs_reauth, not a
    // false "connected" (matches the google.status RPC).
    const status = credentialsConfigured ? await auth.checkHealth() : "disconnected";
    const connected = status === "connected";
    const needsReauth = status === "needs_reauth";

    // Read last sync timestamps
    let lastSync: Record<string, string | null> = {};
    try {
      const rows = db.prepare("SELECT source, last_sync_at FROM google_sync_meta").all() as Array<{ source: string; last_sync_at: string }>;
      for (const row of rows) lastSync[row.source] = row.last_sync_at;
    } catch { /* table may not exist yet */ }

    // Read token info (without exposing raw tokens)
    let tokenInfo: { expiresAt: string | null; scopes: string | null } = { expiresAt: null, scopes: null };
    try {
      const row = db.prepare("SELECT expires_at, scopes FROM google_tokens WHERE id = 1").get() as { expires_at: string; scopes: string } | undefined;
      if (row) tokenInfo = { expiresAt: row.expires_at, scopes: row.scopes };
    } catch { /* ignore */ }

    server.json(res, 200, {
      credentialsConfigured,
      status,
      authenticated: connected,
      needsReauth,
      lastAuthError: needsReauth ? auth.lastAuthError() : null,
      authUrl: credentialsConfigured && !connected
        ? auth.getAuthUrlForDashboard(dashboardPort)
        : null,
      tokenInfo,
      lastSync,
    });
  });

  // ── POST /api/google/auth/start ─────────────────────────
  // `?force=1` skips the "already authenticated" shortcut — required for the
  // re-login flow because `isAuthenticated()` only checks if a row exists in
  // google_tokens, not whether the refresh_token still works. A revoked or
  // expired refresh_token leaves a stale row in DB, and without `force` the
  // endpoint would short-circuit and the user could never re-auth.
  server.post("/api/google/auth/start", (req, res) => {
    if (!clientId || !clientSecret) {
      server.json(res, 400, {
        error: "Google credentials not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env (AI Providers → Google section).",
      });
      return;
    }
    const auth = makeAuth();
    const url = new URL(req.url ?? "/", `http://localhost:${dashboardPort}`);
    const force = url.searchParams.get("force") === "1" || url.searchParams.get("force") === "true";
    if (!force && auth.isAuthenticated()) {
      server.json(res, 200, { alreadyAuthenticated: true });
      return;
    }
    const authUrl = auth.getAuthUrlForDashboard(dashboardPort);
    server.json(res, 200, { authUrl });
  });

  // ── GET /auth/google/callback ────────────────────────────
  // Google redirects here after user grants permissions.
  // When the kernel HTTP port (serving this route) differs from the user-facing
  // dashboard URL (e.g. nginx on a different port in Docker), post-auth redirects
  // must use an absolute URL so the browser lands on the actual dashboard.
  const publicBase = (process.env.DASHBOARD_PUBLIC_URL ?? "").replace(/\/$/, "");
  const loc = (path: string) => publicBase ? `${publicBase}${path}` : path;

  server.get("/auth/google/callback", async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${dashboardPort}`);
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");

    if (error) {
      log.warn(`Google OAuth denied: ${error}`);
      res.writeHead(302, { Location: loc(`/?google_auth=denied&error=${encodeURIComponent(error)}`) });
      res.end();
      return;
    }

    if (!code) {
      res.writeHead(302, { Location: loc("/?google_auth=error&error=missing_code") });
      res.end();
      return;
    }

    try {
      const auth = makeAuth();
      await auth.handleDashboardCallback(code, dashboardPort);
      log.info("Google OAuth: tokens saved via dashboard callback");
      res.writeHead(302, { Location: loc("/?google_auth=success") });
      res.end();
    } catch (err) {
      log.error("Google OAuth callback error", err);
      res.writeHead(302, { Location: loc(`/?google_auth=error&error=${encodeURIComponent(String(err))}`) });
      res.end();
    }
  });

  // ── POST /api/google/revoke ──────────────────────────────
  server.post("/api/google/revoke", (_req, res) => {
    try {
      makeAuth().revoke();
      server.json(res, 200, { success: true });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  log.info("Google OAuth routes registered (/api/google/*, /auth/google/callback)");
}
