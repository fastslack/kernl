/**
 * Google-sync dashboard RPC slice — OAuth status + auth start/revoke for the
 * Google integrations dashboard panel.
 *
 * Each one is an operation shared with its HTTP route (oauth-routes.ts binds
 * the same map): the dashboard calls them through `rpcOrCall`, WS first and
 * HTTP when the bridge is down, so both roads have to answer alike. They used
 * to be written twice; the RPC side answered failures as a resolved
 * `{ error }` (which the dashboard took for success) and read `force` from a
 * different place than the route.
 */

import {
  HttpError,
  rpcActionsFrom,
  type Operation,
  type SqliteDb,
  type KernelConfig,
  type RpcAction,
} from "@kernl/extension-sdk";
import { GoogleAuth } from "./auth.js";

export interface GoogleSyncDashboardRpcDeps {
  db: SqliteDb;
  config: KernelConfig;
}

export function googleSyncOperations(deps: GoogleSyncDashboardRpcDeps): Record<string, Operation> {
  const { db, config } = deps;
  const { clientId, clientSecret, callbackPort } = config.google;
  const dashboardPort = config.dashboard.port;

  function makeAuth(): GoogleAuth {
    return new GoogleAuth(db, clientId, clientSecret, callbackPort);
  }

  return {
    "google.status": async () => {
      const credentialsConfigured = !!(clientId && clientSecret);
      const auth = makeAuth();
      // Live health probe: refreshes if needed, records needs_reauth when the
      // refresh token is dead. So a revoked token surfaces as needs_reauth,
      // not a false "connected".
      const status = credentialsConfigured ? await auth.checkHealth() : "disconnected";
      const connected = status === "connected";
      const needsReauth = status === "needs_reauth";

      const lastSync: Record<string, string | null> = {};
      try {
        const rows = db.prepare("SELECT source, last_sync_at FROM google_sync_meta").all() as Array<{ source: string; last_sync_at: string }>;
        for (const row of rows) lastSync[row.source] = row.last_sync_at;
      } catch { /* table may not exist yet */ }

      // Token info without exposing the raw tokens.
      let tokenInfo: { expiresAt: string | null; scopes: string | null } = { expiresAt: null, scopes: null };
      try {
        const row = db.prepare("SELECT expires_at, scopes FROM google_tokens WHERE id = 1").get() as { expires_at: string; scopes: string } | undefined;
        if (row) tokenInfo = { expiresAt: row.expires_at, scopes: row.scopes };
      } catch { /* ignore */ }

      return {
        credentialsConfigured,
        status,                       // 'connected' | 'needs_reauth' | 'disconnected'
        authenticated: connected,     // back-compat: only true when actually working
        needsReauth,
        lastAuthError: needsReauth ? auth.lastAuthError() : null,
        // Offer a reconnect URL whenever we are not healthily connected.
        authUrl: credentialsConfigured && !connected
          ? auth.getAuthUrlForDashboard(dashboardPort)
          : null,
        tokenInfo,
        lastSync,
      };
    },

    // `force` (true, "1" or "true"; `?force=1` over HTTP) skips the "already
    // authenticated" shortcut — required for the re-login flow because
    // `isAuthenticated()` only checks that a row exists in google_tokens, not
    // whether the refresh_token still works. A revoked or expired
    // refresh_token leaves a stale row, and without `force` the user could
    // never re-auth.
    "google.auth.start": (input) => {
      if (!clientId || !clientSecret) {
        throw new HttpError(
          400,
          "Google credentials not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env (AI Providers → Google section).",
        );
      }
      const auth = makeAuth();
      const force = input.force === true || input.force === "1" || input.force === "true";
      if (!force && auth.isAuthenticated()) return { alreadyAuthenticated: true };
      return { authUrl: auth.getAuthUrlForDashboard(dashboardPort) };
    },

    "google.auth.revoke": () => {
      makeAuth().revoke();
      return { success: true };
    },
  };
}

export function googleSyncDashboardRpcActions(deps: GoogleSyncDashboardRpcDeps): RpcAction[] {
  return rpcActionsFrom(googleSyncOperations(deps));
}
