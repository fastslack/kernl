/**
 * Shopping RPC Actions — lists, items, products, purchases via mtwRequest.
 *
 * The list/item mutations are operations shared with their HTTP routes
 * (operations.ts). The rest have no HTTP twin and call ShoppingService.
 */

import { HttpError, pickArgs, rpcActionsFrom, type RpcAction } from "@kernl/extension-sdk";
import { shoppingOperations, type ShoppingOperationDeps } from "./operations.js";
import type { ShoppingList } from "./types.js";

export function shoppingRpcActions(deps: ShoppingOperationDeps): RpcAction[] {
  const svc = () => {
    if (!deps.service) throw new HttpError(503, "Shopping service not available");
    return deps.service;
  };
  const requireId = (input: Record<string, unknown>): string => {
    const id = pickArgs(input, { id: "string" }).id;
    if (!id) throw new HttpError(400, "Missing id");
    return id;
  };

  return rpcActionsFrom({
    ...shoppingOperations(deps),

    "shopping.lists.list": (input) => {
      const status = (pickArgs(input, { status: "string" }).status ?? "active") as ShoppingList["status"];
      return { lists: svc().getListsWithCounts(status) };
    },

    "shopping.lists.detail": (input) => {
      const found = svc().getListWithItems(requireId(input));
      if (!found) throw new HttpError(404, "Not found");
      return found;
    },

    "shopping.lists.update": (input) => {
      const id = requireId(input);
      // Only the keys that were sent: the service spreads these over the row.
      const changes = pickArgs(input, { name: "string", status: "string", notes: "string" }) as Partial<Pick<ShoppingList, "name" | "status" | "notes">>;
      if (Object.keys(changes).length === 0) throw new HttpError(400, "No fields");
      if (!svc().updateList(id, changes)) {
        throw new HttpError(404, "Not found");
      }
      return { ok: true };
    },

    "shopping.products.list": (input) => {
      const args = pickArgs(input, { category_id: "string", limit: "number" });
      const limit = Math.min(200, args.limit ?? 50);
      return { products: svc().listProducts({ category_id: args.category_id || undefined }).slice(0, limit) };
    },

    "shopping.products.lowStock": () => ({ products: svc().getLowStock() }),

    "shopping.purchases.log": (input) => {
      const args = pickArgs(input, {
        product_id: "string", store_id: "string", quantity: "number", unit_price: "number",
        currency: "string", purchased_at: "string", notes: "string", total_price: "number",
      });
      if (!args.product_id) throw new HttpError(400, "product_id required");
      const { total_price, ...fields } = args;
      const quantity = args.quantity ?? 1;
      // The service derives total_price from quantity × unit_price and bumps the
      // product's stock by the quantity; a caller that only knows the total
      // gets the unit price worked back from it.
      const purchase = svc().logPurchase({
        ...fields,
        product_id: args.product_id,
        quantity,
        unit_price: args.unit_price ?? (total_price !== undefined && quantity ? total_price / quantity : 0),
      });
      if (!purchase) throw new HttpError(404, "Product not found");
      return { ok: true, id: purchase.id };
    },
  });
}
