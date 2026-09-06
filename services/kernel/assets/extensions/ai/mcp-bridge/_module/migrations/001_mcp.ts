import type { Migration } from "../../../../../../src/core/db/migrations.js";

/**
 * MCP Bridge tables. All prefixed `mcp_` so they never collide with the
 * kernel's own MCP *server* side, which stores nothing.
 *
 * The structural decision worth naming: credentials live in their own table
 * rather than as columns on `mcp_servers`. Every list/status query the UI runs
 * is a plain `SELECT * FROM mcp_servers`, so a secret has no path into a
 * dashboard payload, a log line or an RPC response — it takes a deliberate
 * join to read one. The previous home for these values was the
 * MCP_BRIDGE_SERVERS environment variable, which `docker inspect` prints in
 * full; anything is better, but "impossible to leak by accident" is the bar.
 *
 * Booleans are 0/1 INTEGER; timestamps ISO-8601 TEXT.
 */
export const mcpMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      -- One row per external MCP server. Everything here is safe to show.
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id                TEXT PRIMARY KEY,
        -- Also the tool prefix: mcp_<name>_<tool>. Unique because two servers
        -- sharing a name would produce colliding tool names, and the loser
        -- would vanish with no explanation.
        name              TEXT NOT NULL UNIQUE,
        transport         TEXT NOT NULL CHECK(transport IN ('http','stdio')),
        url               TEXT,
        command           TEXT,
        args_json         TEXT,
        env_json          TEXT,
        auth_mode         TEXT NOT NULL DEFAULT 'none'
                          CHECK(auth_mode IN ('none','token','client_credentials','authorization_code')),
        headers_json      TEXT,
        allow_tools_json  TEXT,
        deny_tools_json   TEXT,
        enabled           INTEGER NOT NULL DEFAULT 1,
        -- needs_auth and needs_reauth are deliberately distinct: one has never
        -- connected, the other worked until its token died. They read
        -- differently to the operator and warrant different copy.
        status            TEXT NOT NULL DEFAULT 'disabled'
                          CHECK(status IN ('disabled','connecting','connected','needs_auth','needs_reauth','failed')),
        last_error        TEXT,
        last_connected_at TEXT,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );

      -- Secrets. Never returned by a list API; joined only when connecting.
      -- Plaintext, matching google_tokens — the trust boundary is the database
      -- file, which already holds everything else. Encrypting one table while
      -- its key sits beside it buys appearance, not security.
      CREATE TABLE IF NOT EXISTS mcp_credentials (
        server_id     TEXT PRIMARY KEY REFERENCES mcp_servers(id) ON DELETE CASCADE,
        access_token  TEXT,
        refresh_token TEXT,
        expires_at    TEXT,
        client_id     TEXT,
        client_secret TEXT,
        token_url     TEXT,
        authorize_url TEXT,
        scope         TEXT,
        updated_at    TEXT NOT NULL
      );

      -- Discovery cache, so the UI can list a server's tools and hand them to
      -- an agent without reconnecting. Rebuilt on every successful connect.
      CREATE TABLE IF NOT EXISTS mcp_tools (
        server_id     TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
        name          TEXT NOT NULL,
        description   TEXT,
        discovered_at TEXT NOT NULL,
        PRIMARY KEY (server_id, name)
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_tools_server ON mcp_tools(server_id);

      -- Short-lived PKCE state for in-flight authorization_code flows. Rows are
      -- consumed by the callback and swept on expiry; nothing here survives a
      -- completed login.
      CREATE TABLE IF NOT EXISTS mcp_oauth_state (
        state          TEXT PRIMARY KEY,
        server_id      TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
        code_verifier  TEXT NOT NULL,
        redirect_uri   TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        expires_at     TEXT NOT NULL
      );
    `,
  },
];
