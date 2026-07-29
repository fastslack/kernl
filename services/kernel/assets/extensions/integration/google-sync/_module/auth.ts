import { createServer, type Server } from "node:http";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { GoogleTokens } from "../../../../../src/core/integrations/google-types.js";
import { isoNow } from "../../../../../src/core/helpers.js";
import { log } from "../../../../../src/core/logger.js";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

const SCOPES = [
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/contacts.other.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/tasks.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
];

export class GoogleAuth {
  private callbackServer: Server | null = null;

  constructor(
    private db: SqliteDb,
    private clientId: string,
    private clientSecret: string,
    private callbackPort: number,
  ) {}

  private get redirectUri(): string {
    return `http://localhost:${this.callbackPort}/callback`;
  }

  getAuthUrl(): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: "code",
      scope: SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
    });
    return `${GOOGLE_AUTH_URL}?${params.toString()}`;
  }

  /** Build an auth URL that redirects to the main dashboard server instead of the ephemeral port */
  getAuthUrlForDashboard(dashboardPort: number): string {
    const redirectUri = `http://localhost:${dashboardPort}/auth/google/callback`;
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
    });
    return `${GOOGLE_AUTH_URL}?${params.toString()}`;
  }

  /** Exchange an OAuth code received via the dashboard callback route */
  async handleDashboardCallback(code: string, dashboardPort: number): Promise<void> {
    const redirectUri = `http://localhost:${dashboardPort}/auth/google/callback`;
    const body = new URLSearchParams({
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });

    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Token exchange failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope: string;
    };

    if (!data.refresh_token) {
      throw new Error("No refresh_token received. Revoke app access in Google Account settings and try again.");
    }

    const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
    this.saveTokens({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: expiresAt,
      scopes: data.scope,
      updated_at: isoNow(),
    });

    log.info("Google OAuth tokens saved via dashboard callback");
  }

  startCallbackServer(): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.clientId || !this.clientSecret) {
        reject(new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env"));
        return;
      }

      this.callbackServer = createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", `http://localhost:${this.callbackPort}`);

        if (url.pathname !== "/callback") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(`<h2>Authorization denied</h2><p>${error}</p>`);
          this.stopCallbackServer();
          return;
        }

        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end("<h2>Missing authorization code</h2>");
          return;
        }

        try {
          await this.exchangeCode(code);
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            "<h2>Kernl authorized!</h2><p>You can close this tab and return to your terminal.</p>",
          );
        } catch (err) {
          res.writeHead(500, { "Content-Type": "text/html" });
          res.end(`<h2>Token exchange failed</h2><p>${String(err)}</p>`);
        } finally {
          this.stopCallbackServer();
        }
      });

      this.callbackServer.listen(this.callbackPort, () => {
        const authUrl = this.getAuthUrl();
        log.info(`OAuth callback server listening on port ${this.callbackPort}`);
        resolve(authUrl);
      });

      this.callbackServer.on("error", (err) => {
        reject(new Error(`Failed to start callback server: ${err.message}`));
      });
    });
  }

  private stopCallbackServer(): void {
    if (this.callbackServer) {
      this.callbackServer.close();
      this.callbackServer = null;
    }
  }

  private async exchangeCode(code: string): Promise<void> {
    const body = new URLSearchParams({
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirectUri,
      grant_type: "authorization_code",
    });

    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Token exchange failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope: string;
    };

    if (!data.refresh_token) {
      throw new Error("No refresh_token received. Revoke app access in Google Account settings and try again.");
    }

    const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
    this.saveTokens({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: expiresAt,
      scopes: data.scope,
      updated_at: isoNow(),
    });

    log.info("Google OAuth tokens saved successfully");
  }

  async getAccessToken(): Promise<string> {
    const tokens = this.loadTokens();
    if (!tokens) {
      throw new Error("Not authenticated. Run kernel_google_auth first.");
    }

    // Token still valid (with 60s buffer)
    if (new Date(tokens.expires_at).getTime() > Date.now() + 60_000) {
      return tokens.access_token;
    }

    // Refresh
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: tokens.refresh_token,
      grant_type: "refresh_token",
    });

    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      // Persist the broken state so the dashboard can surface a reconnect
      // prompt (token present but dead → needs_reauth, not "connected").
      this.markNeedsReauth(`Token refresh failed (${response.status}): ${text}`);
      throw new Error(
        `Token refresh failed (${response.status}): ${text}. Run kernel_google_auth to re-authenticate.`,
      );
    }

    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };

    const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
    this.saveTokens({
      access_token: data.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: expiresAt,
      scopes: tokens.scopes,
      updated_at: isoNow(),
    });

    return data.access_token;
  }

  isAuthenticated(): boolean {
    return this.loadTokens() != null;
  }

  /** Real connection health, distinct from mere token presence. */
  getStatus(): "connected" | "needs_reauth" | "disconnected" {
    const row = this.db
      .prepare("SELECT needs_reauth_at FROM google_tokens WHERE id = 1")
      .get() as { needs_reauth_at: string | null } | undefined;
    if (!row) return "disconnected";
    return row.needs_reauth_at ? "needs_reauth" : "connected";
  }

  /** Last refresh/auth error message, if any. */
  lastAuthError(): string | null {
    const row = this.db
      .prepare("SELECT last_auth_error FROM google_tokens WHERE id = 1")
      .get() as { last_auth_error: string | null } | undefined;
    return row?.last_auth_error ?? null;
  }

  /** Flag the stored token as dead (refresh failed). */
  markNeedsReauth(error: string): void {
    this.db
      .prepare("UPDATE google_tokens SET needs_reauth_at = ?, last_auth_error = ? WHERE id = 1")
      .run(isoNow(), error.slice(0, 500));
  }

  /** Clear the dead-token flag (after a successful refresh or re-auth). */
  clearReauth(): void {
    this.db
      .prepare("UPDATE google_tokens SET needs_reauth_at = NULL, last_auth_error = NULL WHERE id = 1")
      .run();
  }

  /**
   * Live health probe: returns the real status, refreshing the token if needed.
   * A dead refresh token is caught and recorded as needs_reauth (never throws).
   */
  async checkHealth(): Promise<"connected" | "needs_reauth" | "disconnected"> {
    if (!this.loadTokens()) return "disconnected";
    try {
      await this.getAccessToken();
      return this.getStatus();
    } catch {
      return this.getStatus(); // getAccessToken already marked needs_reauth
    }
  }

  revoke(): void {
    this.db.prepare("DELETE FROM google_tokens WHERE id = 1").run();
    log.info("Google tokens revoked");
  }

  private loadTokens(): GoogleTokens | undefined {
    return this.db.prepare("SELECT * FROM google_tokens WHERE id = 1").get() as
      | GoogleTokens
      | undefined;
  }

  private saveTokens(tokens: GoogleTokens): void {
    this.db
      .prepare(
        `INSERT INTO google_tokens (id, access_token, refresh_token, expires_at, scopes, updated_at)
         VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           expires_at = excluded.expires_at,
           scopes = excluded.scopes,
           updated_at = excluded.updated_at,
           needs_reauth_at = NULL,
           last_auth_error = NULL`,
      )
      .run(
        tokens.access_token,
        tokens.refresh_token,
        tokens.expires_at,
        tokens.scopes,
        tokens.updated_at,
      );
  }
}
