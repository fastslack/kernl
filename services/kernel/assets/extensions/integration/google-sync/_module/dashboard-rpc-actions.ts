/**
 * Google-sync dashboard RPC slice — OAuth status + auth start/revoke for the
 * Google integrations dashboard panel.
 */

import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { KernelConfig } from "../../../../../src/core/config.js";
import type { RpcAction } from "../../../../../src/core/mtw/rpc-handler.js";
import { GoogleAuth } from "./auth.js";

export interface GoogleSyncDashboardRpcDeps {
  db: SqliteDb;
  config: KernelConfig;
}

export function googleSyncDashboardRpcActions(deps: GoogleSyncDashboardRpcDeps): RpcAction[] {
  const { db, config } = deps;
  const { clientId, clientSecret, callbackPort } = config.google;
  const dashboardPort = config.dashboard.port;

  function makeAuth(): GoogleAuth {
    return new GoogleAuth(db, clientId, clientSecret, callbackPort);
  }

  return [
    {
      name: "google.status",
      handler: async () => {
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

        let tokenInfo: { expiresAt: string | null; scopes: string | null } = { expiresAt: null, scopes: null };
        try {
          const row = db.prepare("SELECT expires_at, scopes FROM google_tokens WHERE id = 1").get() as { expires_at: string; scopes: string } | undefined;
          if (row) tokenInfo = { expiresAt: row.expires_at, scopes: row.scopes };
        } catch { /* ignore */ }

        // Offer a reconnect URL whenever we are not healthily connected.
        const authUrl = credentialsConfigured && !connected
          ? auth.getAuthUrlForDashboard(dashboardPort)
          : null;

        return {
          credentialsConfigured,
          status,                       // 'connected' | 'needs_reauth' | 'disconnected'
          authenticated: connected,     // back-compat: only true when actually working
          needsReauth,
          lastAuthError: needsReauth ? auth.lastAuthError() : null,
          authUrl,
          tokenInfo,
          lastSync,
        };
      },
    },
    {
      name: "google.auth.start",
      // `args.force = true` skips the isAuthenticated() shortcut. Needed for
      // re-login: a revoked refresh_token still leaves a row in google_tokens,
      // so isAuthenticated() returns true and would block the redirect.
      handler: async (args) => {
        if (!clientId || !clientSecret) {
          return { error: "Google credentials not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env." };
        }
        const auth = makeAuth();
        const force = args?.force === true || args?.force === "1";
        if (!force && auth.isAuthenticated()) return { alreadyAuthenticated: true };
        const authUrl = auth.getAuthUrlForDashboard(dashboardPort);
        return { authUrl };
      },
    },
    {
      name: "google.auth.revoke",
      handler: async () => {
        try {
          makeAuth().revoke();
          return { success: true };
        } catch (err) {
          return { error: String(err) };
        }
      },
    },
  ];
}
