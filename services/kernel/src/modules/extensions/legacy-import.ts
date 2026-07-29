/**
 * One-shot import of legacy records into `installed_extensions`.
 *
 * Runs once at bootstrap after the extensions module is initialized.
 * Sources, in order:
 *   1. marketplace_items  → rows with status IN ('installed','active')
 *   2. installed_plugins  → type='module'
 *   3. skills-config.json → type='skill'
 *
 * Idempotent: rows are skipped if an extension with the same id already
 * exists. Legacy tables are NOT modified — they stay as historical record.
 *
 * Returns a summary for logging. A non-zero `errors` count does not block
 * bootstrap — legacy data corruption is survivable.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { SqliteDb } from "../../core/db/sqlite.js";
import { tableExists } from "../../core/db/query-helpers.js";
import { log } from "../../core/logger.js";
import { isoNow } from "../../core/helpers.js";
import type {
  ExtensionSource,
  ExtensionStatus,
  ExtensionType,
  InstalledExtension,
} from "./types.js";

export interface LegacyImportSummary {
  from_marketplace: number;
  from_plugins: number;
  from_skills: number;
  skipped: number;
  errors: number;
}

export async function importLegacyExtensions(
  db: SqliteDb,
  skillsConfigPath = join(process.cwd(), "data", "skills-config.json"),
): Promise<LegacyImportSummary> {
  const summary: LegacyImportSummary = {
    from_marketplace: 0,
    from_plugins: 0,
    from_skills: 0,
    skipped: 0,
    errors: 0,
  };

  const isTaken = db.prepare(
    "SELECT 1 FROM installed_extensions WHERE id = ? OR slug = ? LIMIT 1",
  );
  const insert = db.prepare(
    `INSERT INTO installed_extensions
       (id, slug, name, version, type, status, manifest_json, source_json,
        install_path, granted_permissions_json, settings_json, error,
        installed_at, updated_at, last_loaded_at, install_receipt_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const tryInsert = (row: InstalledExtension): "inserted" | "skipped" | "error" => {
    try {
      if (isTaken.get(row.id, row.slug)) return "skipped";
      insert.run(
        row.id, row.slug, row.name, row.version, row.type, row.status,
        row.manifest_json, row.source_json, row.install_path,
        row.granted_permissions_json, row.settings_json, row.error,
        row.installed_at, row.updated_at, row.last_loaded_at,
        row.install_receipt_json ?? "{}",
      );
      return "inserted";
    } catch (err) {
      log.warn(`Legacy import: failed to insert ${row.slug}: ${err}`);
      return "error";
    }
  };

  // 1. Marketplace — only rows that actually got installed.
  if (tableExists(db, "marketplace_items")) {
    const rows = db
      .prepare(
        `SELECT * FROM marketplace_items
         WHERE status IN ('installed','active')`,
      )
      .all() as MarketplaceItem[];
    for (const m of rows) {
      const record = marketplaceToExtension(m);
      const r = tryInsert(record);
      if (r === "inserted") summary.from_marketplace++;
      else if (r === "skipped") summary.skipped++;
      else summary.errors++;
    }
  }

  // 2. Installed plugins — always imported as type='module'.
  if (tableExists(db, "installed_plugins")) {
    const rows = db
      .prepare("SELECT * FROM installed_plugins")
      .all() as InstalledPluginRow[];
    for (const p of rows) {
      const record = pluginToExtension(p);
      if (!record) {
        summary.errors++;
        continue;
      }
      const r = tryInsert(record);
      if (r === "inserted") summary.from_plugins++;
      else if (r === "skipped") summary.skipped++;
      else summary.errors++;
    }
  }

  // 3. Skills config JSON on disk.
  if (existsSync(skillsConfigPath)) {
    try {
      const raw = await readFile(skillsConfigPath, "utf-8");
      const cfg = JSON.parse(raw) as SkillsConfigFile;
      for (const [skillId, state] of Object.entries(cfg.skills ?? {})) {
        const record = skillToExtension(skillId, state);
        const r = tryInsert(record);
        if (r === "inserted") summary.from_skills++;
        else if (r === "skipped") summary.skipped++;
        else summary.errors++;
      }
    } catch (err) {
      log.warn(`Legacy import: could not read ${skillsConfigPath}: ${err}`);
      summary.errors++;
    }
  }

  log.info(
    `Legacy extensions import: +${summary.from_marketplace} marketplace, ` +
      `+${summary.from_plugins} plugins, +${summary.from_skills} skills, ` +
      `${summary.skipped} skipped, ${summary.errors} errors`,
  );
  return summary;
}

// ── Source-specific mappers ───────────────────────────────────────────

interface MarketplaceItem {
  id: string;
  type: string;
  slug: string;
  name: string;
  description: string;
  version: string;
  author: string;
  license: string;
  category: string;
  tags: string;
  package_data: string;
  dependencies: string;
  min_kernel_version: string;
  status: string;
  installed_at: string | null;
  installed_version: string;
  created_at: string;
  updated_at: string;
}

function marketplaceToExtension(m: MarketplaceItem): InstalledExtension {
  const type = (
    m.type === "extension" ? "module" : m.type
  ) as ExtensionType;

  const manifest = {
    $schema: "kernl://extension/v1",
    id: normalizeId(m.id, m.slug),
    slug: m.slug,
    name: m.name,
    version: m.installed_version || m.version,
    type,
    description: m.description,
    author: m.author,
    license: m.license || "Unknown",
    category: m.category || "utility",
    tags: safeJsonArr(m.tags),
    kernel_min: m.min_kernel_version || undefined,
    dependencies: safeJsonArr(m.dependencies),
  };

  const source: ExtensionSource = { type: "bundled" };
  return {
    id: manifest.id,
    slug: m.slug,
    name: m.name,
    version: manifest.version,
    type,
    status: (m.status === "active" ? "active" : "installed") as ExtensionStatus,
    manifest_json: JSON.stringify(manifest),
    source_json: JSON.stringify(source),
    install_path: "",
    granted_permissions_json: "[]",
    settings_json: safeJson(m.package_data, "{}"),
    error: "",
    installed_at: m.installed_at ?? m.created_at,
    updated_at: m.updated_at,
    last_loaded_at: null,
    install_receipt_json: "{}",
  };
}

interface InstalledPluginRow {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  install_path: string;
  status: string;
  manifest_json: string;
  installed_at: string;
  updated_at: string;
}

function pluginToExtension(p: InstalledPluginRow): InstalledExtension | null {
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(p.manifest_json);
  } catch {
    return null;
  }

  const slug = slugify(p.name);
  const id = normalizeId(p.id, slug);
  const newManifest = {
    $schema: "kernl://extension/v1",
    id,
    slug,
    name: p.name,
    version: p.version,
    type: "module" as const,
    description: p.description || "(imported plugin)",
    author: p.author || "unknown",
    license: (manifest.license as string) || "Unknown",
    category: "utility",
    backend: (manifest.backend as object | undefined) ?? { entry: "backend/index.js" },
    frontend: manifest.frontend as object | undefined,
    dependencies: safeArr((manifest.dependencies as string[] | undefined) ?? []),
  };

  return {
    id,
    slug,
    name: p.name,
    version: p.version,
    type: "module",
    status: (p.status === "active" ? "active" : "disabled") as ExtensionStatus,
    manifest_json: JSON.stringify(newManifest),
    source_json: JSON.stringify({ type: "local", path: p.install_path }),
    install_path: p.install_path,
    granted_permissions_json: "[]",
    settings_json: "{}",
    error: "",
    installed_at: p.installed_at,
    updated_at: p.updated_at,
    last_loaded_at: null,
    install_receipt_json: "{}",
  };
}

interface SkillsConfigFile {
  skills?: Record<
    string,
    {
      enabled?: boolean;
      manifest?: Record<string, unknown>;
      grantedPermissions?: string[];
      settings?: Record<string, unknown>;
    }
  >;
}

function skillToExtension(
  skillId: string,
  state: NonNullable<SkillsConfigFile["skills"]>[string],
): InstalledExtension {
  const m = state.manifest ?? {};
  const slug = slugify(skillId);
  const id = normalizeId((m.id as string | undefined) ?? skillId, slug);
  const now = isoNow();
  const newManifest = {
    $schema: "kernl://extension/v1",
    id,
    slug,
    name: (m.name as string) ?? skillId,
    version: (m.version as string) ?? "0.0.1",
    type: "skill" as const,
    description: (m.description as string) ?? "(imported skill)",
    author: (m.author as string) ?? "unknown",
    license: (m.license as string) ?? "Unknown",
    category: (m.category as string) ?? "utility",
    permissions: state.grantedPermissions ?? [],
  };

  return {
    id,
    slug,
    name: newManifest.name,
    version: newManifest.version,
    type: "skill",
    status: state.enabled ? "active" : "disabled",
    manifest_json: JSON.stringify(newManifest),
    source_json: JSON.stringify({ type: "bundled" }),
    install_path: "",
    granted_permissions_json: JSON.stringify(state.grantedPermissions ?? []),
    settings_json: JSON.stringify(state.settings ?? {}),
    error: "",
    installed_at: now,
    updated_at: now,
    last_loaded_at: null,
    install_receipt_json: "{}",
  };
}

// ── Helpers ───────────────────────────────────────────────────────────

function safeJson(raw: string | null | undefined, fallback: string): string {
  if (!raw) return fallback;
  try {
    JSON.parse(raw);
    return raw;
  } catch {
    return fallback;
  }
}

function safeJsonArr(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function safeArr(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

function slugify(input: string): string {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return s.length >= 3 ? s : `ext-${s || "item"}`;
}

/**
 * Turn a non-DNS id (random uuid, plugin name) into a reverse-DNS id under
 * the "legacy.kernl" namespace so it satisfies the manifest schema.
 */
function normalizeId(raw: string, slug: string): string {
  if (/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/.test(raw)) return raw;
  return `legacy.kernl.${slug}`;
}
