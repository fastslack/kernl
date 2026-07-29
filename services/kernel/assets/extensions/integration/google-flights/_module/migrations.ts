import type { Migration } from "../../../../../src/core/db/migrations.js";

export const googleFlightsMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS google_flights_searches (
        id            TEXT PRIMARY KEY,
        origin        TEXT NOT NULL,
        destination   TEXT NOT NULL,
        depart_date   TEXT NOT NULL,
        return_date   TEXT NOT NULL DEFAULT '',
        adults        INTEGER NOT NULL DEFAULT 1,
        cabin         TEXT NOT NULL DEFAULT 'ECONOMY',
        result_count  INTEGER NOT NULL DEFAULT 0,
        cheapest_cents INTEGER NOT NULL DEFAULT 0,
        currency      TEXT NOT NULL DEFAULT '',
        duration_ms   INTEGER NOT NULL DEFAULT 0,
        error         TEXT NOT NULL DEFAULT '',
        created_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_google_flights_searches_route
        ON google_flights_searches (origin, destination, depart_date);
      CREATE INDEX IF NOT EXISTS idx_google_flights_searches_created
        ON google_flights_searches (created_at);
    `,
  },
];
