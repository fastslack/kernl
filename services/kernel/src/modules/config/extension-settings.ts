/**
 * Extension-contributed settings.
 *
 * Active extensions may declare a `settings` block in their manifest
 * (see ExtensionSettingsBlock in modules/extensions/types.ts). This registry
 * rebuilds the full picture from the extensions table on demand — no event
 * plumbing needed: installing/activating/deactivating an extension is
 * reflected on the next catalog fetch.
 *
 * Keys are namespaced `ext.<slug>.<name>`; the prefix is added when missing.
 * Values live in the same `app_settings` table as core settings and survive
 * uninstall (so a reinstall keeps user configuration).
 */

import type { SettingDef, SettingType } from "./types.js";
import type {
  ExtensionManifest,
  ExtensionSettingsField,
  LocalizedText,
} from "../extensions/types.js";
import { log } from "../../core/logger.js";

const VALID_TYPES: ReadonlySet<string> = new Set([
  "string", "number", "boolean", "secret", "json",
]);

/** Minimal duck-type of ExtensionService — avoids a hard module dependency. */
export interface ExtensionRowLike {
  slug: string;
  name: string;
  status: string;
  manifest_json: string;
}
export interface ExtensionServiceLike {
  list(filters?: { status?: string }): ExtensionRowLike[];
}

export interface ExtensionSettingDef extends SettingDef {
  extension: string;
  default: string;
  labelI18n: LocalizedText;
  descriptionI18n: LocalizedText;
}

export interface ExtensionSettingsSection {
  extension: string;
  id: string;
  label: LocalizedText;
  icon?: string;
  fields: ExtensionSettingDef[];
}

function asPlainString(text: LocalizedText | undefined, fallback = ""): string {
  if (!text) return fallback;
  if (typeof text === "string") return text;
  return text.en ?? text.es ?? Object.values(text)[0] ?? fallback;
}

/** Env-style key (ALL_CAPS_SNAKE): passed through unchanged so extensions can
 * surface legacy `process.env.X` reads in the UI (values hot-apply because
 * ConfigService.set() mutates process.env). Anything else gets namespaced. */
const ENV_STYLE = /^[A-Z][A-Z0-9_]*$/;

function namespaceKey(slug: string, key: string): string {
  if (ENV_STYLE.test(key)) return key;
  const prefix = `ext.${slug}.`;
  return key.startsWith(prefix) ? key : key.startsWith("ext.") ? key : prefix + key;
}

export class ExtensionSettingsRegistry {
  private sections: ExtensionSettingsSection[] = [];
  /** key → def. Shared by reference with ConfigService for set() validation. */
  readonly defs = new Map<string, SettingDef>();

  /**
   * Rebuild wholesale from the active extensions that declare settings.
   * `isCoreKey` excludes keys already owned by the core catalog (an extension
   * cannot shadow or duplicate a core setting).
   */
  sync(extensions: ExtensionServiceLike, isCoreKey: (key: string) => boolean = () => false): void {
    const next: ExtensionSettingsSection[] = [];
    const nextDefs = new Map<string, ExtensionSettingDef>();

    let rows: ExtensionRowLike[] = [];
    try {
      rows = extensions.list({ status: "active" });
    } catch (err) {
      log.warn("ExtensionSettings: could not list extensions", err);
      return;
    }

    for (const row of rows) {
      let manifest: ExtensionManifest;
      try {
        manifest = JSON.parse(row.manifest_json) as ExtensionManifest;
      } catch {
        continue;
      }
      const block = manifest.settings;
      if (!block || !Array.isArray(block.fields) || block.fields.length === 0) continue;

      const fields: ExtensionSettingDef[] = [];
      for (const f of block.fields) {
        if (!f?.key || !VALID_TYPES.has(f.type)) {
          log.warn(`ExtensionSettings: ${row.slug} declares invalid field ${JSON.stringify(f?.key)}`);
          continue;
        }
        const key = namespaceKey(row.slug, f.key);
        if (nextDefs.has(key)) {
          log.warn(`ExtensionSettings: duplicate key ${key} (from ${row.slug}) ignored`);
          continue;
        }
        if (isCoreKey(key)) {
          log.warn(`ExtensionSettings: ${row.slug} tried to shadow core setting ${key} — ignored`);
          continue;
        }
        fields.push({
          key,
          type: f.type as SettingType,
          label: asPlainString(f.label, key),
          description: asPlainString(f.description),
          labelI18n: f.label ?? key,
          descriptionI18n: f.description ?? "",
          category: "integrations",
          sensitive: f.type === "secret",
          extension: row.slug,
          default: f.default ?? "",
        });
      }
      if (!fields.length) continue;

      for (const f of fields) nextDefs.set(f.key, f);
      next.push({
        extension: row.slug,
        id: block.section?.id ?? row.slug,
        label: block.section?.label ?? row.name ?? row.slug,
        icon: block.section?.icon,
        fields,
      });
    }

    this.sections = next;
    this.defs.clear();
    for (const [k, v] of nextDefs) this.defs.set(k, v);
  }

  getSections(): ExtensionSettingsSection[] {
    return this.sections;
  }

  /** Flat list of all extension setting defs (for seeding). */
  allDefs(): ExtensionSettingDef[] {
    return this.sections.flatMap((s) => s.fields);
  }
}
