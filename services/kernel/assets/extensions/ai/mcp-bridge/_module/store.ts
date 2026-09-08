/**
 * MCP Bridge store — servers, credentials and the discovery cache.
 *
 * The one rule this file exists to enforce: a server record and its secrets are
 * never carried by the same object. `McpServerRow` is what every list, status
 * and RPC response returns, and it structurally cannot hold a token. Reading a
 * credential takes a deliberate call to `getCredentials`, which only the
 * connect path and the OAuth routes make.
 *
 * Everything here is synchronous SQLite and free of opinion — deciding whether
 * to connect, retry or re-auth belongs to the registry.
 */

import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { newId, isoNow } from "../../../../../src/core/helpers.js";
import type { McpServerConfig } from "./types.js";

export type McpTransport = "http" | "stdio";
export type McpAuthMode = "none" | "token" | "client_credentials" | "authorization_code";
export type McpStatus =
  | "disabled"
  | "connecting"
  | "connected"
  | "needs_auth"
  | "needs_reauth"
  | "failed";

/** Safe to log, safe to return over RPC, safe to render. Holds no secret. */
export interface McpServerRow {
  id: string;
  name: string;
  transport: McpTransport;
  url: string | null;
  command: string | null;
  args: string[] | null;
  env: Record<string, string> | null;
  auth_mode: McpAuthMode;
  headers: Record<string, string> | null;
  allow_tools: string[] | null;
  deny_tools: string[] | null;
  enabled: boolean;
  status: McpStatus;
  last_error: string | null;
  last_connected_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Never leaves this module except toward the connect path and OAuth routes. */
export interface McpCredentials {
  server_id: string;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: string | null;
  client_id: string | null;
  client_secret: string | null;
  token_url: string | null;
  authorize_url: string | null;
  scope: string | null;
}

export interface McpToolRow {
  server_id: string;
  name: string;
  description: string | null;
  discovered_at: string;
}

export interface McpServerInput {
  name: string;
  transport: McpTransport;
  url?: string | null;
  command?: string | null;
  args?: string[] | null;
  env?: Record<string, string> | null;
  auth_mode?: McpAuthMode;
  headers?: Record<string, string> | null;
  allow_tools?: string[] | null;
  deny_tools?: string[] | null;
  enabled?: boolean;
}

function parseJson<T>(raw: unknown): T | null {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function toJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

interface RawServer {
  id: string;
  name: string;
  transport: string;
  url: string | null;
  command: string | null;
  args_json: string | null;
  env_json: string | null;
  auth_mode: string;
  headers_json: string | null;
  allow_tools_json: string | null;
  deny_tools_json: string | null;
  enabled: number;
  status: string;
  last_error: string | null;
  last_connected_at: string | null;
  created_at: string;
  updated_at: string;
}

function hydrate(row: RawServer): McpServerRow {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport as McpTransport,
    url: row.url,
    command: row.command,
    args: parseJson<string[]>(row.args_json),
    env: parseJson<Record<string, string>>(row.env_json),
    auth_mode: row.auth_mode as McpAuthMode,
    headers: parseJson<Record<string, string>>(row.headers_json),
    allow_tools: parseJson<string[]>(row.allow_tools_json),
    deny_tools: parseJson<string[]>(row.deny_tools_json),
    enabled: row.enabled === 1,
    status: row.status as McpStatus,
    last_error: row.last_error,
    last_connected_at: row.last_connected_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class McpStore {
  constructor(private readonly db: SqliteDb) {}

  // ── Servers ───────────────────────────────────────────

  list(): McpServerRow[] {
    return (
      this.db.prepare("SELECT * FROM mcp_servers ORDER BY name").all() as RawServer[]
    ).map(hydrate);
  }

  get(id: string): McpServerRow | null {
    const row = this.db.prepare("SELECT * FROM mcp_servers WHERE id = ?").get(id) as
      | RawServer
      | undefined;
    return row ? hydrate(row) : null;
  }

  getByName(name: string): McpServerRow | null {
    const row = this.db.prepare("SELECT * FROM mcp_servers WHERE name = ?").get(name) as
      | RawServer
      | undefined;
    return row ? hydrate(row) : null;
  }

  create(input: McpServerInput): McpServerRow {
    const id = newId();
    const now = isoNow();
    this.db
      .prepare(
        `INSERT INTO mcp_servers (
           id, name, transport, url, command, args_json, env_json, auth_mode,
           headers_json, allow_tools_json, deny_tools_json, enabled, status,
           created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.name,
        input.transport,
        input.url ?? null,
        input.command ?? null,
        toJson(input.args),
        toJson(input.env),
        input.auth_mode ?? "none",
        toJson(input.headers),
        toJson(input.allow_tools),
        toJson(input.deny_tools),
        input.enabled === false ? 0 : 1,
        "disabled",
        now,
        now,
      );
    return this.get(id)!;
  }

  /** Partial update. Only the keys present are written. */
  update(id: string, patch: Partial<McpServerInput>): McpServerRow | null {
    const current = this.get(id);
    if (!current) return null;

    const columns: Array<[string, unknown]> = [];
    const set = <K extends keyof McpServerInput>(col: string, key: K, map?: (v: McpServerInput[K]) => unknown) => {
      if (patch[key] === undefined) return;
      columns.push([col, map ? map(patch[key]) : patch[key]]);
    };

    set("name", "name");
    set("transport", "transport");
    set("url", "url");
    set("command", "command");
    set("args_json", "args", toJson);
    set("env_json", "env", toJson);
    set("auth_mode", "auth_mode");
    set("headers_json", "headers", toJson);
    set("allow_tools_json", "allow_tools", toJson);
    set("deny_tools_json", "deny_tools", toJson);
    set("enabled", "enabled", (v) => (v === false ? 0 : 1));

    if (columns.length === 0) return current;

    columns.push(["updated_at", isoNow()]);
    const sql = `UPDATE mcp_servers SET ${columns.map(([c]) => `${c} = ?`).join(", ")} WHERE id = ?`;
    this.db.prepare(sql).run(...columns.map(([, v]) => v), id);
    return this.get(id);
  }

  /**
   * Record a state transition. `last_error` is cleared on any non-failure so a
   * stale message can never sit under a healthy status — the operator would
   * read it as current and chase a problem that is already gone.
   */
  setStatus(id: string, status: McpStatus, error?: string | null): void {
    const isFailure = status === "failed" || status === "needs_auth" || status === "needs_reauth";
    this.db
      .prepare(
        `UPDATE mcp_servers
            SET status = ?, last_error = ?,
                last_connected_at = CASE WHEN ? = 'connected' THEN ? ELSE last_connected_at END,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(status, isFailure ? (error ?? null) : null, status, isoNow(), isoNow(), id);
  }

  remove(id: string): boolean {
    // Explicit child deletes: ON DELETE CASCADE only fires when the connection
    // has foreign_keys=ON, which is a per-connection pragma we do not own here.
    this.db.prepare("DELETE FROM mcp_oauth_state WHERE server_id = ?").run(id);
    this.db.prepare("DELETE FROM mcp_tools WHERE server_id = ?").run(id);
    this.db.prepare("DELETE FROM mcp_credentials WHERE server_id = ?").run(id);
    const res = this.db.prepare("DELETE FROM mcp_servers WHERE id = ?").run(id) as { changes?: number };
    return (res?.changes ?? 0) > 0;
  }

  // ── Credentials ───────────────────────────────────────

  getCredentials(serverId: string): McpCredentials | null {
    const row = this.db
      .prepare("SELECT * FROM mcp_credentials WHERE server_id = ?")
      .get(serverId) as McpCredentials | undefined;
    return row ?? null;
  }

  /** Upsert. Only the provided keys are written; the rest survive. */
  saveCredentials(serverId: string, patch: Partial<Omit<McpCredentials, "server_id">>): void {
    const existing = this.getCredentials(serverId);
    const merged = {
      access_token: patch.access_token ?? existing?.access_token ?? null,
      refresh_token: patch.refresh_token ?? existing?.refresh_token ?? null,
      expires_at: patch.expires_at ?? existing?.expires_at ?? null,
      client_id: patch.client_id ?? existing?.client_id ?? null,
      client_secret: patch.client_secret ?? existing?.client_secret ?? null,
      token_url: patch.token_url ?? existing?.token_url ?? null,
      authorize_url: patch.authorize_url ?? existing?.authorize_url ?? null,
      scope: patch.scope ?? existing?.scope ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO mcp_credentials (
           server_id, access_token, refresh_token, expires_at,
           client_id, client_secret, token_url, authorize_url, scope, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(server_id) DO UPDATE SET
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           expires_at = excluded.expires_at,
           client_id = excluded.client_id,
           client_secret = excluded.client_secret,
           token_url = excluded.token_url,
           authorize_url = excluded.authorize_url,
           scope = excluded.scope,
           updated_at = excluded.updated_at`,
      )
      .run(
        serverId,
        merged.access_token,
        merged.refresh_token,
        merged.expires_at,
        merged.client_id,
        merged.client_secret,
        merged.token_url,
        merged.authorize_url,
        merged.scope,
        isoNow(),
      );
  }

  /** Drops the tokens but keeps client_id/secret, so re-login needs no re-setup. */
  clearTokens(serverId: string): void {
    this.db
      .prepare(
        `UPDATE mcp_credentials
            SET access_token = NULL, refresh_token = NULL, expires_at = NULL, updated_at = ?
          WHERE server_id = ?`,
      )
      .run(isoNow(), serverId);
  }

  // ── Tool discovery cache ──────────────────────────────

  /** Replaces the cached set wholesale — a tool the server dropped must vanish. */
  replaceTools(serverId: string, tools: Array<{ name: string; description?: string | null }>): void {
    const now = isoNow();
    this.db.prepare("DELETE FROM mcp_tools WHERE server_id = ?").run(serverId);
    const insert = this.db.prepare(
      "INSERT INTO mcp_tools (server_id, name, description, discovered_at) VALUES (?,?,?,?)",
    );
    for (const t of tools) insert.run(serverId, t.name, t.description ?? null, now);
  }

  listTools(serverId: string): McpToolRow[] {
    return this.db
      .prepare("SELECT * FROM mcp_tools WHERE server_id = ? ORDER BY name")
      .all(serverId) as McpToolRow[];
  }

  countTools(serverId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM mcp_tools WHERE server_id = ?")
      .get(serverId) as { c: number };
    return row?.c ?? 0;
  }

  // ── OAuth state (PKCE) ────────────────────────────────

  saveOAuthState(entry: {
    state: string;
    server_id: string;
    code_verifier: string;
    redirect_uri: string;
    ttlSeconds?: number;
  }): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO mcp_oauth_state (state, server_id, code_verifier, redirect_uri, created_at, expires_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(
        entry.state,
        entry.server_id,
        entry.code_verifier,
        entry.redirect_uri,
        new Date(now).toISOString(),
        new Date(now + (entry.ttlSeconds ?? 600) * 1000).toISOString(),
      );
  }

  /**
   * Reads and deletes in one step: a state is single-use, and leaving a
   * consumed one behind turns a replayed callback into a second token exchange.
   * Expired rows return null and are swept.
   */
  consumeOAuthState(state: string): { server_id: string; code_verifier: string; redirect_uri: string } | null {
    const row = this.db
      .prepare("SELECT server_id, code_verifier, redirect_uri, expires_at FROM mcp_oauth_state WHERE state = ?")
      .get(state) as
      | { server_id: string; code_verifier: string; redirect_uri: string; expires_at: string }
      | undefined;
    if (!row) return null;
    this.db.prepare("DELETE FROM mcp_oauth_state WHERE state = ?").run(state);
    if (Date.parse(row.expires_at) < Date.now()) return null;
    return { server_id: row.server_id, code_verifier: row.code_verifier, redirect_uri: row.redirect_uri };
  }

  sweepOAuthState(): void {
    this.db.prepare("DELETE FROM mcp_oauth_state WHERE expires_at < ?").run(isoNow());
  }

  // ── Env-var import ────────────────────────────────────

  /**
   * One-time import of MCP_BRIDGE_SERVERS. Runs only when the table is empty,
   * so an operator who deletes an imported server does not get it resurrected
   * on the next boot by an env var they forgot to clear.
   *
   * Returns the names imported, for the caller to log.
   */
  importFromEnv(configs: McpServerConfig[]): string[] {
    const existing = this.db.prepare("SELECT COUNT(*) AS c FROM mcp_servers").get() as { c: number };
    if ((existing?.c ?? 0) > 0) return [];

    const imported: string[] = [];
    for (const cfg of configs) {
      if (!cfg?.name) continue;
      const http = cfg.type === "http" ? cfg : null;
      const stdio = cfg.type === "stdio" ? cfg : null;
      const server = this.create({
        name: cfg.name,
        transport: cfg.type,
        url: http?.url ?? null,
        command: stdio?.command ?? null,
        args: stdio?.args ?? null,
        env: stdio?.env ?? null,
        auth_mode: http?.oauth ? "client_credentials" : http?.token ? "token" : "none",
        headers: http?.headers ?? null,
        allow_tools: cfg.allowTools ?? null,
        deny_tools: cfg.denyTools ?? null,
      });
      if (http?.token || http?.oauth) {
        this.saveCredentials(server.id, {
          access_token: http.oauth ? null : (http.token ?? null),
          client_id: http.oauth?.clientId ?? null,
          client_secret: http.oauth?.clientSecret ?? null,
          token_url: http.oauth?.tokenUrl ?? null,
          scope: http.oauth?.scope ?? null,
        });
      }
      imported.push(cfg.name);
    }
    return imported;
  }
}
