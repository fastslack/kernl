import { z } from "zod";
import type { ToolDefinition } from "../../core/types.js";
import type { MarketplaceService } from "./service.js";
import { textResult, errorResult } from "../../core/helpers.js";
import { defineTool, defineToolNoInput } from "../../core/tool-builder.js";

/**
 * Unified catalog item types — superset of legacy `ItemType`. Used by the new
 * `kernel_marketplace_catalog_*` tools that route through CatalogRegistry into
 * `installed_extensions`. The legacy tools below still accept the narrower
 * `extension|agent|flow|theme|template` set for backward compatibility.
 */
const CATALOG_TYPES = [
  "module", "skill", "agent-bundle", "office", "flow", "theme",
  "template", "channel", "sandbox-driver", "db-driver", "suite",
] as const;

export function marketplaceTools(service: MarketplaceService): ToolDefinition[] {
  return [
    // ── Unified catalog tools ────────────────────────────────────────

    defineTool({
      name: "kernel_marketplace_catalog_browse",
      description: "Browse the unified marketplace catalog (skills, plugins, modules, offices, themes, channels, etc.). Merges every catalog provider with installed status.",
      schema: z.object({
        type: z.enum(CATALOG_TYPES).optional().describe("Filter by extension type"),
        category: z.string().optional().describe("Filter by category"),
        query: z.string().optional().describe("Search by name/slug/description/tags"),
        limit: z.number().int().min(1).max(200).optional().describe("Max items to return per provider"),
      }),
      handler: async (input) => {
        const items = await service.browseCatalog(input as Parameters<typeof service.browseCatalog>[0]);
        if (items.length === 0) return textResult("No catalog items found.");
        const lines = items.map((i) => {
          const m = i.manifest;
          const badge = i.status === "active" ? " [ACTIVE]"
            : i.status === "installed" ? " [INSTALLED]"
            : i.status === "disabled" ? " [DISABLED]"
            : i.status === "error" ? " [ERROR]" : "";
          const verified = i.verified ? " ✓" : "";
          const price = i.price_cents > 0 ? ` €${(i.price_cents / 100).toFixed(2)}` : "";
          return `${m.icon ?? "📦"} **${m.name}** v${m.version} — ${m.type}${badge}${verified}${price}\n` +
                 `  ${m.description}\n  ID: ${i.id}  ·  source: ${i.origin.provider}`;
        });
        return textResult(`${items.length} catalog item(s):\n\n${lines.join("\n\n")}`);
      },
    }),

    defineTool({
      name: "kernel_marketplace_catalog_install",
      description: "Install a catalog item by id or slug. Routes through ExtensionService — works for skills, plugins, modules, offices, themes, etc.",
      schema: z.object({
        id: z.string().describe("Catalog item id or slug"),
      }),
      handler: async (input) => {
        const row = await service.installFromCatalog(input.id);
        return textResult(`Installed: ${row.name} v${row.version} (${row.type}) — status: ${row.status}\nID: ${row.id}`);
      },
    }),

    defineTool({
      name: "kernel_marketplace_catalog_uninstall",
      description: "Uninstall an installed extension by id or slug. Removes the install dir and the row in installed_extensions.",
      schema: z.object({
        id: z.string().describe("Installed extension id or slug"),
        force: z.boolean().optional().describe("Force uninstall even when other extensions depend on it"),
      }),
      handler: async (input) => {
        await service.uninstallFromCatalog(input.id, { force: input.force });
        return textResult(`Uninstalled: ${input.id}`);
      },
    }),

    defineToolNoInput({
      name: "kernel_marketplace_catalog_providers",
      description: "List configured catalog providers (bundled, remote, git, ...).",
      handler: async () => {
        const providers = service.listCatalogProviders();
        if (providers.length === 0) return textResult("No catalog providers configured.");
        return textResult(
          `${providers.length} provider(s):\n` +
            providers.map((p) => `  - ${p.name}: ${p.label}`).join("\n"),
        );
      },
    }),

    // ── Legacy marketplace_items tools (themes/reviews/purchases) ────
    defineTool({
      name: "kernel_marketplace_browse",
      description: "Browse the marketplace: list extensions, agents, flows, themes, and templates. Filter by type, category, or search query.",
      schema: z.object({
        type: z.enum(["extension", "agent", "flow", "theme", "template"]).optional()
          .describe("Filter by item type"),
        category: z.string().optional().describe("Filter by category"),
        query: z.string().optional().describe("Search by name/description/tags"),
        sort: z.enum(["popular", "rating", "newest", "name"]).optional()
          .describe("Sort order (default: featured first, then newest)"),
      }),
      handler: async (input) => {
        const { type, category, query, sort } = input;
        const items = service.listItems({ type, category, query, sort, limit: 50 });
        if (items.length === 0) return textResult("No items found.");

        const lines = items.map(i => {
          const stars = i.avg_rating > 0 ? ` (${i.avg_rating.toFixed(1)}★)` : "";
          const price = i.price_cents === 0 ? "FREE" : `€${(i.price_cents / 100).toFixed(2)}`;
          const badge = i.status === "active" ? " [ACTIVE]" : i.status === "installed" ? " [INSTALLED]" : "";
          return `${i.icon} **${i.name}** v${i.version} — ${i.type}${badge}\n  ${i.description}\n  ${price}${stars} · ${i.install_count} installs · by ${i.author}\n  ID: ${i.id}`;
        });
        return textResult(`${items.length} marketplace item(s):\n\n${lines.join("\n\n")}`);
      },
    }),

    defineTool({
      name: "kernel_marketplace_get",
      description: "Get detailed information about a marketplace item by slug or ID.",
      schema: z.object({
        identifier: z.string().describe("Item slug or ID"),
      }),
      handler: async (input) => {
        const item = service.getItem(input.identifier) ?? service.getItemBySlug(input.identifier);
        if (!item) return errorResult("Item not found.");

        const reviews = service.getReviews(item.id);
        const tags = JSON.parse(item.tags);
        const deps = JSON.parse(item.dependencies);

        let md = `${item.icon} **${item.name}** v${item.version}\n`;
        md += `Type: ${item.type} | Category: ${item.category} | Status: ${item.status}\n`;
        md += `Author: ${item.author} | License: ${item.license}\n`;
        md += `Rating: ${item.avg_rating.toFixed(1)}★ (${item.review_count} reviews) | Installs: ${item.install_count}\n`;
        if (item.price_cents > 0) md += `Price: €${(item.price_cents / 100).toFixed(2)}\n`;
        if (tags.length > 0) md += `Tags: ${tags.join(", ")}\n`;
        if (deps.length > 0) md += `Dependencies: ${deps.join(", ")}\n`;
        md += `\n${item.description}`;
        if (item.long_description) md += `\n\n${item.long_description}`;

        if (reviews.length > 0) {
          md += `\n\n**Reviews:**`;
          for (const r of reviews.slice(0, 5)) {
            md += `\n  ${"★".repeat(r.rating)}${"☆".repeat(5 - r.rating)} ${r.title || "(no title)"} — ${r.author}`;
            if (r.body) md += `\n  ${r.body}`;
          }
        }

        return textResult(md);
      },
    }),

    defineTool({
      name: "kernel_marketplace_install",
      description: "Install a marketplace item (extension, agent, flow, theme, or template).",
      schema: z.object({
        id: z.string().describe("Item ID to install"),
      }),
      handler: async (input) => {
        const item = service.installItem(input.id);
        if (!item) return errorResult("Item not found.");
        return textResult(`Installed: ${item.icon} ${item.name} v${item.version} (${item.type})`);
      },
    }),

    defineTool({
      name: "kernel_marketplace_uninstall",
      description: "Uninstall a marketplace item.",
      schema: z.object({
        id: z.string().describe("Item ID to uninstall"),
      }),
      handler: async (input) => {
        const item = service.uninstallItem(input.id);
        if (!item) return errorResult("Item not found.");
        return textResult(`Uninstalled: ${item.name}`);
      },
    }),

    defineTool({
      name: "kernel_marketplace_review",
      description: "Add a review for a marketplace item (1-5 stars).",
      schema: z.object({
        item_id: z.string().describe("Item ID to review"),
        rating: z.number().int().min(1).max(5).describe("Rating (1-5)"),
        title: z.string().optional().describe("Review title"),
        body: z.string().optional().describe("Review text"),
      }),
      handler: async (input) => {
        const { item_id, rating, title, body } = input;
        const review = service.addReview({ item_id, rating, title, body });
        return textResult(`Review added: ${"★".repeat(review.rating)}${"☆".repeat(5 - review.rating)} ${review.title || "(no title)"}`);
      },
    }),

    defineTool({
      name: "kernel_marketplace_import",
      description: "Import a marketplace package from JSON. Supports agents, flows, themes, templates.",
      schema: z.object({
        package_json: z.string().describe("JSON string of the package to import"),
      }),
      handler: async (input) => {
        const pkg = JSON.parse(input.package_json);
        const item = service.importItem(pkg);
        return textResult(`Imported: ${item.icon} ${item.name} v${item.version} (${item.type})\nID: ${item.id}`);
      },
    }),

    defineTool({
      name: "kernel_marketplace_export",
      description: "Export a marketplace item as a JSON package for sharing.",
      schema: z.object({
        id: z.string().describe("Item ID to export"),
      }),
      handler: async (input) => {
        const pkg = service.exportItem(input.id);
        if (!pkg) return errorResult("Item not found.");
        return textResult("```json\n" + JSON.stringify(pkg, null, 2) + "\n```");
      },
    }),

    defineTool({
      name: "kernel_marketplace_theme",
      description: "Manage themes: activate, deactivate, or preview a theme.",
      schema: z.object({
        action: z.enum(["activate", "deactivate", "preview"]).describe("Theme action"),
        item_id: z.string().optional().describe("Theme item ID (required for activate/preview)"),
      }),
      handler: async (input) => {
        const { action, item_id } = input;

        if (action === "deactivate") {
          service.deactivateTheme();
          return textResult("Theme deactivated. Reverted to default (Midnight Gold).");
        }

        if (!item_id) return errorResult("item_id is required for activate/preview.");

        if (action === "activate") {
          const theme = service.activateTheme(item_id);
          if (!theme) return errorResult("Theme not found.");
          const item = service.getItem(item_id);
          return textResult(`Theme activated: ${item?.name ?? item_id}`);
        }

        // Preview
        const theme = service.getThemeData(item_id);
        if (!theme) return errorResult("Theme not found.");
        const vars = JSON.parse(theme.variables) as Record<string, string>;
        const lines = Object.entries(vars).map(([k, v]) => `  ${k}: ${v}`);
        return textResult(`Theme preview:\n${lines.join("\n")}`);
      },
    }),

    defineToolNoInput({
      name: "kernel_marketplace_stats",
      description: "Get marketplace statistics: item counts by type, install stats, ratings.",
      handler: async () => {
        const stats = service.getStats();
        const typeLines = Object.entries(stats.byType).map(([t, c]) => `  ${t}: ${c}`).join("\n");
        return textResult(
          `Marketplace Stats:\n  Total items: ${stats.total}\n  Installed: ${stats.installed}\n  Active: ${stats.active}\n  Reviews: ${stats.reviews}\n  Avg rating: ${stats.avgRating}★\n\nBy type:\n${typeLines}`,
        );
      },
    }),
  ];
}
