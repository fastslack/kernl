/**
 * Skills System Types
 * Dynamic skill loading and permission management
 */

import type { ToolDefinition, ModuleContext } from "../core/types.js";

/** Skill permission categories */
export type SkillPermission =
  | "read:contacts"
  | "write:contacts"
  | "read:tasks"
  | "write:tasks"
  | "read:reminders"
  | "write:reminders"
  | "read:events"
  | "write:events"
  | "read:finance"
  | "write:finance"
  | "read:health"
  | "write:health"
  | "network"
  | "filesystem"
  | "notifications"
  | "voice";

/** Skill metadata */
export interface SkillMetadata {
  /** Unique skill identifier */
  id: string;
  /** Display name */
  name: string;
  /** Short description */
  description: string;
  /** Semantic version */
  version: string;
  /** Author name or organization */
  author: string;
  /** Homepage or repository URL */
  homepage?: string;
  /** Skill icon (emoji or URL) */
  icon?: string;
  /** Skill category */
  category?: "productivity" | "communication" | "finance" | "health" | "home" | "utility" | "custom";
  /** Required permissions */
  permissions: SkillPermission[];
  /** Tags for search */
  tags?: string[];
}

/** Skill manifest (SKILL.json) */
export interface SkillManifest extends SkillMetadata {
  /** Entry point file (relative to skill directory) */
  main: string;
  /** Minimum kernel version required */
  minKernelVersion?: string;
  /** Dependencies on other skills */
  dependencies?: string[];
  /** Configuration schema (JSON Schema) */
  configSchema?: Record<string, unknown>;
}

/** Skill configuration (user-provided) */
export interface SkillConfig {
  /** Whether the skill is enabled */
  enabled: boolean;
  /** Granted permissions (subset of requested) */
  grantedPermissions: SkillPermission[];
  /** User-provided configuration values */
  settings: Record<string, unknown>;
}

/** Skill instance (loaded skill) */
export interface Skill {
  /** Skill metadata */
  metadata: SkillMetadata;
  /** Tools provided by the skill */
  tools: ToolDefinition[];
  /** Initialize the skill */
  initialize(ctx: ModuleContext, config: SkillConfig): Promise<void>;
  /** Shutdown the skill */
  shutdown?(): Promise<void>;
}

/** Skill factory function (exported from skill entry point) */
export type SkillFactory = () => Skill;

/** Skill usage statistics */
export interface SkillUsageStats {
  /** Total number of tool calls */
  totalCalls: number;
  /** Successful calls */
  successCount: number;
  /** Failed calls */
  failureCount: number;
  /** Last call timestamp */
  lastCallAt?: string;
  /** Average response time in ms */
  avgResponseMs?: number;
  /** Per-tool statistics */
  tools: Record<string, {
    calls: number;
    successes: number;
    failures: number;
    avgMs?: number;
  }>;
}

/** Skill state in registry */
export interface SkillState {
  manifest: SkillManifest;
  config: SkillConfig;
  skill: Skill | null;
  status: "installed" | "enabled" | "disabled" | "error";
  error?: string;
  loadedAt?: Date;
  /** Usage statistics */
  usageStats?: SkillUsageStats;
}

/** Skill installation source */
export type SkillSource =
  | { type: "local"; path: string }
  | { type: "npm"; package: string; version?: string }
  | { type: "git"; url: string; ref?: string }
  | { type: "bundled"; id: string };

/** Skill registry configuration */
export interface SkillRegistryConfig {
  /** Directory containing installed skills */
  skillsPath: string;
  /** Directory for skill data */
  dataPath: string;
  /** Auto-enable new skills */
  autoEnable: boolean;
  /** Default permissions to grant */
  defaultPermissions: SkillPermission[];
  /** Blocked skills (by ID) */
  blockedSkills: string[];
}

/** Skill search result */
export interface SkillSearchResult {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  downloads?: number;
  rating?: number;
  source: SkillSource;
}

/** Events emitted by skill system */
export type SkillEvent =
  | { type: "skill:installed"; skillId: string }
  | { type: "skill:enabled"; skillId: string }
  | { type: "skill:disabled"; skillId: string }
  | { type: "skill:uninstalled"; skillId: string }
  | { type: "skill:error"; skillId: string; error: string };
