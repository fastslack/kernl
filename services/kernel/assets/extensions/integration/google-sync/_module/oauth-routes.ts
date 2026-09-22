/**
 * Google OAuth routes for the dashboard HTTP server.
 *
 * GET  /api/google/status       — Auth state + credential check + last sync info
 * POST /api/google/auth/start   — Returns the Google auth URL (redirect to Google)
 * GET  /auth/google/callback    — OAuth redirect handler (Google sends code here)
 * POST /api/google/revoke       — Revoke stored tokens
 */

import { type KernelHttpServer, type KernelConfig, type SqliteDb, log } from "@kernl/extension-sdk";
import { GoogleAuth } from "./auth.js";
import { googleSyncOperations } from "./dashboard-rpc-actions.js";

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

  // ── Operations shared with the WS RPC (dashboard-rpc-actions.ts) ──
  // GET /api/google/status, POST /api/google/auth/start (`?force=1`),
  // POST /api/google/revoke: the dashboard reaches them through rpcOrCall,
  // WS first and HTTP when the bridge is down, so both roads run one function.
  const op = googleSyncOperations({ db, config });
  server.operation("GET", "/api/google/status", op["google.status"]);
  server.operation("POST", "/api/google/auth/start", op["google.auth.start"]);
  server.operation("POST", "/api/google/revoke", op["google.auth.revoke"]);

  // ── GET /auth/google/callback ────────────────────────────
  // Google redirects here after user grants permissions.
  // When the kernel HTTP port (serving this route) differs from the user-facing
  // dashboard URL (e.g. nginx on a different port in Docker), post-auth redirects
  // must use an absolute URL so the browser lands on the actual dashboard.
  const publicBase = (process.env.DASHBOARD_PUBLIC_URL ?? "").replace(/\/$/, "");
  const loc = (path: string) => publicBase ? `${publicBase}${path}` : path;

  // Stays a raw handler: it answers with 302 redirects, not JSON.
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

  log.info("Google OAuth routes registered (/api/google/*, /auth/google/callback)");
}
