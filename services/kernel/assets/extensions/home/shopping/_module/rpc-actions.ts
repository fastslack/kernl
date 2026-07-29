/**
 * Shopping RPC Actions — lists, items, products, purchases via mtwRequest.
 */

import crypto from "node:crypto";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { RpcAction } from "../../../../../src/core/mtw/rpc-handler.js";

export function shoppingRpcActions(db: SqliteDb): RpcAction[] {
  return [
    {
      name: "shopping.lists.list",
      handler: async (args) => {
        const status = typeof args.status === "string" ? args.status : "active";
        const rows = db.prepare(
          `SELECT l.id, l.name, l.status, l.notes, l.created_at, l.updated_at,
                  (SELECT COUNT(*) FROM shopping_list_items i WHERE i.list_id = l.id) as item_count,
                  (SELECT COUNT(*) FROM shopping_list_items i WHERE i.list_id = l.id AND i.checked = 1) as checked_count
           FROM shopping_lists l WHERE l.status = ? ORDER BY l.updated_at DESC`,
        ).all(status);
        return { lists: rows };
      },
    },
    {
      name: "shopping.lists.detail",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) throw new Error("Missing id");
        const list = db.prepare("SELECT * FROM shopping_lists WHERE id = ?").get(id);
        if (!list) throw new Error("Not found");
        const items = db.prepare(
          `SELECT i.id, i.product_id, i.name, i.quantity, i.unit, i.checked, i.notes, i.created_at
           FROM shopping_list_items i WHERE i.list_id = ? ORDER BY i.checked ASC, i.created_at`,
        ).all(id);
        return { list, items };
      },
    },
    {
      name: "shopping.lists.create",
      handler: async (args) => {
        const name = typeof args.name === "string" ? args.name.trim() : "";
        if (!name) throw new Error("Name required");
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        db.prepare(
          "INSERT INTO shopping_lists (id, name, status, notes, created_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?)",
        ).run(id, name, args.notes ?? "", now, now);
        return { ok: true, id };
      },
    },
    {
      name: "shopping.lists.update",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) throw new Error("Missing id");
        const fields: string[] = [];
        const vals: unknown[] = [];
        for (const f of ["name", "status", "notes"]) {
          if (args[f] !== undefined) { fields.push(`${f} = ?`); vals.push(args[f]); }
        }
        if (!fields.length) throw new Error("No fields");
        const now = new Date().toISOString();
        fields.push("updated_at = ?"); vals.push(now);
        vals.push(id);
        db.prepare(`UPDATE shopping_lists SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
        return { ok: true };
      },
    },
    {
      name: "shopping.items.add",
      handler: async (args) => {
        const listId = typeof args.list_id === "string" ? args.list_id : "";
        const name = typeof args.name === "string" ? args.name.trim() : "";
        if (!listId || !name) throw new Error("list_id and name required");
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        db.prepare(
          `INSERT INTO shopping_list_items (id, list_id, product_id, name, quantity, unit, checked, notes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        ).run(id, listId, args.product_id ?? null, name, args.quantity ?? 1, args.unit ?? "pcs", args.notes ?? "", now, now);
        // Touch list
        db.prepare("UPDATE shopping_lists SET updated_at = ? WHERE id = ?").run(now, listId);
        return { ok: true, id };
      },
    },
    {
      name: "shopping.items.check",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) throw new Error("Missing id");
        const checked = args.checked === false ? 0 : 1;
        const now = new Date().toISOString();
        db.prepare("UPDATE shopping_list_items SET checked = ?, updated_at = ? WHERE id = ?").run(checked, now, id);
        return { ok: true };
      },
    },
    {
      name: "shopping.items.remove",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) throw new Error("Missing id");
        db.prepare("DELETE FROM shopping_list_items WHERE id = ?").run(id);
        return { ok: true };
      },
    },
    {
      name: "shopping.products.list",
      handler: async (args) => {
        const categoryId = typeof args.category_id === "string" ? args.category_id : "";
        const limit = Math.min(200, typeof args.limit === "number" ? args.limit : 50);
        let where = "1=1";
        const params: unknown[] = [];
        if (categoryId) { where += " AND category_id = ?"; params.push(categoryId); }

        const rows = db.prepare(
          `SELECT id, name, description, category_id, tags, unit, current_stock, min_stock, notes, created_at, updated_at
           FROM products WHERE ${where} ORDER BY name COLLATE NOCASE LIMIT ?`,
        ).all(...params, limit);
        return { products: rows };
      },
    },
    {
      name: "shopping.products.lowStock",
      handler: async () => {
        const rows = db.prepare(
          "SELECT id, name, unit, current_stock, min_stock FROM products WHERE current_stock <= min_stock AND min_stock > 0 ORDER BY name",
        ).all();
        return { products: rows };
      },
    },
    {
      name: "shopping.purchases.log",
      handler: async (args) => {
        const productId = typeof args.product_id === "string" ? args.product_id : "";
        if (!productId) throw new Error("product_id required");
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        db.prepare(
          `INSERT INTO purchases (id, product_id, store_id, quantity, unit_price, total_price, currency, purchased_at, notes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id, productId, args.store_id ?? null,
          args.quantity ?? 1, args.unit_price ?? 0, args.total_price ?? 0,
          args.currency ?? "EUR",
          typeof args.purchased_at === "string" ? args.purchased_at : now.split("T")[0],
          args.notes ?? "", now,
        );
        // Update stock
        if (typeof args.quantity === "number" && args.quantity > 0) {
          db.prepare("UPDATE products SET current_stock = current_stock + ?, updated_at = ? WHERE id = ?")
            .run(args.quantity, now, productId);
        }
        return { ok: true, id };
      },
    },
    {
      name: "shopping.lists.complete",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) throw new Error("Missing id");
        db.prepare("UPDATE shopping_lists SET status = 'completed', updated_at = ? WHERE id = ?")
          .run(new Date().toISOString(), id);
        return { ok: true };
      },
    },
    {
      name: "shopping.lists.reopen",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) throw new Error("Missing id");
        db.prepare("UPDATE shopping_lists SET status = 'active', updated_at = ? WHERE id = ?")
          .run(new Date().toISOString(), id);
        return { ok: true };
      },
    },
  ];
}
