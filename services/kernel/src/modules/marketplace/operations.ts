/**
 * Marketplace operations the dashboard reaches over both the WS RPC and HTTP.
 *
 * The dashboard calls each of these through `rpcOrCall`, so the RPC action
 * and the HTTP route are the same request by two roads and have to answer
 * alike. They used to be written twice and had drifted: `marketplace.list`
 * over RPC answered `{ items, total }` only, so a WS-first page load left the
 * store without stats, themes and activeTheme; and every RPC failure came
 * back as a resolved `{ error }` the page reported as "✓ Done". Now
 * dashboard-rpc-actions.ts exposes this map as is and api-routes.ts binds
 * each entry to its path; where the two disagreed, the fuller behaviour won.
 */

import type { Operation } from "../../sdk/args.js";
import { pickArgs } from "../../sdk/args.js";
import { HttpError } from "../../sdk/http-error.js";
import type { SqliteDb } from "../../core/db/sqlite.js";
import type { MarketplaceService } from "./service.js";
import type { MarketplaceItem, ItemType, ItemStatus } from "./types.js";
import { queryMarketplace } from "./dashboard-query.js";

type Sort = "popular" | "rating" | "newest" | "name";

export function marketplaceOperations(service: MarketplaceService, db: SqliteDb = service.getDb()): Record<string, Operation> {
  const required = (input: Record<string, unknown>, key: string): string => {
    const value = typeof input[key] === "string" ? (input[key] as string) : "";
    if (!value) throw new HttpError(400, `${key} required`);
    return value;
  };
  const itemAction = (act: (id: string) => MarketplaceItem | undefined): Operation => (input) => {
    const item = act(required(input, "id"));
    if (!item) throw new HttpError(404, "Item not found");
    return { success: true, item };
  };

  return {
    // Full payload (items + stats + themes + activeTheme), the same shape as
    // the WebSocket dashboard channel, so the page renders alike whichever
    // arrives first. Filters (type/category/status/q/sort) apply to the items
    // array only; stats stay the unfiltered totals (intentional: stats are
    // global).
    "marketplace.list": (input) => {
      const f = pickArgs(input, { type: "string", category: "string", status: "string", q: "string", sort: "string" });
      const payload = queryMarketplace(db);
      if (!payload) {
        return { items: [], total: 0, stats: { total: 0, installed: 0, active: 0, byType: {} }, themes: [], activeTheme: null };
      }
      const hasFilter = f.type || f.category || f.status || f.q || f.sort;
      const items = hasFilter
        ? service.listItems({
            type: (f.type || undefined) as ItemType | undefined,
            category: f.category || undefined,
            status: (f.status || undefined) as ItemStatus | undefined,
            query: f.q || undefined,
            sort: (f.sort || undefined) as Sort | undefined,
          })
        : payload.items;
      return { ...payload, items, total: items.length };
    },

    "marketplace.install": itemAction((id) => service.installItem(id)),
    "marketplace.uninstall": itemAction((id) => service.uninstallItem(id)),
    "marketplace.enable": itemAction((id) => service.enableItem(id)),
    "marketplace.disable": itemAction((id) => service.disableItem(id)),

    "marketplace.review": (input) => {
      const args = pickArgs(input, { item_id: "string", rating: "number", title: "string", body: "string", author: "string" });
      if (!args.item_id || !args.rating) throw new HttpError(400, "item_id and rating required");
      const review = service.addReview({ ...args, item_id: args.item_id, rating: args.rating });
      return { success: true, review };
    },

    "marketplace.theme.activate": (input) => {
      const theme = service.activateTheme(required(input, "item_id"));
      if (!theme) throw new HttpError(404, "Theme not found");
      return { success: true, theme };
    },

    "marketplace.theme.deactivate": () => {
      service.deactivateTheme();
      return { success: true };
    },

    "marketplace.theme.active": () => {
      const theme = service.getActiveTheme();
      if (!theme) return { theme: null };
      return {
        theme: {
          name: theme.name,
          slug: theme.slug,
          icon: theme.icon,
          variables: JSON.parse(theme.variables),
          fonts: JSON.parse(theme.fonts),
          customCss: theme.custom_css,
          previewColors: JSON.parse(theme.preview_colors),
        },
      };
    },

    "marketplace.import": (pkg) => {
      if (!pkg.$schema || !pkg.slug) throw new HttpError(400, "$schema and slug required");
      return { success: true, item: service.importItem(pkg) };
    },

    "marketplace.export": (input) => {
      const pkg = service.exportItem(required(input, "id"));
      if (!pkg) throw new HttpError(404, "Item not found");
      return pkg;
    },
  };
}
