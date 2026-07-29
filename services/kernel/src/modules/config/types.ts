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
  label: string;
  description: string;
  category: SettingCategory;
  type: SettingType;
  sensitive?: boolean;
  readonly?: boolean;
  /** Apply value to live KernelConfig after writing */
  applyToConfig?: (value: string, config: import("../../core/config.js").KernelConfig) => void;
}
