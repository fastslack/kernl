import type { Migration } from "../../../../../../src/core/db/migrations.js";

export const shoppingMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS categories (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        parent_id   TEXT REFERENCES categories(id),
        sort_order  INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);

      CREATE TABLE IF NOT EXISTS stores (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        location    TEXT NOT NULL DEFAULT '',
        notes       TEXT NOT NULL DEFAULT '',
        is_supplier INTEGER NOT NULL DEFAULT 0 CHECK(is_supplier IN (0, 1)),
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS products (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        description   TEXT NOT NULL DEFAULT '',
        category_id   TEXT REFERENCES categories(id),
        tags          TEXT NOT NULL DEFAULT '',
        unit          TEXT NOT NULL DEFAULT 'pcs',
        current_stock REAL NOT NULL DEFAULT 0,
        min_stock     REAL NOT NULL DEFAULT 0,
        notes         TEXT NOT NULL DEFAULT '',
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
      CREATE INDEX IF NOT EXISTS idx_products_stock ON products(current_stock, min_stock);

      CREATE TABLE IF NOT EXISTS shopping_lists (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'active'
                    CHECK(status IN ('active','completed','archived')),
        notes       TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_shopping_lists_status ON shopping_lists(status);

      CREATE TABLE IF NOT EXISTS shopping_list_items (
        id          TEXT PRIMARY KEY,
        list_id     TEXT NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
        product_id  TEXT REFERENCES products(id),
        name        TEXT NOT NULL,
        quantity    REAL NOT NULL DEFAULT 1,
        unit        TEXT NOT NULL DEFAULT 'pcs',
        checked     INTEGER NOT NULL DEFAULT 0 CHECK(checked IN (0, 1)),
        notes       TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_shopping_list_items_list ON shopping_list_items(list_id);

      CREATE TABLE IF NOT EXISTS purchases (
        id            TEXT PRIMARY KEY,
        product_id    TEXT NOT NULL REFERENCES products(id),
        store_id      TEXT REFERENCES stores(id),
        quantity      REAL NOT NULL,
        unit_price    REAL NOT NULL,
        total_price   REAL NOT NULL,
        currency      TEXT NOT NULL DEFAULT 'EUR',
        purchased_at  TEXT NOT NULL,
        notes         TEXT NOT NULL DEFAULT '',
        created_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_purchases_product ON purchases(product_id);
      CREATE INDEX IF NOT EXISTS idx_purchases_store ON purchases(store_id);
      CREATE INDEX IF NOT EXISTS idx_purchases_date ON purchases(purchased_at);
    `,
  },
];
