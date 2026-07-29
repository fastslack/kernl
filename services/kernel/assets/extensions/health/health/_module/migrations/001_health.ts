import type { Migration } from "../../../../../../src/core/db/migrations.js";

export const healthMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS health_metrics (
        id              TEXT PRIMARY KEY,
        type            TEXT NOT NULL
                        CHECK(type IN ('weight','blood_pressure','heart_rate','temperature','blood_sugar','sleep_hours','steps','oxygen','custom')),
        value           TEXT NOT NULL,
        unit            TEXT NOT NULL DEFAULT '',
        date            TEXT NOT NULL,
        notes           TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_hm_type_date ON health_metrics(type, date);

      CREATE TABLE IF NOT EXISTS health_medications (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        dosage          TEXT NOT NULL DEFAULT '',
        frequency       TEXT NOT NULL DEFAULT 'daily'
                        CHECK(frequency IN ('as_needed','daily','twice_daily','weekly','monthly')),
        start_date      TEXT NOT NULL,
        end_date        TEXT,
        active          INTEGER NOT NULL DEFAULT 1,
        notes           TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS health_appointments (
        id              TEXT PRIMARY KEY,
        title           TEXT NOT NULL,
        provider        TEXT NOT NULL DEFAULT '',
        location        TEXT NOT NULL DEFAULT '',
        date            TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'scheduled'
                        CHECK(status IN ('scheduled','completed','cancelled')),
        notes           TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ha_date ON health_appointments(date);
      CREATE INDEX IF NOT EXISTS idx_ha_status ON health_appointments(status);
    `,
  },
];
