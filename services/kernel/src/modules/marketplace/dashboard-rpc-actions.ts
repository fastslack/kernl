/**
 * Marketplace dashboard RPC slice — `marketplace.*` operations.
 */

import type { RpcAction } from "../../core/mtw/rpc-handler.js";
import type { MarketplaceService } from "./service.js";

export interface MarketplaceDashboardRpcDeps {
  marketplaceService: MarketplaceService;
}

export function marketplaceDashboardRpcActions(deps: MarketplaceDashboardRpcDeps): RpcAction[] {
  const { marketplaceService: mp } = deps;
  return [
    {
      name: "marketplace.list",
      handler: async (args) => {
        const items = mp.listItems({
          type: typeof args.type === "string" ? args.type as any : undefined,
          category: typeof args.category === "string" ? args.category : undefined,
          status: typeof args.status === "string" ? args.status as any : undefined,
          query: typeof args.q === "string" ? args.q : undefined,
          sort: typeof args.sort === "string" ? args.sort as any : undefined,
        });
        return { items, total: items.length };
      },
    },
    {
      name: "marketplace.install",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) return { error: "id required" };
        const item = mp.installItem(id);
        if (!item) return { error: "Item not found" };
        return { success: true, item };
      },
    },
    {
      name: "marketplace.uninstall",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) return { error: "id required" };
        const item = mp.uninstallItem(id);
        if (!item) return { error: "Item not found" };
        return { success: true, item };
      },
    },
    {
      name: "marketplace.enable",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) return { error: "id required" };
        const item = mp.enableItem(id);
        if (!item) return { error: "Item not found" };
        return { success: true, item };
      },
    },
    {
      name: "marketplace.disable",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) return { error: "id required" };
        const item = mp.disableItem(id);
        if (!item) return { error: "Item not found" };
        return { success: true, item };
      },
    },
    {
      name: "marketplace.review",
      handler: async (args) => {
        const item_id = typeof args.item_id === "string" ? args.item_id : "";
        const rating = typeof args.rating === "number" ? args.rating : 0;
        if (!item_id || !rating) return { error: "item_id and rating required" };
        const review = mp.addReview({
          item_id,
          rating,
          title: typeof args.title === "string" ? args.title : undefined,
          body: typeof args.body === "string" ? args.body : undefined,
        });
        return { success: true, review };
      },
    },
    {
      name: "marketplace.theme.activate",
      handler: async (args) => {
        const item_id = typeof args.item_id === "string" ? args.item_id : "";
        if (!item_id) return { error: "item_id required" };
        const theme = mp.activateTheme(item_id);
        if (!theme) return { error: "Theme not found" };
        return { success: true, theme };
      },
    },
    {
      name: "marketplace.theme.deactivate",
      handler: async () => {
        mp.deactivateTheme();
        return { success: true };
      },
    },
    {
      name: "marketplace.theme.active",
      handler: async () => {
        const theme = mp.getActiveTheme();
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
    },
    {
      name: "marketplace.import",
      handler: async (args) => {
        const pkg = args as Record<string, unknown>;
        if (!pkg.$schema || !pkg.slug) return { error: "$schema and slug required" };
        const item = mp.importItem(pkg);
        return { success: true, item };
      },
    },
    {
      name: "marketplace.export",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) return { error: "id required" };
        const pkg = mp.exportItem(id);
        if (!pkg) return { error: "Item not found" };
        return pkg;
      },
    },
  ];
}
