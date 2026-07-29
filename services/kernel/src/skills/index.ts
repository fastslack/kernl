/**
 * Skills System
 * Dynamic skill loading and permission management
 */

// Types
export type {
  SkillPermission,
  SkillMetadata,
  SkillManifest,
  SkillConfig,
  Skill,
  SkillFactory,
  SkillState,
  SkillSource,
  SkillRegistryConfig,
  SkillSearchResult,
  SkillEvent,
} from "./types.js";

// Loader
export {
  loadManifest,
  loadSkill,
  discoverSkills,
  installSkill,
} from "./loader.js";

// Permissions
export {
  getPermissionDescription,
  getPermissionRisk,
  hasPermission,
  hasAllPermissions,
  hasAnyPermission,
  validatePermissions,
  getMissingPermissions,
  getPermissionSummary,
  createPermissionGuard,
  filterToolsByPermissions,
  formatPermissionRequest,
  SAFE_PERMISSIONS,
  SENSITIVE_PERMISSIONS,
} from "./permissions.js";

// Registry
export { SkillRegistry, createSkillRegistry } from "./registry.js";
