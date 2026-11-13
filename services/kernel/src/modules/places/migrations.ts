import type { Migration } from "../../core/db/migrations.js";

/**
 * Where things are. One row per item that names a place (an event, a hotel, an
 * activity, a trip) or per place set by hand (`kind = 'manual'`).
 *
 * `text` is what the item says (address or location); `lat`/`lng` are filled
 * from a map link in the item, by hand, or by the geocoder when one is
 * switched on. `source` says which, and a hand-set row is never overwritten.
 */
export const placesMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS places (
        id           TEXT PRIMARY KEY,
        kind         TEXT NOT NULL,
        ref_id       TEXT NOT NULL,
        name         TEXT NOT NULL DEFAULT '',
        text         TEXT NOT NULL DEFAULT '',
        lat          REAL,
        lng          REAL,
        source       TEXT NOT NULL DEFAULT '' CHECK(source IN ('', 'link', 'manual', 'geocoder')),
        when_at      TEXT NOT NULL DEFAULT '',
        geocode_tried_at TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        UNIQUE(kind, ref_id)
      );
      CREATE INDEX IF NOT EXISTS idx_places_coords ON places(lat, lng);
    `,
  },
];
