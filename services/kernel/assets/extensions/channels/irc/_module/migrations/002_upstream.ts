import type { Migration } from "../../../../../../src/core/db/migrations.js";

/**
 * Upstream networks — the bouncer half of the extension. Each row is one
 * outbound connection to an external IRC network (DALnet, Libera, QuakeNet…)
 * owned by one local account, so every user keeps their own nicks and
 * credentials. Joined channels are persisted separately because rejoining them
 * on reconnect is what makes membership survive a restart.
 */
export const upstreamMigrations: Migration[] = [
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS irc_upstreams (
        id            TEXT PRIMARY KEY,
        account       TEXT NOT NULL,
        network       TEXT NOT NULL,
        label         TEXT NOT NULL DEFAULT '',
        host          TEXT NOT NULL,
        port          INTEGER NOT NULL DEFAULT 6697,
        tls           INTEGER NOT NULL DEFAULT 1,
        nick          TEXT NOT NULL,
        username      TEXT NOT NULL DEFAULT '',
        realname      TEXT NOT NULL DEFAULT '',
        sasl_account  TEXT NOT NULL DEFAULT '',
        -- JSON blob; the 'password' field is encrypted at rest by core/secrets.
        secrets       TEXT NOT NULL DEFAULT '',
        enabled       INTEGER NOT NULL DEFAULT 1,
        last_error    TEXT NOT NULL DEFAULT '',
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        UNIQUE (account, network)
      );
      CREATE INDEX IF NOT EXISTS idx_irc_upstreams_account ON irc_upstreams(account);

      -- Channels to rejoin on reconnect. 'channel' is the upstream name
      -- (#argentina), never the local mapped one (#argentina/dalnet).
      CREATE TABLE IF NOT EXISTS irc_upstream_channels (
        upstream_id   TEXT NOT NULL,
        channel       TEXT NOT NULL,
        key           TEXT NOT NULL DEFAULT '',
        joined_at     TEXT NOT NULL,
        PRIMARY KEY (upstream_id, channel)
      );
    `,
  },
];
