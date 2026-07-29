import type { Migration } from "../../../../../src/core/db/migrations.js";

export const externalAgentsMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      -- External agents registry
      CREATE TABLE IF NOT EXISTS external_agents (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        description     TEXT NOT NULL DEFAULT '',
        platform        TEXT NOT NULL DEFAULT 'telegram'
                        CHECK(platform IN ('telegram', 'http', 'mqtt')),
        platform_id     TEXT NOT NULL DEFAULT '',
        capabilities    TEXT NOT NULL DEFAULT '[]',
        api_key         TEXT NOT NULL DEFAULT '',
        last_seen_at    TEXT,
        status          TEXT NOT NULL DEFAULT 'unknown'
                        CHECK(status IN ('online', 'offline', 'unknown', 'error')),
        config          TEXT NOT NULL DEFAULT '{}',
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_external_agents_platform ON external_agents(platform);
      CREATE INDEX IF NOT EXISTS idx_external_agents_status ON external_agents(status);

      -- External-agent communication log. Renamed from 'agent_messages' to
      -- avoid clashing with the agents module's conversation table (kind='chat'
      -- /'meeting'/'debate'). The pre-init safety check in index.ts renames
      -- the legacy table on existing installs.
      CREATE TABLE IF NOT EXISTS external_agent_messages (
        id              TEXT PRIMARY KEY,
        agent_id        TEXT REFERENCES external_agents(id) ON DELETE CASCADE,
        direction       TEXT NOT NULL DEFAULT 'inbound'
                        CHECK(direction IN ('inbound', 'outbound')),
        message_type    TEXT NOT NULL DEFAULT 'text'
                        CHECK(message_type IN ('text', 'report', 'command', 'alert', 'metric')),
        content         TEXT NOT NULL,
        metadata        TEXT NOT NULL DEFAULT '{}',
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_external_agent_messages_agent ON external_agent_messages(agent_id);
      CREATE INDEX IF NOT EXISTS idx_external_agent_messages_type ON external_agent_messages(message_type);
      CREATE INDEX IF NOT EXISTS idx_external_agent_messages_created ON external_agent_messages(created_at);

      -- Agent metrics (time-series data)
      CREATE TABLE IF NOT EXISTS agent_metrics (
        id              TEXT PRIMARY KEY,
        agent_id        TEXT NOT NULL REFERENCES external_agents(id) ON DELETE CASCADE,
        metric_name     TEXT NOT NULL,
        metric_value    REAL NOT NULL,
        unit            TEXT NOT NULL DEFAULT '',
        recorded_at     TEXT NOT NULL,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_metrics_agent_name ON agent_metrics(agent_id, metric_name);
      CREATE INDEX IF NOT EXISTS idx_agent_metrics_recorded ON agent_metrics(recorded_at);

      -- Agent alerts
      CREATE TABLE IF NOT EXISTS agent_alerts (
        id              TEXT PRIMARY KEY,
        agent_id        TEXT NOT NULL REFERENCES external_agents(id) ON DELETE CASCADE,
        severity        TEXT NOT NULL DEFAULT 'info'
                        CHECK(severity IN ('info', 'warning', 'critical')),
        title           TEXT NOT NULL,
        message         TEXT NOT NULL DEFAULT '',
        acknowledged    INTEGER NOT NULL DEFAULT 0,
        acknowledged_at TEXT,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_alerts_agent ON agent_alerts(agent_id);
      CREATE INDEX IF NOT EXISTS idx_agent_alerts_severity ON agent_alerts(severity);
      CREATE INDEX IF NOT EXISTS idx_agent_alerts_ack ON agent_alerts(acknowledged);
    `,
  },
];
