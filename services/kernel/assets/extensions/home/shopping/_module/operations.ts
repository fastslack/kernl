/**
 * Shopping-list operations the dashboard reaches over both the WS RPC and HTTP.
 *
 * `checkShoppingItem` & co. (dashboard api.ts, the shopping page) go through
 * `rpcOrCall`, so the RPC action and the HTTP route are one request by two
 * roads. They used to be two raw-SQL copies that had drifted: checking the
 * last item completed the list over HTTP only, an item added over RPC touched
 * the list and could link a product while over HTTP it did neither, and
 * neither went through ShoppingService. Now rpc-actions.ts exposes this map
 * and routes.ts binds each entry to its path(s).
 */

import { HttpError, isHttpError, pickArgs, type EventBus, type Operation } from "@kernl/extension-sdk";
import type { ShoppingService } from "./service.js";

export interface ShoppingOperationDeps {
  service: ShoppingService | null;
  events?: EventBus | null;
}

export function shoppingOperations(deps: ShoppingOperationDeps): Record<string, Operation> {
  const { events } = deps;

  const svc = (): ShoppingService => {
    if (!deps.service) throw new HttpError(503, "Shopping service not available");
    return deps.service;
  };
  const changed = (action: string) => events?.emit("data.changed", { module: "shopping", action });
  const requireId = (input: Record<string, unknown>): string => {
    const id = pickArgs(input, { id: "string" }).id;
    if (!id) throw new HttpError(400, "Missing id");
    return id;
  };
  // The list mutations answer any other failure (a SQLite error) with the same
  // 400 the HTTP routes always have.
  const invalidRequest = (op: Operation): Operation => (input) => {
    try { return op(input); } catch (err) {
      if (isHttpError(err)) throw err;
      throw new HttpError(400, "Invalid request");
    }
  };

  const setListStatus = (status: "active" | "completed", action: string): Operation => invalidRequest((input) => {
    svc().updateList(requireId(input), { status });
    changed(action);
    return { ok: true };
  });

  return {
    "shopping.items.check": invalidRequest((input) => {
      const id = requireId(input);
      // Unset means "check it"; the dashboard always sends the flag.
      const checked = input.checked === undefined || input.checked === true || input.checked === 1 || input.checked === "true";
      const item = svc().checkItem(id, checked);
      // Auto-complete: if all items in the list are now checked, complete the list
      if (item && checked) svc().completeListIfAllChecked(item.list_id);
      changed("check_item");
      return { ok: true };
    }),

    "shopping.items.add": invalidRequest((input) => {
      const args = pickArgs(input, { list_id: "string", name: "string", product_id: "string", quantity: "number", unit: "string", notes: "string" });
      const name = args.name?.trim() ?? "";
      // A linked product names the item itself.
      if (!args.list_id || (!name && !args.product_id)) throw new HttpError(400, "list_id and name required");
      const item = svc().addListItem({ ...args, list_id: args.list_id, name: name || undefined });
      if (!item) throw new HttpError(404, "List not found");
      changed("add_item");
      return { ok: true, id: item.id };
    }),

    "shopping.items.remove": invalidRequest((input) => {
      svc().removeListItem(requireId(input));
      changed("remove_item");
      return { ok: true };
    }),

    "shopping.lists.create": invalidRequest((input) => {
      const args = pickArgs(input, { name: "string", notes: "string" });
      const name = args.name?.trim() ?? "";
      if (!name) throw new HttpError(400, "Name required");
      const list = svc().createList({ name, notes: args.notes });
      changed("create_list");
      return { ok: true, id: list.id };
    }),

    "shopping.lists.complete": setListStatus("completed", "complete_list"),

    "shopping.lists.reopen": setListStatus("active", "reopen_list"),
  };
}
