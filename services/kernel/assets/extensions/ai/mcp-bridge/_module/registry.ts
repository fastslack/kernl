/**
 * MCP connection registry — owns the live connections and their state.
 *
 * The store records what a server *is*; this decides what happens to it. One
 * state machine per server:
 *
 *   disabled ──enable──> connecting ──ok─────> connected
 *                            │                    │
 *                            ├──401, no token──> needs_auth ───login──┤
 *                            ├──401, has token─> needs_reauth ─login──┤
 *                            └──error──────────> failed ──retry──> connecting
 *
 * `needs_auth` and `needs_reauth` stay apart on purpose: one has never
 * connected, the other worked until its token died. They need different words
 * and a different button.
 *
 * Every transition that changes the tool set calls `republish`, which is what
 * makes a connection usable without restarting the kernel.
 */

import { log } from "../../../../../src/core/logger.js";
import type { ToolDefinition } from "../../../../../src/core/types.js";
import { connectMcpServer, type McpBridgeConnection } from "./client.js";
import { createRefreshTokenProvider, ReauthRequiredError } from "./oauth.js";
import type { McpStore, McpServerRow } from "./store.js";
import type { McpServerConfig } from "./types.js";

/** Backoff for automatic retries, in ms. Capped so a dead server stays quiet. */
const RETRY_BACKOFF_MS = [5_000, 15_000, 60_000, 300_000];

export interface McpRegistryOptions {
  store: McpStore;
  /**
   * Rebuilds the kernel's global tool surface. Called after any change to the
   * connected tool set — without it, chat and agents keep the catalog they
   * converted at boot and a freshly connected server is invisible.
   */
  republish?: () => void;
  /** Injectable for tests. */
  connect?: typeof connectMcpServer;
}

interface LiveConnection {
  serverId: string;
  connection: McpBridgeConnection;
}

export class McpRegistry {
  private readonly store: McpStore;
  private readonly republish: () => void;
  private readonly connectImpl: typeof connectMcpServer;
  private readonly live = new Map<string, LiveConnection>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly attempts = new Map<string, number>();
  private shuttingDown = false;

  constructor(opts: McpRegistryOptions) {
    this.store = opts.store;
    this.republish = opts.republish ?? (() => {});
    this.connectImpl = opts.connect ?? connectMcpServer;
  }

  /** Every tool from every connected server. This is what the kernel reads. */
  getTools(): ToolDefinition[] {
    const out: ToolDefinition[] = [];
    for (const { connection } of this.live.values()) out.push(...connection.tools);
    return out;
  }

  isConnected(serverId: string): boolean {
    return this.live.has(serverId);
  }

  /** Connects every enabled server. Failures are recorded, never thrown. */
  async connectAll(): Promise<void> {
    const servers = this.store.list().filter((s) => s.enabled);
    if (servers.length === 0) {
      log.info("MCP Bridge: no servers configured");
      return;
    }
    log.info(`MCP Bridge: connecting to ${servers.length} server(s)…`);
    await Promise.allSettled(servers.map((s) => this.connect(s.id, { silent: true })));
    log.info(
      `MCP Bridge: ready — ${this.getTools().length} external tools from ${this.live.size} server(s)`,
    );
    this.republish();
  }

  /**
   * Connect one server. Resolves either way: the outcome lives in the row's
   * status, because a failed connection is a state to display, not an
   * exception for a caller to swallow.
   */
  async connect(serverId: string, opts: { silent?: boolean } = {}): Promise<McpServerRow | null> {
    const server = this.store.get(serverId);
    if (!server) return null;

    this.clearRetry(serverId);
    await this.disconnect(serverId, { republish: false });

    if (!server.enabled) {
      this.store.setStatus(serverId, "disabled");
      return this.store.get(serverId);
    }

    this.store.setStatus(serverId, "connecting");

    try {
      const config = this.buildConfig(server);
      const connection = await this.connectImpl(config);
      this.live.set(serverId, { serverId, connection });
      this.store.replaceTools(
        serverId,
        connection.tools.map((t) => ({ name: t.name, description: t.description })),
      );
      this.store.setStatus(serverId, "connected");
      this.attempts.delete(serverId);
      if (!opts.silent) this.republish();
      return this.store.get(serverId);
    } catch (err) {
      this.recordFailure(server, err);
      if (!opts.silent) this.republish();
      this.scheduleRetry(serverId);
      return this.store.get(serverId);
    }
  }

  async disconnect(serverId: string, opts: { republish?: boolean } = {}): Promise<void> {
    this.clearRetry(serverId);
    const entry = this.live.get(serverId);
    if (!entry) return;
    this.live.delete(serverId);
    try {
      await entry.connection.disconnect();
    } catch {
      // A server that is already gone cannot be disconnected politely.
    }
    if (opts.republish !== false) this.republish();
  }

  /** Disconnect and mark disabled. Credentials survive. */
  async disable(serverId: string): Promise<void> {
    await this.disconnect(serverId, { republish: false });
    this.store.update(serverId, { enabled: false });
    this.store.setStatus(serverId, "disabled");
    this.republish();
  }

  async remove(serverId: string): Promise<boolean> {
    await this.disconnect(serverId, { republish: false });
    const removed = this.store.remove(serverId);
    this.republish();
    return removed;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const id of [...this.retryTimers.keys()]) this.clearRetry(id);
    await Promise.allSettled([...this.live.keys()].map((id) => this.disconnect(id, { republish: false })));
    this.live.clear();
  }

  // ── internals ─────────────────────────────────────────

  /**
   * Turns a stored row plus its credentials into a connect config. The
   * authorization_code case gets a live provider rather than a token string,
   * so a long-lived connection refreshes itself instead of dying at expiry.
   */
  private buildConfig(server: McpServerRow): McpServerConfig {
    const shared = {
      name: server.name,
      allowTools: server.allow_tools ?? undefined,
      denyTools: server.deny_tools ?? undefined,
    };

    if (server.transport === "stdio") {
      return {
        ...shared,
        type: "stdio",
        command: server.command ?? "",
        args: server.args ?? [],
        env: server.env ?? undefined,
      };
    }

    const creds = this.store.getCredentials(server.id);
    const base = {
      ...shared,
      type: "http" as const,
      url: server.url ?? "",
      headers: server.headers ?? undefined,
    };

    if (server.auth_mode === "authorization_code") {
      if (!creds?.token_url || !creds.client_id) {
        throw new ReauthRequiredError(server.name, "no client registration stored");
      }
      const serverId = server.id;
      const store = this.store;
      return {
        ...base,
        tokenProvider: createRefreshTokenProvider(
          {
            tokenUrl: creds.token_url,
            clientId: creds.client_id,
            clientSecret: creds.client_secret,
            load: () => {
              const c = store.getCredentials(serverId);
              return c
                ? { access_token: c.access_token, refresh_token: c.refresh_token, expires_at: c.expires_at }
                : null;
            },
            save: (tokens) => store.saveCredentials(serverId, tokens),
          },
          server.name,
        ),
      };
    }

    if (server.auth_mode === "client_credentials") {
      if (!creds?.token_url || !creds.client_id || !creds.client_secret) {
        throw new Error(`MCP Bridge [${server.name}]: client_credentials needs tokenUrl, clientId and clientSecret`);
      }
      return {
        ...base,
        oauth: {
          tokenUrl: creds.token_url,
          clientId: creds.client_id,
          clientSecret: creds.client_secret,
          scope: creds.scope ?? undefined,
        },
      };
    }

    if (server.auth_mode === "token") {
      return { ...base, token: creds?.access_token ?? undefined };
    }

    return base;
  }

  /**
   * Maps a thrown error onto the status the operator should see. The
   * distinction that matters: a 401 when we hold a token means the token died
   * (`needs_reauth`); a 401 when we hold none means we never logged in
   * (`needs_auth`). Everything else is `failed` and worth retrying.
   */
  private recordFailure(server: McpServerRow, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);

    if (err instanceof ReauthRequiredError) {
      const creds = this.store.getCredentials(server.id);
      const everHadToken = Boolean(creds?.refresh_token || creds?.access_token);
      this.store.setStatus(server.id, everHadToken ? "needs_reauth" : "needs_auth", message);
      log.warn(`MCP Bridge: "${server.name}" needs authentication — ${message}`);
      return;
    }

    if (/\b401\b|unauthor/i.test(message)) {
      const creds = this.store.getCredentials(server.id);
      const everHadToken = Boolean(creds?.access_token || creds?.refresh_token);
      this.store.setStatus(
        server.id,
        everHadToken ? "needs_reauth" : "needs_auth",
        everHadToken ? "The stored token was rejected." : "This server requires authentication.",
      );
      log.warn(`MCP Bridge: "${server.name}" rejected our credentials`);
      return;
    }

    this.store.setStatus(server.id, "failed", message);
    log.error(`MCP Bridge: failed to connect to "${server.name}": ${message}`);
  }

  /**
   * Retries only transient failures. `needs_auth` and `needs_reauth` are waiting
   * on a human, so retrying them just burns requests against an endpoint that
   * will keep saying no.
   */
  private scheduleRetry(serverId: string): void {
    if (this.shuttingDown) return;
    const server = this.store.get(serverId);
    if (!server || server.status !== "failed" || !server.enabled) return;

    const attempt = this.attempts.get(serverId) ?? 0;
    if (attempt >= RETRY_BACKOFF_MS.length) return;
    this.attempts.set(serverId, attempt + 1);

    const delay = RETRY_BACKOFF_MS[attempt];
    const timer = setTimeout(() => {
      this.retryTimers.delete(serverId);
      void this.connect(serverId);
    }, delay);
    // Never hold the process open for a retry.
    (timer as unknown as { unref?: () => void }).unref?.();
    this.retryTimers.set(serverId, timer);
  }

  private clearRetry(serverId: string): void {
    const timer = this.retryTimers.get(serverId);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(serverId);
  }
}
