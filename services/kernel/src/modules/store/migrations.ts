import type { Migration } from "../../core/db/migrations.js";

/**
 * Schema for the `store` module — in-dashboard purchases.
 *
 * One table: the checkout sessions this kernel opened. It exists so a purchase
 * survives a dashboard reload (or the user closing the laptop mid-payment): on
 * the next poll we still know which Stripe session to claim the license from,
 * and which slug to install once it lands.
 *
 * Rows are short-lived — `claim_expires_at` mirrors the store's 24h session
 * window, and finished rows are pruned on the next sweep.
 *
 * Forward-only: add new changes as v2+, never edit this in place.
 */
export const storeMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS store_checkouts (
        session_id       TEXT PRIMARY KEY,
        slug             TEXT NOT NULL,
        price_id         TEXT NOT NULL DEFAULT '',
        checkout_url     TEXT NOT NULL DEFAULT '',
        -- pending: waiting for payment / webhook
        -- paid:    license claimed and applied, install not finished
        -- done:    extension installed
        -- failed:  install or license application failed (see error)
        state            TEXT NOT NULL DEFAULT 'pending'
                         CHECK(state IN ('pending','paid','done','failed')),
        error            TEXT NOT NULL DEFAULT '',
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        claim_expires_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_store_checkouts_state
        ON store_checkouts(state, created_at DESC);
    `,
  },
];
