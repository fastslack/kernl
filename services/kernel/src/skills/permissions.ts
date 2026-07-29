/**
 * Skill Permission System
 * Manages and validates skill permissions
 */

import { log } from "../core/logger.js";
import type { SkillPermission, SkillConfig, SkillManifest } from "./types.js";

/** Permission descriptions */
const PERMISSION_DESCRIPTIONS: Record<SkillPermission, string> = {
  "read:contacts": "Read your contacts",
  "write:contacts": "Create, modify, or delete contacts",
  "read:tasks": "Read your tasks",
  "write:tasks": "Create, modify, or delete tasks",
  "read:reminders": "Read your reminders",
  "write:reminders": "Create, modify, or delete reminders",
  "read:events": "Read your events",
  "write:events": "Create, modify, or delete events",
  "read:finance": "Read your financial data",
  "write:finance": "Create, modify, or delete financial records",
  "read:health": "Read your health data",
  "write:health": "Create, modify, or delete health records",
  "network": "Access the internet",
  "filesystem": "Read and write files",
  "notifications": "Send notifications",
  "voice": "Use voice synthesis and recognition",
};

/** Permission risk levels */
const PERMISSION_RISK: Record<SkillPermission, "low" | "medium" | "high"> = {
  "read:contacts": "low",
  "write:contacts": "medium",
  "read:tasks": "low",
  "write:tasks": "medium",
  "read:reminders": "low",
  "write:reminders": "medium",
  "read:events": "low",
  "write:events": "medium",
  "read:finance": "medium",
  "write:finance": "high",
  "read:health": "medium",
  "write:health": "high",
  "network": "medium",
  "filesystem": "high",
  "notifications": "low",
  "voice": "low",
};

/**
 * Get permission description
 */
export function getPermissionDescription(permission: SkillPermission): string {
  return PERMISSION_DESCRIPTIONS[permission] || permission;
}

/**
 * Get permission risk level
 */
export function getPermissionRisk(permission: SkillPermission): "low" | "medium" | "high" {
  return PERMISSION_RISK[permission] || "medium";
}

/**
 * Check if a skill has a specific permission
 */
export function hasPermission(
  config: SkillConfig,
  permission: SkillPermission
): boolean {
  return config.grantedPermissions.includes(permission);
}

/**
 * Check if a skill has all specified permissions
 */
export function hasAllPermissions(
  config: SkillConfig,
  permissions: SkillPermission[]
): boolean {
  return permissions.every((p) => hasPermission(config, p));
}

/**
 * Check if a skill has any of the specified permissions
 */
export function hasAnyPermission(
  config: SkillConfig,
  permissions: SkillPermission[]
): boolean {
  return permissions.some((p) => hasPermission(config, p));
}

/**
 * Validate permissions request
 */
export function validatePermissions(
  requested: SkillPermission[]
): { valid: boolean; invalid: string[] } {
  const allPermissions = Object.keys(PERMISSION_DESCRIPTIONS) as SkillPermission[];
  const invalid = requested.filter((p) => !allPermissions.includes(p));
  
  return {
    valid: invalid.length === 0,
    invalid,
  };
}

/**
 * Get missing permissions for a skill
 */
export function getMissingPermissions(
  manifest: SkillManifest,
  config: SkillConfig
): SkillPermission[] {
  return manifest.permissions.filter(
    (p) => !config.grantedPermissions.includes(p)
  );
}

/**
 * Get permission summary for display
 */
export function getPermissionSummary(permissions: SkillPermission[]): {
  low: SkillPermission[];
  medium: SkillPermission[];
  high: SkillPermission[];
} {
  return {
    low: permissions.filter((p) => getPermissionRisk(p) === "low"),
    medium: permissions.filter((p) => getPermissionRisk(p) === "medium"),
    high: permissions.filter((p) => getPermissionRisk(p) === "high"),
  };
}

/**
 * Create a permission guard for tool execution
 */
export function createPermissionGuard(
  skillId: string,
  config: SkillConfig,
  requiredPermissions: SkillPermission[]
): () => void {
  return () => {
    const missing = requiredPermissions.filter(
      (p) => !config.grantedPermissions.includes(p)
    );
    
    if (missing.length > 0) {
      log.warn(
        `Skill ${skillId} attempted to use tool without required permissions: ${missing.join(", ")}`
      );
      throw new Error(
        `Permission denied: skill "${skillId}" requires permissions: ${missing.join(", ")}`
      );
    }
  };
}

/**
 * Filter tools based on granted permissions
 */
export function filterToolsByPermissions<T extends { name: string }>(
  tools: T[],
  toolPermissions: Map<string, SkillPermission[]>,
  grantedPermissions: SkillPermission[]
): T[] {
  return tools.filter((tool) => {
    const required = toolPermissions.get(tool.name) || [];
    return required.every((p) => grantedPermissions.includes(p));
  });
}

/**
 * Default safe permissions (auto-granted)
 */
export const SAFE_PERMISSIONS: SkillPermission[] = [
  "read:tasks",
  "read:reminders",
  "read:events",
  "notifications",
];

/**
 * Permissions that require explicit user consent
 */
export const SENSITIVE_PERMISSIONS: SkillPermission[] = [
  "write:contacts",
  "write:finance",
  "write:health",
  "filesystem",
  "network",
];

/**
 * Generate permission request text for user
 */
export function formatPermissionRequest(
  manifest: SkillManifest
): string {
  const lines: string[] = [];
  
  lines.push(`Skill "${manifest.name}" (${manifest.id}) requests the following permissions:\n`);
  
  const summary = getPermissionSummary(manifest.permissions);
  
  if (summary.high.length > 0) {
    lines.push("High risk:");
    for (const p of summary.high) {
      lines.push(`  - ${getPermissionDescription(p)}`);
    }
    lines.push("");
  }
  
  if (summary.medium.length > 0) {
    lines.push("Medium risk:");
    for (const p of summary.medium) {
      lines.push(`  - ${getPermissionDescription(p)}`);
    }
    lines.push("");
  }
  
  if (summary.low.length > 0) {
    lines.push("Low risk:");
    for (const p of summary.low) {
      lines.push(`  - ${getPermissionDescription(p)}`);
    }
  }
  
  return lines.join("\n");
}
