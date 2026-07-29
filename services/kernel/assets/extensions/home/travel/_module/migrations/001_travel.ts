import type { Migration } from "../../../../../../src/core/db/migrations.js";

export const travelMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      -- Trips (top-level container)
      CREATE TABLE IF NOT EXISTS travel_trips (
        id              TEXT PRIMARY KEY,
        title           TEXT NOT NULL,
        destination     TEXT NOT NULL DEFAULT '',
        country_code    TEXT NOT NULL DEFAULT '',    -- ISO 3166-1 alpha-2
        start_date      TEXT NOT NULL,
        end_date        TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'planning'
                        CHECK(status IN ('planning','booked','in_progress','completed','cancelled')),
        purpose         TEXT NOT NULL DEFAULT 'leisure'
                        CHECK(purpose IN ('leisure','business','family','medical','other')),
        budget_cents    INTEGER NOT NULL DEFAULT 0,
        currency        TEXT NOT NULL DEFAULT 'EUR',
        notes           TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );

      -- Flights
      CREATE TABLE IF NOT EXISTS travel_flights (
        id              TEXT PRIMARY KEY,
        trip_id         TEXT NOT NULL REFERENCES travel_trips(id) ON DELETE CASCADE,
        airline         TEXT NOT NULL DEFAULT '',
        flight_number   TEXT NOT NULL DEFAULT '',
        origin          TEXT NOT NULL,              -- IATA code e.g. AMS
        destination     TEXT NOT NULL,              -- IATA code
        departs_at      TEXT NOT NULL,              -- ISO datetime
        arrives_at      TEXT NOT NULL,
        terminal        TEXT NOT NULL DEFAULT '',
        gate            TEXT NOT NULL DEFAULT '',
        seat            TEXT NOT NULL DEFAULT '',
        booking_ref     TEXT NOT NULL DEFAULT '',
        price_cents     INTEGER NOT NULL DEFAULT 0,
        currency        TEXT NOT NULL DEFAULT 'EUR',
        status          TEXT NOT NULL DEFAULT 'booked'
                        CHECK(status IN ('booked','checked_in','boarded','completed','cancelled')),
        notes           TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL
      );

      -- Accommodations (hotels, Airbnb, hostels, etc.)
      CREATE TABLE IF NOT EXISTS travel_accommodations (
        id              TEXT PRIMARY KEY,
        trip_id         TEXT NOT NULL REFERENCES travel_trips(id) ON DELETE CASCADE,
        name            TEXT NOT NULL,
        type            TEXT NOT NULL DEFAULT 'hotel'
                        CHECK(type IN ('hotel','airbnb','hostel','camping','friend','other')),
        address         TEXT NOT NULL DEFAULT '',
        check_in        TEXT NOT NULL,              -- ISO date
        check_out       TEXT NOT NULL,
        confirmation    TEXT NOT NULL DEFAULT '',
        price_cents     INTEGER NOT NULL DEFAULT 0,
        currency        TEXT NOT NULL DEFAULT 'EUR',
        url             TEXT NOT NULL DEFAULT '',
        notes           TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL
      );

      -- Activities / itinerary items
      CREATE TABLE IF NOT EXISTS travel_activities (
        id              TEXT PRIMARY KEY,
        trip_id         TEXT NOT NULL REFERENCES travel_trips(id) ON DELETE CASCADE,
        title           TEXT NOT NULL,
        type            TEXT NOT NULL DEFAULT 'attraction'
                        CHECK(type IN ('attraction','restaurant','transport','tour','event','meeting','other')),
        date            TEXT NOT NULL,              -- ISO date
        start_time      TEXT NOT NULL DEFAULT '',   -- HH:MM
        end_time        TEXT NOT NULL DEFAULT '',
        location        TEXT NOT NULL DEFAULT '',
        address         TEXT NOT NULL DEFAULT '',
        booking_ref     TEXT NOT NULL DEFAULT '',
        price_cents     INTEGER NOT NULL DEFAULT 0,
        currency        TEXT NOT NULL DEFAULT 'EUR',
        status          TEXT NOT NULL DEFAULT 'planned'
                        CHECK(status IN ('planned','booked','completed','skipped')),
        notes           TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL
      );

      -- Travel expenses
      CREATE TABLE IF NOT EXISTS travel_expenses (
        id              TEXT PRIMARY KEY,
        trip_id         TEXT NOT NULL REFERENCES travel_trips(id) ON DELETE CASCADE,
        category        TEXT NOT NULL DEFAULT 'other'
                        CHECK(category IN ('flight','accommodation','food','transport','activity','shopping','health','other')),
        description     TEXT NOT NULL,
        amount_cents    INTEGER NOT NULL,
        currency        TEXT NOT NULL DEFAULT 'EUR',
        date            TEXT NOT NULL,
        payment_method  TEXT NOT NULL DEFAULT '',
        receipt_url     TEXT NOT NULL DEFAULT '',
        notes           TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL
      );

      -- Packing lists
      CREATE TABLE IF NOT EXISTS travel_packing_items (
        id              TEXT PRIMARY KEY,
        trip_id         TEXT NOT NULL REFERENCES travel_trips(id) ON DELETE CASCADE,
        category        TEXT NOT NULL DEFAULT 'general',
        name            TEXT NOT NULL,
        quantity        INTEGER NOT NULL DEFAULT 1,
        packed          INTEGER NOT NULL DEFAULT 0, -- boolean
        notes           TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL
      );

      -- Travel documents (visas, insurance, etc.)
      CREATE TABLE IF NOT EXISTS travel_documents (
        id              TEXT PRIMARY KEY,
        trip_id         TEXT REFERENCES travel_trips(id) ON DELETE SET NULL,
        type            TEXT NOT NULL DEFAULT 'other'
                        CHECK(type IN ('passport','visa','insurance','booking','ticket','other')),
        title           TEXT NOT NULL,
        number          TEXT NOT NULL DEFAULT '',
        issued_at       TEXT,
        expires_at      TEXT,
        country         TEXT NOT NULL DEFAULT '',
        notes           TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_travel_trips_status ON travel_trips(status);
      CREATE INDEX IF NOT EXISTS idx_travel_trips_dates ON travel_trips(start_date, end_date);
      CREATE INDEX IF NOT EXISTS idx_travel_flights_trip ON travel_flights(trip_id);
      CREATE INDEX IF NOT EXISTS idx_travel_accommodations_trip ON travel_accommodations(trip_id);
      CREATE INDEX IF NOT EXISTS idx_travel_activities_trip_date ON travel_activities(trip_id, date);
      CREATE INDEX IF NOT EXISTS idx_travel_expenses_trip ON travel_expenses(trip_id);
    `,
  },
];
