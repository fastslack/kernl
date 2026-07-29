import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { daysFromNow } from "../../../../../src/core/db/query-helpers.js";

export interface DashboardShoppingItem {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  checked: number;
  notes: string;
}

export interface DashboardShoppingList {
  id: string;
  name: string;
  status: string;
  notes: string;
  created_at: string;
  updated_at: string;
  items: DashboardShoppingItem[];
  total: number;
  checked: number;
}

export interface DashboardShopping {
  lowStock: Array<{ id: string; name: string; current_stock: number; min_stock: number; unit: string }>;
  activeLists: DashboardShoppingList[];
  completedLists: DashboardShoppingList[];
  stores: Array<{ id: string; name: string; location: string }>;
  recentPurchases: Array<{
    product_name: string;
    store_name: string | null;
    quantity: number;
    total_price: number;
    currency: string;
    purchased_at: string;
  }>;
  weeklySpending: Array<{ currency: string; total: number }>;
  productCount: number;
}

function buildListsWithItems(
  db: SqliteDb,
  status: string,
  limit: number,
): DashboardShoppingList[] {
  const rawLists = db
    .prepare(
      `SELECT id, name, status, notes, created_at, updated_at
       FROM shopping_lists WHERE status = ? ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(status, limit) as Array<{
      id: string; name: string; status: string; notes: string;
      created_at: string; updated_at: string;
    }>;

  return rawLists.map((list) => {
    const items = db
      .prepare(
        `SELECT id, name, quantity, unit, checked, notes
         FROM shopping_list_items WHERE list_id = ?
         ORDER BY checked ASC, name ASC`,
      )
      .all(list.id) as DashboardShoppingItem[];

    const total = items.length;
    const checked = items.filter((i) => i.checked === 1).length;
    return { ...list, items, total, checked };
  });
}

export function queryShopping(db: SqliteDb): DashboardShopping {
  // Auto-complete active lists where all items are checked
  db.prepare(
    `UPDATE shopping_lists SET status = 'completed', updated_at = datetime('now')
     WHERE status = 'active' AND id IN (
       SELECT list_id FROM shopping_list_items GROUP BY list_id
       HAVING COUNT(*) > 0 AND COUNT(*) = SUM(CASE WHEN checked = 1 THEN 1 ELSE 0 END)
     )`,
  ).run();

  const weekAgo = daysFromNow(-7);

  const lowStock = db
    .prepare(
      `SELECT id, name, current_stock, min_stock, unit FROM products
       WHERE current_stock < min_stock AND min_stock > 0
       ORDER BY name LIMIT 20`,
    )
    .all() as DashboardShopping["lowStock"];

  const activeLists = buildListsWithItems(db, "active", 20);
  const completedLists = buildListsWithItems(db, "completed", 5);

  const stores = db
    .prepare("SELECT id, name, location FROM stores ORDER BY name")
    .all() as Array<{ id: string; name: string; location: string }>;

  const recentPurchases = db
    .prepare(
      `SELECT pr.name as product_name, s.name as store_name,
              pu.quantity, pu.total_price, pu.currency, pu.purchased_at
       FROM purchases pu
       LEFT JOIN products pr ON pr.id = pu.product_id
       LEFT JOIN stores s ON s.id = pu.store_id
       ORDER BY pu.purchased_at DESC, pu.created_at DESC
       LIMIT 10`,
    )
    .all() as DashboardShopping["recentPurchases"];

  const weeklySpending = db
    .prepare(
      `SELECT currency, SUM(total_price) as total
       FROM purchases WHERE purchased_at >= ?
       GROUP BY currency`,
    )
    .all(weekAgo) as DashboardShopping["weeklySpending"];

  const productCount = (db.prepare("SELECT COUNT(*) as cnt FROM products").get() as { cnt: number }).cnt;

  return { lowStock, activeLists, completedLists, stores, recentPurchases, weeklySpending, productCount };
}
