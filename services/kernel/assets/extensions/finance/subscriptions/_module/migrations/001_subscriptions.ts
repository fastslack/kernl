import type { Migration } from "../../../../../../src/core/db/migrations.js";

export const subscriptionsMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS subscriptions (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        provider        TEXT NOT NULL DEFAULT '',
        amount_cents    INTEGER NOT NULL,
        currency        TEXT NOT NULL DEFAULT 'EUR',
        billing_cycle   TEXT NOT NULL DEFAULT 'monthly'
                        CHECK(billing_cycle IN ('weekly','monthly','quarterly','yearly')),
        category        TEXT NOT NULL DEFAULT '',
        status          TEXT NOT NULL DEFAULT 'active'
                        CHECK(status IN ('active','paused','cancelled')),
        start_date      TEXT NOT NULL,
        next_billing    TEXT NOT NULL,
        url             TEXT NOT NULL DEFAULT '',
        notes           TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
      CREATE INDEX IF NOT EXISTS idx_subscriptions_next_billing ON subscriptions(next_billing);
    `,
  },
];
