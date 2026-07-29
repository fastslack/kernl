import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { GraphDriver } from "../../../../../src/core/db-drivers/graph-driver.js";
import type {
  Category,
  Store,
  Product,
  ShoppingList,
  ShoppingListItem,
  Purchase,
} from "./types.js";
import { newId, isoNow } from "../../../../../src/core/helpers.js";

export class ShoppingService {
  constructor(
    private db: SqliteDb,
    private getGraph: () => GraphDriver | null,
  ) {}

  // ── Categories ─────────────────────────────────────────

  createCategory(input: {
    name: string;
    parent_id?: string;
    sort_order?: number;
  }): Category {
    const now = isoNow();
    const cat: Category = {
      id: newId(),
      name: input.name,
      parent_id: input.parent_id ?? null,
      sort_order: input.sort_order ?? 0,
      created_at: now,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO categories (id, name, parent_id, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(cat.id, cat.name, cat.parent_id, cat.sort_order, cat.created_at, cat.updated_at);

    const graph = this.getGraph();
    if (graph?.capabilities.cypher) {
      graph
        .run(
          `MERGE (c:Category {id: $id}) SET c.name = $name`,
          { id: cat.id, name: cat.name },
        )
        .then(() => {
          if (cat.parent_id) {
            return graph.run(
              `MATCH (child:Category {id: $childId}), (parent:Category {id: $parentId})
               MERGE (child)-[:CHILD_OF]->(parent)`,
              { childId: cat.id, parentId: cat.parent_id },
            );
          }
        })
        .catch(() => {});
    }

    return cat;
  }

  listCategories(): Category[] {
    return this.db
      .prepare("SELECT * FROM categories ORDER BY sort_order, name")
      .all() as Category[];
  }

  // ── Stores ─────────────────────────────────────────────

  createStore(input: {
    name: string;
    location?: string;
    notes?: string;
    is_supplier?: boolean;
  }): Store {
    const now = isoNow();
    const store: Store = {
      id: newId(),
      name: input.name,
      location: input.location ?? "",
      notes: input.notes ?? "",
      is_supplier: input.is_supplier ? 1 : 0,
      created_at: now,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO stores (id, name, location, notes, is_supplier, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        store.id, store.name, store.location, store.notes,
        store.is_supplier, store.created_at, store.updated_at,
      );

    const graph = this.getGraph();
    if (graph?.capabilities.cypher) {
      graph
        .run(
          `MERGE (s:Store {id: $id}) SET s.name = $name, s.location = $location`,
          { id: store.id, name: store.name, location: store.location },
        )
        .catch(() => {});
    }

    return store;
  }

  listStores(): Store[] {
    return this.db
      .prepare("SELECT * FROM stores ORDER BY name")
      .all() as Store[];
  }

  // ── Products ───────────────────────────────────────────

  createProduct(input: {
    name: string;
    description?: string;
    category_id?: string;
    tags?: string;
    unit?: string;
    current_stock?: number;
    min_stock?: number;
    notes?: string;
  }): Product {
    const now = isoNow();
    const product: Product = {
      id: newId(),
      name: input.name,
      description: input.description ?? "",
      category_id: input.category_id ?? null,
      tags: input.tags ?? "",
      unit: input.unit ?? "pcs",
      current_stock: input.current_stock ?? 0,
      min_stock: input.min_stock ?? 0,
      notes: input.notes ?? "",
      created_at: now,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO products (id, name, description, category_id, tags, unit, current_stock, min_stock, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        product.id, product.name, product.description, product.category_id,
        product.tags, product.unit, product.current_stock, product.min_stock,
        product.notes, product.created_at, product.updated_at,
      );

    const graph = this.getGraph();
    if (graph?.capabilities.cypher) {
      graph
        .run(
          `MERGE (p:Product {id: $id}) SET p.name = $name, p.unit = $unit`,
          { id: product.id, name: product.name, unit: product.unit },
        )
        .then(() => {
          if (product.category_id) {
            return graph.run(
              `MATCH (p:Product {id: $productId}), (c:Category {id: $catId})
               MERGE (p)-[:IN_CATEGORY]->(c)`,
              { productId: product.id, catId: product.category_id },
            );
          }
        })
        .catch(() => {});
    }

    return product;
  }

  updateProduct(
    id: string,
    changes: Partial<Pick<Product, "name" | "description" | "category_id" | "tags" | "unit" | "current_stock" | "min_stock" | "notes">>,
  ): Product | undefined {
    const existing = this.getProduct(id);
    if (!existing) return undefined;

    const updated = { ...existing, ...changes, updated_at: isoNow() };

    this.db
      .prepare(
        `UPDATE products SET name=?, description=?, category_id=?, tags=?, unit=?,
         current_stock=?, min_stock=?, notes=?, updated_at=? WHERE id=?`,
      )
      .run(
        updated.name, updated.description, updated.category_id, updated.tags,
        updated.unit, updated.current_stock, updated.min_stock, updated.notes,
        updated.updated_at, id,
      );

    const graph = this.getGraph();
    if (graph?.capabilities.cypher) {
      graph
        .run(
          `MERGE (p:Product {id: $id}) SET p.name = $name, p.unit = $unit`,
          { id, name: updated.name, unit: updated.unit },
        )
        .then(() => {
          if (changes.category_id !== undefined) {
            return graph
              .run(`MATCH (p:Product {id: $id})-[r:IN_CATEGORY]->() DELETE r`, { id })
              .then(() => {
                if (updated.category_id) {
                  return graph.run(
                    `MATCH (p:Product {id: $productId}), (c:Category {id: $catId})
                     MERGE (p)-[:IN_CATEGORY]->(c)`,
                    { productId: id, catId: updated.category_id },
                  );
                }
              });
          }
        })
        .catch(() => {});
    }

    return updated;
  }

  getProduct(id: string): Product | undefined {
    return this.db.prepare("SELECT * FROM products WHERE id = ?").get(id) as
      | Product
      | undefined;
  }

  listProducts(filters?: {
    category_id?: string;
    tag?: string;
    low_stock?: boolean;
    search?: string;
  }): Product[] {
    let sql = "SELECT * FROM products WHERE 1=1";
    const params: unknown[] = [];

    if (filters?.category_id) {
      sql += " AND category_id = ?";
      params.push(filters.category_id);
    }
    if (filters?.tag) {
      sql += " AND (',' || tags || ',') LIKE ?";
      params.push(`%,${filters.tag},%`);
    }
    if (filters?.low_stock) {
      sql += " AND current_stock < min_stock AND min_stock > 0";
    }
    if (filters?.search) {
      sql += " AND (name LIKE ? OR description LIKE ? OR tags LIKE ?)";
      params.push(`%${filters.search}%`, `%${filters.search}%`, `%${filters.search}%`);
    }

    sql += " ORDER BY name";
    return this.db.prepare(sql).all(...params) as Product[];
  }

  getLowStock(): Product[] {
    return this.db
      .prepare(
        "SELECT * FROM products WHERE current_stock < min_stock AND min_stock > 0 ORDER BY name",
      )
      .all() as Product[];
  }

  // ── Shopping Lists ─────────────────────────────────────

  createList(input: { name: string; notes?: string }): ShoppingList {
    const now = isoNow();
    const list: ShoppingList = {
      id: newId(),
      name: input.name,
      status: "active",
      notes: input.notes ?? "",
      created_at: now,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO shopping_lists (id, name, status, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(list.id, list.name, list.status, list.notes, list.created_at, list.updated_at);

    return list;
  }

  updateList(
    id: string,
    changes: Partial<Pick<ShoppingList, "name" | "status" | "notes">>,
  ): ShoppingList | undefined {
    const existing = this.db
      .prepare("SELECT * FROM shopping_lists WHERE id = ?")
      .get(id) as ShoppingList | undefined;
    if (!existing) return undefined;

    const updated = { ...existing, ...changes, updated_at: isoNow() };
    this.db
      .prepare(
        "UPDATE shopping_lists SET name=?, status=?, notes=?, updated_at=? WHERE id=?",
      )
      .run(updated.name, updated.status, updated.notes, updated.updated_at, id);

    return updated;
  }

  getLists(status?: ShoppingList["status"]): ShoppingList[] {
    if (status) {
      return this.db
        .prepare("SELECT * FROM shopping_lists WHERE status = ? ORDER BY updated_at DESC")
        .all(status) as ShoppingList[];
    }
    return this.db
      .prepare("SELECT * FROM shopping_lists ORDER BY updated_at DESC")
      .all() as ShoppingList[];
  }

  getListWithItems(id: string): { list: ShoppingList; items: ShoppingListItem[] } | undefined {
    const list = this.db
      .prepare("SELECT * FROM shopping_lists WHERE id = ?")
      .get(id) as ShoppingList | undefined;
    if (!list) return undefined;

    const items = this.db
      .prepare("SELECT * FROM shopping_list_items WHERE list_id = ? ORDER BY checked, name")
      .all(id) as ShoppingListItem[];

    return { list, items };
  }

  // ── List Items ─────────────────────────────────────────

  addListItem(input: {
    list_id: string;
    product_id?: string;
    name?: string;
    quantity?: number;
    unit?: string;
    notes?: string;
  }): ShoppingListItem | undefined {
    // Verify list exists
    const list = this.db
      .prepare("SELECT id FROM shopping_lists WHERE id = ?")
      .get(input.list_id);
    if (!list) return undefined;

    // Resolve name from product if linked
    let itemName = input.name ?? "";
    let itemUnit = input.unit ?? "pcs";
    if (input.product_id) {
      const product = this.getProduct(input.product_id);
      if (product) {
        if (!itemName) itemName = product.name;
        if (!input.unit) itemUnit = product.unit;
      }
    }

    const now = isoNow();
    const item: ShoppingListItem = {
      id: newId(),
      list_id: input.list_id,
      product_id: input.product_id ?? null,
      name: itemName,
      quantity: input.quantity ?? 1,
      unit: itemUnit,
      checked: 0,
      notes: input.notes ?? "",
      created_at: now,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO shopping_list_items (id, list_id, product_id, name, quantity, unit, checked, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.id, item.list_id, item.product_id, item.name,
        item.quantity, item.unit, item.checked, item.notes,
        item.created_at, item.updated_at,
      );

    return item;
  }

  checkItem(id: string, checked: boolean): ShoppingListItem | undefined {
    const existing = this.db
      .prepare("SELECT * FROM shopping_list_items WHERE id = ?")
      .get(id) as ShoppingListItem | undefined;
    if (!existing) return undefined;

    const now = isoNow();
    const checkedVal = checked ? 1 : 0;
    this.db
      .prepare("UPDATE shopping_list_items SET checked=?, updated_at=? WHERE id=?")
      .run(checkedVal, now, id);

    return { ...existing, checked: checkedVal, updated_at: now };
  }

  removeListItem(id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM shopping_list_items WHERE id = ?")
      .run(id);
    return result.changes > 0;
  }

  // ── Purchases ──────────────────────────────────────────

  logPurchase(input: {
    product_id: string;
    store_id?: string;
    quantity: number;
    unit_price: number;
    currency?: string;
    purchased_at?: string;
    notes?: string;
  }): Purchase | undefined {
    const product = this.getProduct(input.product_id);
    if (!product) return undefined;

    const now = isoNow();
    const purchase: Purchase = {
      id: newId(),
      product_id: input.product_id,
      store_id: input.store_id ?? null,
      quantity: input.quantity,
      unit_price: input.unit_price,
      total_price: input.quantity * input.unit_price,
      currency: input.currency ?? "EUR",
      purchased_at: input.purchased_at ?? now.split("T")[0],
      notes: input.notes ?? "",
      created_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO purchases (id, product_id, store_id, quantity, unit_price, total_price, currency, purchased_at, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        purchase.id, purchase.product_id, purchase.store_id,
        purchase.quantity, purchase.unit_price, purchase.total_price,
        purchase.currency, purchase.purchased_at, purchase.notes, purchase.created_at,
      );

    // Auto-increment stock
    this.db
      .prepare("UPDATE products SET current_stock = current_stock + ?, updated_at = ? WHERE id = ?")
      .run(input.quantity, now, input.product_id);

    const graph = this.getGraph();
    if (graph?.capabilities.cypher) {
      graph
        .run(
          `MATCH (p:Product {id: $productId})
           ${input.store_id ? "MATCH (s:Store {id: $storeId}) MERGE (p)-[r:BOUGHT_AT]->(s) SET r.last_price = $price, r.last_date = $date, r.purchase_count = COALESCE(r.purchase_count, 0) + 1" : ""}`,
          {
            productId: input.product_id,
            storeId: input.store_id ?? "",
            price: input.unit_price,
            date: purchase.purchased_at,
          },
        )
        .catch(() => {});
    }

    return purchase;
  }

  getPriceHistory(productId: string): Purchase[] {
    return this.db
      .prepare(
        "SELECT * FROM purchases WHERE product_id = ? ORDER BY purchased_at DESC",
      )
      .all(productId) as Purchase[];
  }

  priceComparison(productId: string): Array<{
    store_id: string;
    store_name: string;
    avg_price: number;
    min_price: number;
    max_price: number;
    last_price: number;
    purchase_count: number;
  }> {
    return this.db
      .prepare(
        `SELECT
           p.store_id,
           COALESCE(s.name, 'Unknown') as store_name,
           AVG(p.unit_price) as avg_price,
           MIN(p.unit_price) as min_price,
           MAX(p.unit_price) as max_price,
           (SELECT p2.unit_price FROM purchases p2
            WHERE p2.product_id = p.product_id AND p2.store_id = p.store_id
            ORDER BY p2.purchased_at DESC LIMIT 1) as last_price,
           COUNT(*) as purchase_count
         FROM purchases p
         LEFT JOIN stores s ON s.id = p.store_id
         WHERE p.product_id = ? AND p.store_id IS NOT NULL
         GROUP BY p.store_id
         ORDER BY avg_price ASC`,
      )
      .all(productId) as Array<{
        store_id: string;
        store_name: string;
        avg_price: number;
        min_price: number;
        max_price: number;
        last_price: number;
        purchase_count: number;
      }>;
  }

  // ── Purchase History (paginated) ───────────────────

  listPurchases(filters?: {
    store_id?: string;
    date_from?: string;
    date_to?: string;
    search?: string;
    page?: number;
    per_page?: number;
  }): { purchases: Array<Purchase & { product_name: string; store_name: string | null }>; total: number; page: number; pages: number; total_spent: number } {
    const page = Math.max(1, filters?.page ?? 1);
    const perPage = Math.min(100, Math.max(1, filters?.per_page ?? 20));

    let where = "WHERE 1=1";
    const params: unknown[] = [];

    if (filters?.store_id) {
      where += " AND p.store_id = ?";
      params.push(filters.store_id);
    }
    if (filters?.date_from) {
      where += " AND p.purchased_at >= ?";
      params.push(filters.date_from);
    }
    if (filters?.date_to) {
      where += " AND p.purchased_at <= ?";
      params.push(filters.date_to);
    }
    if (filters?.search) {
      where += " AND pr.name LIKE ?";
      params.push(`%${filters.search}%`);
    }

    const countRow = this.db.prepare(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(p.total_price), 0) as spent
       FROM purchases p
       JOIN products pr ON pr.id = p.product_id
       LEFT JOIN stores s ON s.id = p.store_id
       ${where}`,
    ).get(...params) as { cnt: number; spent: number };

    const total = countRow.cnt;
    const totalSpent = countRow.spent;
    const pages = Math.max(1, Math.ceil(total / perPage));
    const offset = (page - 1) * perPage;

    const purchases = this.db.prepare(
      `SELECT p.*, pr.name as product_name, s.name as store_name
       FROM purchases p
       JOIN products pr ON pr.id = p.product_id
       LEFT JOIN stores s ON s.id = p.store_id
       ${where}
       ORDER BY p.purchased_at DESC, p.created_at DESC
       LIMIT ? OFFSET ?`,
    ).all(...params, perPage, offset) as Array<Purchase & { product_name: string; store_name: string | null }>;

    return { purchases, total, page, pages, total_spent: totalSpent };
  }

  // ── Fuzzy matching helpers ───────────────────────

  findProductByName(name: string): Product | null {
    const lower = name.toLowerCase().trim();
    if (!lower) return null;

    const all = this.db.prepare("SELECT * FROM products ORDER BY name").all() as Product[];

    // 1. Exact match (case-insensitive)
    const exact = all.find(p => p.name.toLowerCase() === lower);
    if (exact) return exact;

    // 2. Starts-with
    const startsWith = all.find(p => p.name.toLowerCase().startsWith(lower) || lower.startsWith(p.name.toLowerCase()));
    if (startsWith) return startsWith;

    // 3. Substring match (bidirectional)
    const contains = all.find(p => p.name.toLowerCase().includes(lower) || lower.includes(p.name.toLowerCase()));
    if (contains) return contains;

    return null;
  }

  findStoreByName(name: string): Store | null {
    const lower = name.toLowerCase().trim();
    if (!lower) return null;

    const all = this.db.prepare("SELECT * FROM stores ORDER BY name").all() as Store[];

    const exact = all.find(s => s.name.toLowerCase() === lower);
    if (exact) return exact;

    const startsWith = all.find(s => s.name.toLowerCase().startsWith(lower) || lower.startsWith(s.name.toLowerCase()));
    if (startsWith) return startsWith;

    const contains = all.find(s => s.name.toLowerCase().includes(lower) || lower.includes(s.name.toLowerCase()));
    if (contains) return contains;

    return null;
  }

  adjustStock(productId: string, adjustment: number): Product | undefined {
    const product = this.getProduct(productId);
    if (!product) return undefined;

    const newStock = product.current_stock + adjustment;
    return this.updateProduct(productId, { current_stock: Math.max(0, newStock) });
  }
}
