import type { Migration } from "../../../../../../src/core/db/migrations.js";

export const financeMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS finance_accounts (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        type            TEXT NOT NULL DEFAULT 'checking'
                        CHECK(type IN ('checking','savings','credit','cash','investment')),
        currency        TEXT NOT NULL DEFAULT 'EUR',
        balance_cents   INTEGER NOT NULL DEFAULT 0,
        notes           TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS finance_transactions (
        id              TEXT PRIMARY KEY,
        account_id      TEXT NOT NULL REFERENCES finance_accounts(id),
        type            TEXT NOT NULL DEFAULT 'expense'
                        CHECK(type IN ('income','expense','transfer')),
        amount_cents    INTEGER NOT NULL,
        category        TEXT NOT NULL DEFAULT '',
        description     TEXT NOT NULL DEFAULT '',
        counterparty    TEXT NOT NULL DEFAULT '',
        date            TEXT NOT NULL,
        transfer_to     TEXT REFERENCES finance_accounts(id),
        notes           TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_fin_tx_account ON finance_transactions(account_id);
      CREATE INDEX IF NOT EXISTS idx_fin_tx_date ON finance_transactions(date);
      CREATE INDEX IF NOT EXISTS idx_fin_tx_category ON finance_transactions(category);

      CREATE TABLE IF NOT EXISTS finance_budgets (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        category        TEXT NOT NULL DEFAULT '',
        amount_cents    INTEGER NOT NULL,
        period          TEXT NOT NULL DEFAULT 'monthly'
                        CHECK(period IN ('weekly','monthly','quarterly','yearly')),
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
    `,
  },
];
