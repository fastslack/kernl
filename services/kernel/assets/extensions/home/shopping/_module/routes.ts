import crypto from "node:crypto";
import type { KernelHttpServer } from "../../../../../src/core/http-server.js";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { ShoppingService } from "./service.js";
import type { KernelConfig } from "../../../../../src/core/config.js";
import type { EventBus } from "../../../../../src/core/event-bus.js";
import { log } from "../../../../../src/core/logger.js";
import { llm } from "../../../../../src/core/llm/client.js";

export function registerShoppingRoutes(
  server: KernelHttpServer,
  db: SqliteDb,
  shoppingService?: ShoppingService | null,
  config?: KernelConfig,
  events?: EventBus,
): void {
  server.post("/api/shopping/check-item", async (req, res) => {
    try {
      const body = await server.parseBody<{ id: string; checked: boolean }>(req);
      const checkedVal = body.checked ? 1 : 0;
      const now = new Date().toISOString();
      db.prepare("UPDATE shopping_list_items SET checked = ?, updated_at = ? WHERE id = ?")
        .run(checkedVal, now, body.id);

      // Auto-complete: if all items in the list are now checked, complete the list
      if (body.checked) {
        const row = db.prepare(
          "SELECT list_id FROM shopping_list_items WHERE id = ?"
        ).get(body.id) as { list_id: string } | undefined;
        if (row) {
          const counts = db.prepare(
            "SELECT COUNT(*) as total, SUM(CASE WHEN checked = 1 THEN 1 ELSE 0 END) as done FROM shopping_list_items WHERE list_id = ?"
          ).get(row.list_id) as { total: number; done: number };
          if (counts.total > 0 && counts.total === counts.done) {
            db.prepare("UPDATE shopping_lists SET status = 'completed', updated_at = ? WHERE id = ? AND status = 'active'")
              .run(now, row.list_id);
          }
        }
      }

      events?.emit("data.changed", { module: "shopping", action: "check_item" });
      server.json(res, 200, { ok: true });
    } catch { server.json(res, 400, { error: "Invalid request" }); }
  });

  server.post("/api/shopping/add-item", async (req, res) => {
    try {
      const body = await server.parseBody<{ list_id: string; name: string; quantity?: number; unit?: string }>(req);
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      db.prepare(
        `INSERT INTO shopping_list_items (id, list_id, product_id, name, quantity, unit, checked, notes, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, ?, 0, '', ?, ?)`,
      ).run(id, body.list_id, body.name, body.quantity ?? 1, body.unit ?? "pcs", now, now);
      events?.emit("data.changed", { module: "shopping", action: "add_item" });
      server.json(res, 200, { ok: true, id });
    } catch { server.json(res, 400, { error: "Invalid request" }); }
  });

  server.post("/api/shopping/remove-item", async (req, res) => {
    try {
      const body = await server.parseBody<{ id: string }>(req);
      db.prepare("DELETE FROM shopping_list_items WHERE id = ?").run(body.id);
      events?.emit("data.changed", { module: "shopping", action: "remove_item" });
      server.json(res, 200, { ok: true });
    } catch { server.json(res, 400, { error: "Invalid request" }); }
  });

  server.post("/api/shopping/create-list", async (req, res) => {
    try {
      const body = await server.parseBody<{ name: string; notes?: string }>(req);
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      db.prepare(
        "INSERT INTO shopping_lists (id, name, status, notes, created_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?)",
      ).run(id, body.name, body.notes ?? "", now, now);
      events?.emit("data.changed", { module: "shopping", action: "create_list" });
      server.json(res, 200, { ok: true, id });
    } catch { server.json(res, 400, { error: "Invalid request" }); }
  });

  server.post("/api/shopping/complete-list", async (req, res) => {
    try {
      const body = await server.parseBody<{ id: string }>(req);
      const now = new Date().toISOString();
      db.prepare("UPDATE shopping_lists SET status = 'completed', updated_at = ? WHERE id = ?")
        .run(now, body.id);
      events?.emit("data.changed", { module: "shopping", action: "complete_list" });
      server.json(res, 200, { ok: true });
    } catch { server.json(res, 400, { error: "Invalid request" }); }
  });

  server.post("/api/shopping/reopen-list", async (req, res) => {
    try {
      const body = await server.parseBody<{ id: string }>(req);
      const now = new Date().toISOString();
      db.prepare("UPDATE shopping_lists SET status = 'active', updated_at = ? WHERE id = ?")
        .run(now, body.id);
      events?.emit("data.changed", { module: "shopping", action: "reopen_list" });
      server.json(res, 200, { ok: true });
    } catch { server.json(res, 400, { error: "Invalid request" }); }
  });

  // ── Purchase History ───────────────────────────────
  server.get("/api/shopping/purchases", (req, res) => {
    if (!shoppingService) {
      server.json(res, 503, { error: "Shopping service not available" });
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const filters = {
      store_id: url.searchParams.get("store_id") ?? undefined,
      date_from: url.searchParams.get("date_from") ?? undefined,
      date_to: url.searchParams.get("date_to") ?? undefined,
      search: url.searchParams.get("search") ?? undefined,
      page: parseInt(url.searchParams.get("page") ?? "1", 10) || 1,
      per_page: parseInt(url.searchParams.get("per_page") ?? "20", 10) || 20,
    };
    server.json(res, 200, shoppingService.listPurchases(filters));
  });

  // ── Receipt Scanner (Vision OCR via central LlmClient) ───────────
  // Routes through llm().chat() so the call hits the chain (primary +
  // fallbacks from /models), gets recorded in llm_call_log, contributes
  // to provider-health, and is subject to the model blocklist. Image is
  // passed via the new multimodal LlmChatOptions.imageBase64.
  server.post("/api/shopping/scan-receipt", async (req, res) => {
    if (!shoppingService) {
      server.json(res, 503, { error: "Shopping service not available" });
      return;
    }
    try {
      const body = await server.parseBody<{ image: string; media_type?: string }>(req);
      if (!body.image || typeof body.image !== "string") {
        server.json(res, 400, { error: "Missing 'image' (base64 string)" });
        return;
      }

      const mediaType = body.media_type ?? "image/jpeg";
      const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
      if (!allowedTypes.includes(mediaType)) {
        server.json(res, 400, { error: `Unsupported media type: ${mediaType}. Use: ${allowedTypes.join(", ")}` });
        return;
      }

      // Check base64 size (~10MB limit → ~13.3MB base64)
      if (body.image.length > 14_000_000) {
        server.json(res, 400, { error: "Image too large (max 10MB)" });
        return;
      }

      const extractionPrompt = `Extract all items from this receipt/ticket. Return ONLY valid JSON (no markdown fences, no extra text) with this structure:
{
  "store_name": "string or null if not visible",
  "date": "YYYY-MM-DD or null if not visible",
  "currency": "3-letter code like EUR, USD",
  "items": [
    { "name": "product name", "quantity": 1, "unit_price": 1.99, "total_price": 1.99 }
  ],
  "subtotal": null,
  "tax": null,
  "total": null
}

Rules:
- All prices as numbers (not strings), using decimal point
- quantity defaults to 1 if not clear
- total_price = quantity * unit_price
- If the receipt is in a non-English language, keep product names in the original language
- Include ALL items visible on the receipt`;

      // Single call through the driver. Chain decides which provider
      // serves it; if the primary doesn't support vision (e.g. a text-
      // only LM Studio model), it'll error out and the chain falls
      // through to the next one. The audit log records who served it.
      let visionText = "";
      try {
        const result = await llm().chat({
          user: extractionPrompt,
          imageBase64: body.image,
          imageMediaType: mediaType,
          maxTokens: 2048,
          caller: "shopping:scan-receipt",
        });
        visionText = result.text;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`Vision call failed via llm() chain: ${msg.slice(0, 200)}`);
        server.json(res, 502, { error: `Vision call failed: ${msg.slice(0, 200)}` });
        return;
      }

      if (!visionText) {
        server.json(res, 502, { error: "Empty vision response from chain" });
        return;
      }

      // Parse the JSON from Vision response (strip markdown fences if present)
      let extracted: {
        store_name: string | null;
        date: string | null;
        currency: string;
        items: Array<{ name: string; quantity: number; unit_price: number; total_price: number }>;
        subtotal: number | null;
        tax: number | null;
        total: number | null;
      };
      try {
        const jsonStr = visionText.replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "").trim();
        extracted = JSON.parse(jsonStr);
      } catch {
        server.json(res, 502, { error: "Failed to parse Vision response as JSON", raw: visionText });
        return;
      }

      // Fuzzy-match items against existing products and store
      const matchedItems = extracted.items.map(item => {
        const match = shoppingService.findProductByName(item.name);
        return {
          ...item,
          matched_product: match ? { id: match.id, name: match.name } : null,
        };
      });

      const matchedStore = extracted.store_name
        ? shoppingService.findStoreByName(extracted.store_name)
        : null;

      server.json(res, 200, {
        store_name: extracted.store_name,
        matched_store: matchedStore ? { id: matchedStore.id, name: matchedStore.name } : null,
        date: extracted.date,
        currency: extracted.currency ?? "EUR",
        items: matchedItems,
        subtotal: extracted.subtotal,
        tax: extracted.tax,
        total: extracted.total,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("Receipt scan failed", err);
      server.json(res, 500, { error: msg });
    }
  });

  // ── Confirm Receipt (batch create purchases) ──────
  server.post("/api/shopping/confirm-receipt", async (req, res) => {
    if (!shoppingService) {
      server.json(res, 503, { error: "Shopping service not available" });
      return;
    }
    try {
      const body = await server.parseBody<{
        store_id?: string;
        store_name?: string;
        date?: string;
        currency?: string;
        items: Array<{
          product_id?: string;
          name: string;
          quantity: number;
          unit_price: number;
        }>;
      }>(req);

      if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
        server.json(res, 400, { error: "At least one item is required" });
        return;
      }

      // Resolve or create store
      let storeId = body.store_id ?? null;
      let storeCreated = false;
      if (!storeId && body.store_name) {
        const existing = shoppingService.findStoreByName(body.store_name);
        if (existing) {
          storeId = existing.id;
        } else {
          const newStore = shoppingService.createStore({ name: body.store_name });
          storeId = newStore.id;
          storeCreated = true;
        }
      }

      let purchasesCreated = 0;
      let productsCreated = 0;

      for (const item of body.items) {
        let productId = item.product_id;

        if (!productId) {
          // Try fuzzy match first, then create
          const matched = shoppingService.findProductByName(item.name);
          if (matched) {
            productId = matched.id;
          } else {
            const newProduct = shoppingService.createProduct({ name: item.name });
            productId = newProduct.id;
            productsCreated++;
          }
        }

        const purchase = shoppingService.logPurchase({
          product_id: productId,
          store_id: storeId ?? undefined,
          quantity: item.quantity,
          unit_price: item.unit_price,
          currency: body.currency ?? "EUR",
          purchased_at: body.date,
        });

        if (purchase) purchasesCreated++;
      }

      server.json(res, 200, {
        purchases_created: purchasesCreated,
        products_created: productsCreated,
        store_created: storeCreated,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("Confirm receipt failed", err);
      server.json(res, 500, { error: msg });
    }
  });
}
