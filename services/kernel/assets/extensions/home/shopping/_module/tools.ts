import { z } from "zod";
import type { ToolDefinition } from "../../../../../src/core/types.js";
import type { ShoppingService } from "./service.js";
import { textResult, errorResult } from "../../../../../src/core/helpers.js";

export function shoppingTools(service: ShoppingService): ToolDefinition[] {
  return [
    // ── Products ───────────────────────────────────────

    {
      name: "kernel_shopping_add_product",
      description: "Add a product to the catalog with optional category, tags, stock levels, and unit.",
      inputSchema: z.object({
        name: z.string().describe("Product name"),
        description: z.string().optional().describe("Product description"),
        category_id: z.string().optional().describe("Category ID"),
        tags: z.string().optional().describe("Comma-separated tags (e.g. 'dairy,organic')"),
        unit: z.string().optional().describe("Unit of measure (pcs, kg, L, etc). Default: pcs"),
        current_stock: z.number().optional().describe("Current stock level. Default: 0"),
        min_stock: z.number().optional().describe("Minimum stock threshold for alerts. Default: 0"),
        notes: z.string().optional().describe("Additional notes"),
      }),
      handler: async (args) => {
        const input = args as {
          name: string; description?: string; category_id?: string;
          tags?: string; unit?: string; current_stock?: number;
          min_stock?: number; notes?: string;
        };
        const product = service.createProduct(input);
        return textResult(
          `Product created:\n` +
          `  ID: ${product.id}\n` +
          `  Name: ${product.name}\n` +
          `  Unit: ${product.unit}\n` +
          `  Stock: ${product.current_stock} (min: ${product.min_stock})\n` +
          (product.tags ? `  Tags: ${product.tags}\n` : "") +
          (product.category_id ? `  Category: ${product.category_id}\n` : ""),
        );
      },
    },

    {
      name: "kernel_shopping_update_product",
      description: "Update a product's details: name, description, category, tags, stock, unit, or notes.",
      inputSchema: z.object({
        id: z.string().describe("Product ID"),
        name: z.string().optional().describe("New name"),
        description: z.string().optional().describe("New description"),
        category_id: z.string().optional().describe("New category ID"),
        tags: z.string().optional().describe("New comma-separated tags"),
        unit: z.string().optional().describe("New unit"),
        current_stock: z.number().optional().describe("Set stock level directly"),
        min_stock: z.number().optional().describe("Set minimum stock threshold"),
        notes: z.string().optional().describe("New notes"),
      }),
      handler: async (args) => {
        const { id, ...changes } = args as {
          id: string; name?: string; description?: string; category_id?: string;
          tags?: string; unit?: string; current_stock?: number;
          min_stock?: number; notes?: string;
        };
        const product = service.updateProduct(id, changes);
        if (!product) return errorResult(`Product not found: ${id}`);
        return textResult(
          `Product updated:\n` +
          `  Name: ${product.name}\n` +
          `  Stock: ${product.current_stock} ${product.unit} (min: ${product.min_stock})\n` +
          (product.tags ? `  Tags: ${product.tags}\n` : ""),
        );
      },
    },

    {
      name: "kernel_shopping_list_products",
      description: "List or search products. Filter by category, tag, low stock, or free-text search.",
      inputSchema: z.object({
        category_id: z.string().optional().describe("Filter by category ID"),
        tag: z.string().optional().describe("Filter by tag"),
        low_stock: z.boolean().optional().describe("Show only products below minimum stock"),
        search: z.string().optional().describe("Free-text search in name, description, tags"),
      }),
      handler: async (args) => {
        const filters = args as {
          category_id?: string; tag?: string; low_stock?: boolean; search?: string;
        };
        const products = service.listProducts(filters);
        if (products.length === 0) return textResult("No products found.");

        const lines = products.map((p) => {
          const stock = `${p.current_stock}/${p.min_stock} ${p.unit}`;
          const low = p.min_stock > 0 && p.current_stock < p.min_stock ? " ⚠ LOW" : "";
          return `- ${p.name} [${stock}${low}]${p.tags ? ` (${p.tags})` : ""} — ${p.id}`;
        });
        return textResult(`Products (${products.length}):\n${lines.join("\n")}`);
      },
    },

    // ── Categories ─────────────────────────────────────

    {
      name: "kernel_shopping_add_category",
      description: "Create a product category. Supports hierarchy via parent_id.",
      inputSchema: z.object({
        name: z.string().describe("Category name"),
        parent_id: z.string().optional().describe("Parent category ID for hierarchy"),
        sort_order: z.number().optional().describe("Sort order (lower = first). Default: 0"),
      }),
      handler: async (args) => {
        const input = args as { name: string; parent_id?: string; sort_order?: number };
        const cat = service.createCategory(input);
        return textResult(
          `Category created:\n` +
          `  ID: ${cat.id}\n` +
          `  Name: ${cat.name}\n` +
          (cat.parent_id ? `  Parent: ${cat.parent_id}\n` : "  (root category)\n"),
        );
      },
    },

    {
      name: "kernel_shopping_list_categories",
      description: "List all categories as a tree structure.",
      inputSchema: z.object({}),
      handler: async () => {
        const categories = service.listCategories();
        if (categories.length === 0) return textResult("No categories defined yet.");

        // Build tree
        const roots = categories.filter((c) => !c.parent_id);
        const children = new Map<string, typeof categories>();
        for (const c of categories) {
          if (c.parent_id) {
            const list = children.get(c.parent_id) ?? [];
            list.push(c);
            children.set(c.parent_id, list);
          }
        }

        const lines: string[] = [];
        const render = (cats: typeof categories, indent: string) => {
          for (const c of cats) {
            lines.push(`${indent}- ${c.name} (${c.id})`);
            const kids = children.get(c.id);
            if (kids) render(kids, indent + "  ");
          }
        };
        render(roots, "");

        return textResult(`Categories:\n${lines.join("\n")}`);
      },
    },

    // ── Stores ─────────────────────────────────────────

    {
      name: "kernel_shopping_add_store",
      description: "Add a store or supplier for price tracking.",
      inputSchema: z.object({
        name: z.string().describe("Store name"),
        location: z.string().optional().describe("Address or location"),
        notes: z.string().optional().describe("Additional notes"),
        is_supplier: z.boolean().optional().describe("Mark as supplier (B2B). Default: false"),
      }),
      handler: async (args) => {
        const input = args as { name: string; location?: string; notes?: string; is_supplier?: boolean };
        const store = service.createStore(input);
        return textResult(
          `Store created:\n` +
          `  ID: ${store.id}\n` +
          `  Name: ${store.name}\n` +
          (store.location ? `  Location: ${store.location}\n` : "") +
          (store.is_supplier ? `  Type: Supplier\n` : ""),
        );
      },
    },

    // ── Shopping Lists ─────────────────────────────────

    {
      name: "kernel_shopping_create_list",
      description: "Create a new shopping list.",
      inputSchema: z.object({
        name: z.string().describe("List name (e.g. 'Weekly groceries', 'Office supplies')"),
        notes: z.string().optional().describe("Notes about this list"),
      }),
      handler: async (args) => {
        const input = args as { name: string; notes?: string };
        const list = service.createList(input);
        return textResult(
          `Shopping list created:\n` +
          `  ID: ${list.id}\n` +
          `  Name: ${list.name}\n` +
          `  Status: ${list.status}`,
        );
      },
    },

    {
      name: "kernel_shopping_get_list",
      description: "View a shopping list with all its items and check status.",
      inputSchema: z.object({
        id: z.string().describe("Shopping list ID"),
      }),
      handler: async (args) => {
        const { id } = args as { id: string };
        const result = service.getListWithItems(id);
        if (!result) return errorResult(`Shopping list not found: ${id}`);

        const { list, items } = result;
        const checked = items.filter((i) => i.checked).length;
        const lines: string[] = [
          `# ${list.name}`,
          `Status: ${list.status} | Progress: ${checked}/${items.length}`,
          list.notes ? `Notes: ${list.notes}` : "",
          "",
        ];

        if (items.length === 0) {
          lines.push("(empty list)");
        } else {
          for (const item of items) {
            const mark = item.checked ? "[x]" : "[ ]";
            const qty = item.quantity !== 1 ? ` (${item.quantity} ${item.unit})` : "";
            lines.push(`${mark} ${item.name}${qty}${item.notes ? ` — ${item.notes}` : ""}`);
          }
        }

        return textResult(lines.filter(Boolean).join("\n"));
      },
    },

    {
      name: "kernel_shopping_add_item",
      description:
        "Add an item to a shopping list. Can link to an existing product (auto-fills name/unit) or be ad-hoc.",
      inputSchema: z.object({
        list_id: z.string().describe("Shopping list ID"),
        product_id: z.string().optional().describe("Link to existing product (auto-fills name/unit)"),
        name: z.string().optional().describe("Item name (required if no product_id)"),
        quantity: z.number().optional().describe("Quantity. Default: 1"),
        unit: z.string().optional().describe("Unit. Default: from product or 'pcs'"),
        notes: z.string().optional().describe("Notes"),
      }),
      handler: async (args) => {
        const input = args as {
          list_id: string; product_id?: string; name?: string;
          quantity?: number; unit?: string; notes?: string;
        };

        if (!input.product_id && !input.name) {
          return errorResult("Provide either product_id or name for the item.");
        }

        const item = service.addListItem(input);
        if (!item) return errorResult(`Shopping list not found: ${input.list_id}`);

        return textResult(
          `Item added to list:\n` +
          `  ID: ${item.id}\n` +
          `  Name: ${item.name}\n` +
          `  Quantity: ${item.quantity} ${item.unit}`,
        );
      },
    },

    {
      name: "kernel_shopping_check_item",
      description: "Check or uncheck an item in a shopping list.",
      inputSchema: z.object({
        id: z.string().describe("Shopping list item ID"),
        checked: z.boolean().describe("true to check, false to uncheck"),
      }),
      handler: async (args) => {
        const { id, checked } = args as { id: string; checked: boolean };
        const item = service.checkItem(id, checked);
        if (!item) return errorResult(`Item not found: ${id}`);
        return textResult(`${checked ? "Checked" : "Unchecked"}: ${item.name}`);
      },
    },

    // ── Purchases ──────────────────────────────────────

    {
      name: "kernel_shopping_log_purchase",
      description:
        "Log a purchase. Automatically updates the product's stock level. Tracks store and price for comparison.",
      inputSchema: z.object({
        product_id: z.string().describe("Product ID"),
        store_id: z.string().optional().describe("Store ID (for price tracking)"),
        quantity: z.number().describe("Quantity purchased"),
        unit_price: z.number().describe("Price per unit"),
        currency: z.string().optional().describe("Currency code. Default: EUR"),
        purchased_at: z.string().optional().describe("Purchase date (YYYY-MM-DD). Default: today"),
        notes: z.string().optional().describe("Notes"),
      }),
      handler: async (args) => {
        const input = args as {
          product_id: string; store_id?: string; quantity: number;
          unit_price: number; currency?: string; purchased_at?: string; notes?: string;
        };
        const purchase = service.logPurchase(input);
        if (!purchase) return errorResult(`Product not found: ${input.product_id}`);

        const product = service.getProduct(input.product_id);
        return textResult(
          `Purchase logged:\n` +
          `  ID: ${purchase.id}\n` +
          `  Product: ${product?.name ?? purchase.product_id}\n` +
          `  Quantity: ${purchase.quantity} × ${purchase.unit_price} ${purchase.currency}\n` +
          `  Total: ${purchase.total_price.toFixed(2)} ${purchase.currency}\n` +
          `  Date: ${purchase.purchased_at}\n` +
          (product ? `  New stock: ${product.current_stock + purchase.quantity} ${product.unit}` : ""),
        );
      },
    },

    {
      name: "kernel_shopping_price_compare",
      description: "Compare prices for a product across different stores. Shows avg, min, max, and last price per store.",
      inputSchema: z.object({
        product_id: z.string().describe("Product ID to compare prices for"),
      }),
      handler: async (args) => {
        const { product_id } = args as { product_id: string };
        const product = service.getProduct(product_id);
        if (!product) return errorResult(`Product not found: ${product_id}`);

        const comparison = service.priceComparison(product_id);
        if (comparison.length === 0) {
          return textResult(`No purchase history for "${product.name}".`);
        }

        const lines = [
          `Price comparison: ${product.name}`,
          "",
          ...comparison.map((c) =>
            `- ${c.store_name}: avg ${c.avg_price.toFixed(2)} | min ${c.min_price.toFixed(2)} | max ${c.max_price.toFixed(2)} | last ${c.last_price.toFixed(2)} (${c.purchase_count} purchases)`,
          ),
        ];
        return textResult(lines.join("\n"));
      },
    },

    {
      name: "kernel_shopping_low_stock",
      description: "List all products below their minimum stock level.",
      inputSchema: z.object({}),
      handler: async () => {
        const products = service.getLowStock();
        if (products.length === 0) return textResult("All products are above minimum stock levels.");

        const lines = products.map((p) =>
          `- ${p.name}: ${p.current_stock}/${p.min_stock} ${p.unit} (need ${(p.min_stock - p.current_stock).toFixed(1)} more)`,
        );
        return textResult(`Low Stock Alert (${products.length}):\n${lines.join("\n")}`);
      },
    },
  ];
}
