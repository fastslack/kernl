/**
 * MCP Bridge — OAuth 2 client-credentials token provider
 *
 * The bridge originally accepted only a static `token`, which is fine for a
 * server that hands out long-lived keys and useless for one behind OAuth 2.1:
 * the token expires, the transport keeps sending the dead header, and every
 * tool call fails with 401 until a human edits MCP_BRIDGE_SERVERS and restarts
 * the kernel. Worse, it fails silently — the tools stay listed, they just stop
 * working.
 *
 * This mints tokens with the `client_credentials` grant (no browser redirect,
 * so it works headless) and hands out a cached one until it is close to
 * expiring. `getToken(true)` forces a fresh mint, which is what the transport's
 * 401 retry uses when a token is revoked before its stated expiry.
 */

import { log } from "../../../../../src/core/logger.js";
import type { McpOAuthConfig } from "./types.js";

/** Renew this long before the stated expiry unless the config overrides it. */
const DEFAULT_REFRESH_SKEW_SECONDS = 60;

/**
 * Fallback lifetime for a server that omits `expires_in`. Deliberately short:
 * re-minting a still-valid token is cheap, while trusting a guessed-long
 * lifetime means silent 401s for however long we guessed wrong.
 */
const FALLBACK_TTL_SECONDS = 300;

export interface TokenProvider {
  /**
   * Returns a usable bearer token, minting one only when the cached token is
   * missing or near expiry. Pass `force` to discard the cache first.
   */
  getToken(force?: boolean): Promise<string>;
}

interface TokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
}

export function createClientCredentialsProvider(
  config: McpOAuthConfig,
  serverName: string,
): TokenProvider {
  let accessToken: string | null = null;
  let expiresAtMs = 0;
  // Concurrent tool calls all miss the cache at the same moment; without this
  // they would each POST the token endpoint and race to overwrite the cache.
  let inFlight: Promise<string> | null = null;

  const skewMs =
    (config.refreshSkewSeconds ?? DEFAULT_REFRESH_SKEW_SECONDS) * 1000;

  async function mint(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.clientId,
      client_secret: config.clientSecret,
    });
    if (config.scope) body.set("scope", config.scope);

    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      // The body can echo the client_secret back on some servers — keep it out
      // of the logs and out of the thrown message.
      throw new Error(
        `MCP Bridge [${serverName}]: token request failed (${response.status} ${response.statusText})${
          text ? `: ${text.slice(0, 200)}` : ""
        }`,
      );
    }

    const data = (await response.json()) as TokenResponse;
    if (!data.access_token) {
      throw new Error(
        `MCP Bridge [${serverName}]: token endpoint returned no access_token`,
      );
    }

    const ttlSeconds = data.expires_in ?? FALLBACK_TTL_SECONDS;
    const ttlMs = Math.max(ttlSeconds, 0) * 1000;
    accessToken = data.access_token;
    // A token shorter-lived than the skew would otherwise land permanently
    // inside its own refresh window and re-mint on every single request, so
    // clamp the skew to half the lifetime: still refreshed early, but the
    // token gets used. A server saying expires_in: 0 means exactly that, and
    // clamping keeps that honest — zero lifetime, re-mint next call.
    const effectiveSkewMs = Math.min(skewMs, ttlMs / 2);
    expiresAtMs = Date.now() + ttlMs - effectiveSkewMs;

    log.info(
      `MCP Bridge [${serverName}]: minted access token (expires in ${ttlSeconds}s)`,
    );
    return accessToken;
  }

  return {
    async getToken(force = false): Promise<string> {
      if (force) {
        accessToken = null;
        expiresAtMs = 0;
      }

      if (accessToken && Date.now() < expiresAtMs) return accessToken;
      if (inFlight) return inFlight;

      inFlight = mint().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}

// ── authorization_code ────────────────────────────────────

export interface StoredTokens {
  access_token: string | null;
  refresh_token: string | null;
  /** ISO-8601, or null when the server never said. */
  expires_at: string | null;
}

export interface RefreshProviderDeps {
  tokenUrl: string;
  clientId: string;
  /** Public clients (PKCE, no secret) pass null. */
  clientSecret: string | null;
  /** Read the current tokens. Called on every cache miss, never cached itself. */
  load(): StoredTokens | null;
  /** Persist rotated tokens. Refresh tokens rotate on many servers. */
  save(tokens: StoredTokens): void;
  refreshSkewSeconds?: number;
}

/**
 * Thrown when the refresh token is gone or rejected. The caller must surface
 * `needs_reauth` rather than retrying: no amount of retrying revives a refresh
 * token the authorization server has already invalidated, and hammering it is
 * how an account gets rate-limited.
 */
export class ReauthRequiredError extends Error {
  constructor(serverName: string, detail: string) {
    super(`MCP Bridge [${serverName}]: re-authentication required — ${detail}`);
    this.name = "ReauthRequiredError";
  }
}

/**
 * Token provider for the authorization_code grant.
 *
 * Serves the stored access token until it is near expiry, then spends the
 * refresh token. Unlike the client-credentials provider it cannot mint from
 * nothing: without a refresh token the only cure is the operator logging in
 * again, so it says so instead of failing vaguely.
 */
export function createRefreshTokenProvider(
  deps: RefreshProviderDeps,
  serverName: string,
): TokenProvider {
  let inFlight: Promise<string> | null = null;
  const skewMs = (deps.refreshSkewSeconds ?? DEFAULT_REFRESH_SKEW_SECONDS) * 1000;

  function usable(tokens: StoredTokens | null): string | null {
    if (!tokens?.access_token) return null;
    if (!tokens.expires_at) return tokens.access_token;
    const expiresAt = Date.parse(tokens.expires_at);
    if (Number.isNaN(expiresAt)) return tokens.access_token;
    return Date.now() < expiresAt - skewMs ? tokens.access_token : null;
  }

  async function refresh(): Promise<string> {
    const tokens = deps.load();
    if (!tokens?.refresh_token) {
      throw new ReauthRequiredError(serverName, "no refresh token stored");
    }

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: deps.clientId,
    });
    if (deps.clientSecret) body.set("client_secret", deps.clientSecret);

    const response = await fetch(deps.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      // 400/401 from a token endpoint means the grant is dead, not that the
      // network hiccuped — no retry will fix it.
      if (response.status === 400 || response.status === 401) {
        throw new ReauthRequiredError(serverName, `refresh rejected (${response.status})`);
      }
      throw new Error(
        `MCP Bridge [${serverName}]: refresh failed (${response.status} ${response.statusText})${
          text ? `: ${text.slice(0, 200)}` : ""
        }`,
      );
    }

    const data = (await response.json()) as TokenResponse & { refresh_token?: string };
    if (!data.access_token) {
      throw new ReauthRequiredError(serverName, "refresh returned no access_token");
    }

    const ttlSeconds = data.expires_in ?? FALLBACK_TTL_SECONDS;
    deps.save({
      access_token: data.access_token,
      // Rotation: keep the new one when offered, otherwise the old one stays
      // valid. Overwriting with undefined would lock the operator out.
      refresh_token: data.refresh_token ?? tokens.refresh_token,
      expires_at: new Date(Date.now() + Math.max(ttlSeconds, 0) * 1000).toISOString(),
    });

    log.info(`MCP Bridge [${serverName}]: refreshed access token (expires in ${ttlSeconds}s)`);
    return data.access_token;
  }

  return {
    async getToken(force = false): Promise<string> {
      if (!force) {
        const current = usable(deps.load());
        if (current) return current;
      }
      if (inFlight) return inFlight;
      inFlight = refresh().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}
