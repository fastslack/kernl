import type { LocalizedText } from "../extensions/types.js";

export type SettingType = "string" | "number" | "boolean" | "secret" | "json";
export type SettingCategory =
  | "general"
  | "ai"
  | "chat"
  | "agents"
  | "notifications"
  | "integrations"
  | "life"
  | "security"
  | "advanced";

export interface AppSetting {
  key: string;
  value: string;
  type: SettingType;
  label: string;
  description: string;
  category: SettingCategory;
  sensitive: number;  // 0|1
  readonly: number;   // 0|1
  updated_at: string;
  updated_by: string;
}

/** Catalog entry: defines metadata for every known env-var / setting */
export interface SettingDef {
  key: string;
  /**
   * Either a plain string or a `{ locale: text }` map — the same shape
   * extension-contributed settings already used (`localizedTextSchema`), and
   * the one the dashboard's resolveText() has always accepted. The core
   * catalog shipped bare English while the extension fields beside it were
   * translatable, so a Spanish install rendered its own settings in English.
   */
  label: LocalizedText;
  description: LocalizedText;
  category: SettingCategory;
  type: SettingType;
  sensitive?: boolean;
  readonly?: boolean;
  /** Apply value to live KernelConfig after writing */
  applyToConfig?: (value: string, config: import("../../core/config.js").KernelConfig) => void;
}
