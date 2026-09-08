/**
 * OAuth routes for connecting an MCP server from the dashboard.
 *
 *   GET  /auth/mcp/callback     — receive the code, exchange it, close the tab
 *   POST /api/mcp/auth/revoke   — drop the tokens and take the server down
 *
 * Starting a login is the `mcp.auth.start` RPC rather than a route here: the
 * browser supplies its own origin for the redirect, which no server-side
 * setting could get right behind a reverse proxy. `buildAuthorizationUrl`
 * below is the shared, I/O-free half.
 *
 * PKCE (S256) throughout. The verifier never leaves the database and the
 * state is single-use, so a replayed callback cannot buy a second exchange.
 */

import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { KernelHttpServer } from "../../../../../src/core/http-server.js";
import { log } from "../../../../../src/core/logger.js";
import type { McpStore } from "./store.js";
import type { McpRegistry } from "./registry.js";

/** RFC 7636 verifier: 43–128 chars of unreserved base64url. */
export function createCodeVerifier(): string {
  return randomBytes(64).toString("base64url").slice(0, 128);
}

export function codeChallengeS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * Builds an authorization URL with a fresh PKCE pair. Returns the state and
 * verifier so the caller can persist them — this function deliberately does no
 * I/O, which is what lets both the RPC action and the routes share it.
 */
export function buildAuthorizationUrl(opts: {
  authorizeUrl: string;
  clientId: string;
  redirectUri: string;
  scope?: string | null;
}): { url: string; state: string; verifier: string } {
  const verifier = createCodeVerifier();
  const state = randomBytes(24).toString("base64url");
  const url = new URL(opts.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallengeS256(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  if (opts.scope) url.searchParams.set("scope", opts.scope);
  return { url: url.toString(), state, verifier };
}

export interface McpOAuthDeps {
  store: McpStore;
  registry: McpRegistry;
  /** Public origin the browser will come back to, e.g. http://127.0.0.1:3086 */
  publicOrigin: () => string;
}

/** Small self-closing page so the operator is not left staring at raw JSON. */
function closingPage(title: string, detail: string, ok: boolean): string {
  const colour = ok ? "#3DD68C" : "#F04770";
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="margin:0;display:grid;place-items:center;height:100vh;background:#07080C;color:#E0E2EA;font-family:system-ui,sans-serif">
<div style="text-align:center;max-width:32rem;padding:2rem">
  <div style="font-size:2rem;color:${colour};margin-bottom:.5rem">${ok ? "&#10003;" : "&#10007;"}</div>
  <h1 style="font-size:1.125rem;margin:0 0 .5rem">${title}</h1>
  <p style="color:#8A8FA8;margin:0 0 1.5rem;line-height:1.5">${detail}</p>
  <p style="color:#4A4F6A;font-size:.875rem">You can close this tab.</p>
</div>
<script>setTimeout(function(){window.close()},2500)</script>`;
}

export function registerMcpOAuthRoutes(server: KernelHttpServer, deps: McpOAuthDeps): void {
  const { store, registry } = deps;
  const redirectUri = (): string => `${deps.publicOrigin().replace(/\/$/, "")}/auth/mcp/callback`;

  const sendHtml = (res: ServerResponse, status: number, html: string): void => {
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  };

  const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    try {
      return ((await server.readJsonBody(req)) ?? {}) as Record<string, unknown>;
    } catch {
      return {};
    }
  };

  // ── GET /auth/mcp/callback ──────────────────────────────
  server.get("/auth/mcp/callback", async (req, res) => {
    const url = new URL(req.url ?? "/", deps.publicOrigin());
    const error = url.searchParams.get("error");

    if (error) {
      sendHtml(res, 400, closingPage("Authorization declined", url.searchParams.get("error_description") ?? error, false));
      return;
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      sendHtml(res, 400, closingPage("Missing code", "The provider returned no authorization code.", false));
      return;
    }

    // Single-use: consuming here means a replayed callback finds nothing.
    const pending = store.consumeOAuthState(state);
    if (!pending) {
      sendHtml(res, 400, closingPage("Expired link", "That login attempt has expired. Start it again from the dashboard.", false));
      return;
    }

    const srv = store.get(pending.server_id);
    const creds = store.getCredentials(pending.server_id);
    if (!srv || !creds?.token_url || !creds.client_id) {
      sendHtml(res, 400, closingPage("Server is gone", "It was removed while you were signing in.", false));
      return;
    }

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: pending.redirect_uri,
      client_id: creds.client_id,
      code_verifier: pending.code_verifier,
    });
    if (creds.client_secret) body.set("client_secret", creds.client_secret);

    try {
      const response = await fetch(creds.token_url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: body.toString(),
      });
      const text = await response.text();
      if (!response.ok) {
        // The provider's own words help far more than a generic failure, and
        // this body never carries our secret back.
        store.setStatus(srv.id, "needs_auth", `Token exchange failed (${response.status}): ${text.slice(0, 200)}`);
        sendHtml(res, 400, closingPage("Could not complete sign-in", text.slice(0, 300), false));
        return;
      }

      const data = JSON.parse(text) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
      };
      if (!data.access_token) {
        store.setStatus(srv.id, "needs_auth", "Token endpoint returned no access_token");
        sendHtml(res, 400, closingPage("No token returned", "The provider accepted the code but sent no token.", false));
        return;
      }

      store.saveCredentials(srv.id, {
        access_token: data.access_token,
        refresh_token: data.refresh_token ?? null,
        expires_at: data.expires_in
          ? new Date(Date.now() + data.expires_in * 1000).toISOString()
          : null,
        scope: data.scope ?? creds.scope,
      });

      log.info(`MCP Bridge: "${srv.name}" authorized`);
      // Connect straight away so the tab closing means the thing works.
      void registry.connect(srv.id);

      sendHtml(res, 200, closingPage(`Connected to ${srv.name}`, "Its tools are now available to chat and your agents.", true));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      store.setStatus(srv.id, "needs_auth", message);
      sendHtml(res, 500, closingPage("Sign-in failed", message, false));
    }
  });

  // ── POST /api/mcp/auth/revoke ───────────────────────────
  server.post("/api/mcp/auth/revoke", async (req, res) => {
    const body = (await readBody(req)) as { server_id?: string };
    const srv = body.server_id ? store.get(body.server_id) : null;
    if (!srv) {
      server.json(res, 404, { error: "Server not found" });
      return;
    }
    await registry.disconnect(srv.id);
    store.clearTokens(srv.id);
    store.setStatus(srv.id, "needs_auth", "Signed out.");
    server.json(res, 200, { success: true });
  });
}
