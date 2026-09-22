import {
  HttpError,
  isHttpError,
  type KernelHttpServer,
  type EventBus,
  log,
  llm,
} from "@kernl/extension-sdk";
import type { ShoppingService } from "./service.js";
import { shoppingOperations } from "./operations.js";

type RouteMethod = Parameters<KernelHttpServer["operation"]>[0];

export function registerShoppingRoutes(
  server: KernelHttpServer,
  shoppingService?: ShoppingService | null,
  events?: EventBus,
): void {
  const requireShopping = (): ShoppingService => {
    if (!shoppingService) throw new HttpError(503, "Shopping service not available");
    return shoppingService;
  };

  // ── Operations shared with the WS RPC (operations.ts) ─────────
  // The dashboard reaches these through rpcOrCall, WS first and HTTP when the
  // bridge is down. removeShoppingItem's fallback sends DELETE ?id=, which had
  // no route, so remove-item answers both methods.
  const op = shoppingOperations({ service: shoppingService ?? null, events });
  ([
    ["POST", "/api/shopping/check-item", "shopping.items.check"],
    ["POST", "/api/shopping/add-item", "shopping.items.add"],
    ["POST", "/api/shopping/remove-item", "shopping.items.remove"],
    ["DELETE", "/api/shopping/remove-item", "shopping.items.remove"],
    ["POST", "/api/shopping/create-list", "shopping.lists.create"],
    ["POST", "/api/shopping/complete-list", "shopping.lists.complete"],
    ["POST", "/api/shopping/reopen-list", "shopping.lists.reopen"],
  ] as Array<[RouteMethod, string, string]>).forEach(([method, path, name]) => server.operation(method, path, op[name]));

  // ── Purchase History ───────────────────────────────
  server.route("GET", "/api/shopping/purchases", ({ query }) => {
    const svc = requireShopping();
    const filters = {
      store_id: query.get("store_id") ?? undefined,
      date_from: query.get("date_from") ?? undefined,
      date_to: query.get("date_to") ?? undefined,
      search: query.get("search") ?? undefined,
      page: parseInt(query.get("page") ?? "1", 10) || 1,
      per_page: parseInt(query.get("per_page") ?? "20", 10) || 20,
    };
    return svc.listPurchases(filters);
  });

  // ── Receipt Scanner (Vision OCR via central LlmClient) ───────────
  // Routes through llm().chat() so the call hits the chain (primary +
  // fallbacks from /models), gets recorded in llm_call_log, contributes
  // to provider-health, and is subject to the model blocklist. Image is
  // passed via the new multimodal LlmChatOptions.imageBase64.
  server.route<{ image: string; media_type?: string }>("POST", "/api/shopping/scan-receipt", async ({ body }) => {
    const svc = requireShopping();
    try {
      if (!body.image || typeof body.image !== "string") {
        throw new HttpError(400, "Missing 'image' (base64 string)");
      }

      const mediaType = body.media_type ?? "image/jpeg";
      const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
      if (!allowedTypes.includes(mediaType)) {
        throw new HttpError(400, `Unsupported media type: ${mediaType}. Use: ${allowedTypes.join(", ")}`);
      }

      // Check base64 size (~10MB limit → ~13.3MB base64)
      if (body.image.length > 14_000_000) {
        throw new HttpError(400, "Image too large (max 10MB)");
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
        throw new HttpError(502, `Vision call failed: ${msg.slice(0, 200)}`);
      }

      if (!visionText) {
        throw new HttpError(502, "Empty vision response from chain");
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
        throw new HttpError(502, "Failed to parse Vision response as JSON", {
          error: "Failed to parse Vision response as JSON",
          raw: visionText,
        });
      }

      // Fuzzy-match items against existing products and store
      const matchedItems = extracted.items.map(item => {
        const match = svc.findProductByName(item.name);
        return {
          ...item,
          matched_product: match ? { id: match.id, name: match.name } : null,
        };
      });

      const matchedStore = extracted.store_name
        ? svc.findStoreByName(extracted.store_name)
        : null;

      return {
        store_name: extracted.store_name,
        matched_store: matchedStore ? { id: matchedStore.id, name: matchedStore.name } : null,
        date: extracted.date,
        currency: extracted.currency ?? "EUR",
        items: matchedItems,
        subtotal: extracted.subtotal,
        tax: extracted.tax,
        total: extracted.total,
      };
    } catch (err) {
      if (isHttpError(err)) throw err;
      log.error("Receipt scan failed", err);
      throw new HttpError(500, err instanceof Error ? err.message : String(err));
    }
  });

  // ── Confirm Receipt (batch create purchases) ──────
  server.route<{
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
  }>("POST", "/api/shopping/confirm-receipt", ({ body }) => {
    const svc = requireShopping();
    if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
      throw new HttpError(400, "At least one item is required");
    }
    try {
      // Resolve or create store
      let storeId = body.store_id ?? null;
      let storeCreated = false;
      if (!storeId && body.store_name) {
        const existing = svc.findStoreByName(body.store_name);
        if (existing) {
          storeId = existing.id;
        } else {
          const newStore = svc.createStore({ name: body.store_name });
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
          const matched = svc.findProductByName(item.name);
          if (matched) {
            productId = matched.id;
          } else {
            const newProduct = svc.createProduct({ name: item.name });
            productId = newProduct.id;
            productsCreated++;
          }
        }

        const purchase = svc.logPurchase({
          product_id: productId,
          store_id: storeId ?? undefined,
          quantity: item.quantity,
          unit_price: item.unit_price,
          currency: body.currency ?? "EUR",
          purchased_at: body.date,
        });

        if (purchase) purchasesCreated++;
      }

      return {
        purchases_created: purchasesCreated,
        products_created: productsCreated,
        store_created: storeCreated,
      };
    } catch (err) {
      log.error("Confirm receipt failed", err);
      throw new HttpError(500, err instanceof Error ? err.message : String(err));
    }
  });
}
