import type { SqliteDb } from "../../core/db/sqlite.js";

export interface DashboardMarketplace {
  items: Array<{
    id: string;
    type: string;
    slug: string;
    name: string;
    description: string;
    version: string;
    author: string;
    icon: string;
    category: string;
    tags: string;
    price_cents: number;
    currency: string;
    source_type: string;
    install_count: number;
    avg_rating: number;
    review_count: number;
    status: string;
    featured: number;
    verified: number;
    package_data: string;
  }>;
  stats: {
    total: number;
    installed: number;
    active: number;
    byType: Record<string, number>;
  };
  activeTheme: {
    name: string;
    slug: string;
    icon: string;
    variables: Record<string, string>;
    fonts: string[];
    customCss: string;
    previewColors: string[];
  } | null;
  themes: Array<{
    id: string;
    item_id: string;
    name: string;
    slug: string;
    icon: string;
    active: number;
    preview_colors: string;
    variables: string;
  }>;
}

export function queryMarketplace(db: SqliteDb): DashboardMarketplace | null {
  try {
    db.prepare("SELECT 1 FROM marketplace_items LIMIT 0").get();
  } catch {
    return null;
  }

  const items = db.prepare(
    `SELECT id, type, slug, name, description, version, author, icon, category, tags,
     price_cents, currency, source_type, install_count, avg_rating, review_count,
     status, featured, verified, package_data
     FROM marketplace_items
     ORDER BY featured DESC, install_count DESC, created_at DESC`,
  ).all() as DashboardMarketplace["items"];

  const total = items.length;
  const installed = items.filter(i => i.status === "installed" || i.status === "active").length;
  const active = items.filter(i => i.status === "active").length;
  const byType: Record<string, number> = {};
  for (const i of items) byType[i.type] = (byType[i.type] ?? 0) + 1;

  // Active theme
  const themeRow = db.prepare(
    `SELECT t.variables, t.fonts, t.custom_css, t.preview_colors, i.name, i.slug, i.icon
     FROM marketplace_themes t
     JOIN marketplace_items i ON i.id = t.item_id
     WHERE t.active = 1`,
  ).get() as { variables: string; fonts: string; custom_css: string; preview_colors: string; name: string; slug: string; icon: string } | undefined;

  const activeTheme = themeRow
    ? {
        name: themeRow.name,
        slug: themeRow.slug,
        icon: themeRow.icon,
        variables: JSON.parse(themeRow.variables),
        fonts: JSON.parse(themeRow.fonts),
        customCss: themeRow.custom_css,
        previewColors: JSON.parse(themeRow.preview_colors),
      }
    : null;

  // All themes for the theme picker
  const themes = db.prepare(
    `SELECT t.id, t.item_id, i.name, i.slug, i.icon, t.active, t.preview_colors, t.variables
     FROM marketplace_themes t
     JOIN marketplace_items i ON i.id = t.item_id
     ORDER BY t.active DESC, i.name ASC`,
  ).all() as DashboardMarketplace["themes"];

  return { items, stats: { total, installed, active, byType }, activeTheme, themes };
}
