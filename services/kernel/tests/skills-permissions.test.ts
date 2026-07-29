/**
 * Tests for skills permission logic:
 *   - hasAllPermissions / getMissingPermissions
 *   - SAFE_PERMISSIONS list
 *   - auto-grant behavior (the pattern used by skills install API)
 *   - filterToolsByPermissions
 */

import { describe, it, expect } from "bun:test";
import {
  hasAllPermissions,
  hasPermission,
  getMissingPermissions,
  SAFE_PERMISSIONS,
  SENSITIVE_PERMISSIONS,
  validatePermissions,
  filterToolsByPermissions,
  getPermissionSummary,
} from "../src/skills/permissions.js";
import type { SkillConfig, SkillManifest, SkillPermission } from "../src/skills/types.js";

function makeConfig(granted: SkillPermission[]): SkillConfig {
  return {
    enabled: true,
    grantedPermissions: granted,
    settings: {},
  };
}

function makeManifest(permissions: SkillPermission[]): SkillManifest {
  return {
    id: "test-skill",
    name: "Test Skill",
    description: "A test skill",
    version: "1.0.0",
    author: "test",
    main: "index.js",
    permissions,
  };
}

describe("Skill Permissions", () => {

  describe("SAFE_PERMISSIONS", () => {
    it("includes read:tasks, read:reminders, read:events, notifications", () => {
      expect(SAFE_PERMISSIONS).toContain("read:tasks");
      expect(SAFE_PERMISSIONS).toContain("read:reminders");
      expect(SAFE_PERMISSIONS).toContain("read:events");
      expect(SAFE_PERMISSIONS).toContain("notifications");
    });

    it("does NOT include write permissions", () => {
      const writePerms = SAFE_PERMISSIONS.filter(p => p.startsWith("write:"));
      expect(writePerms).toHaveLength(0);
    });
  });

  describe("SENSITIVE_PERMISSIONS", () => {
    it("includes filesystem and network", () => {
      expect(SENSITIVE_PERMISSIONS).toContain("filesystem");
      expect(SENSITIVE_PERMISSIONS).toContain("network");
    });
  });

  describe("hasPermission", () => {
    it("returns true when permission is granted", () => {
      const config = makeConfig(["read:tasks", "notifications"]);
      expect(hasPermission(config, "read:tasks")).toBe(true);
      expect(hasPermission(config, "notifications")).toBe(true);
    });

    it("returns false when permission is not granted", () => {
      const config = makeConfig(["read:tasks"]);
      expect(hasPermission(config, "write:tasks")).toBe(false);
    });

    it("returns false for empty grantedPermissions", () => {
      const config = makeConfig([]);
      expect(hasPermission(config, "read:tasks")).toBe(false);
    });
  });

  describe("hasAllPermissions", () => {
    it("returns true when all permissions are granted", () => {
      const config = makeConfig(["read:tasks", "read:reminders", "notifications"]);
      expect(hasAllPermissions(config, ["read:tasks", "notifications"])).toBe(true);
    });

    it("returns false when any permission is missing", () => {
      const config = makeConfig(["read:tasks"]);
      expect(hasAllPermissions(config, ["read:tasks", "write:tasks"])).toBe(false);
    });

    it("returns true for empty permissions array", () => {
      const config = makeConfig([]);
      expect(hasAllPermissions(config, [])).toBe(true);
    });
  });

  describe("getMissingPermissions", () => {
    it("returns empty array when all permissions are granted", () => {
      const manifest = makeManifest(["read:tasks", "notifications"]);
      const config = makeConfig(["read:tasks", "notifications"]);
      expect(getMissingPermissions(manifest, config)).toHaveLength(0);
    });

    it("returns missing permissions", () => {
      const manifest = makeManifest(["read:tasks", "write:tasks", "notifications"]);
      const config = makeConfig(["read:tasks"]);
      const missing = getMissingPermissions(manifest, config);
      expect(missing).toContain("write:tasks");
      expect(missing).toContain("notifications");
      expect(missing).not.toContain("read:tasks");
    });
  });

  describe("auto-grant pattern (simulating skills install API)", () => {
    it("granting all required permissions makes getMissingPermissions empty", () => {
      const manifest = makeManifest(["read:tasks", "write:tasks", "read:contacts", "notifications"]);
      const config = makeConfig([]);

      // Simulate auto-grant on install
      const needed = manifest.permissions;
      config.grantedPermissions = [...needed];

      expect(getMissingPermissions(manifest, config)).toHaveLength(0);
      expect(hasAllPermissions(config, manifest.permissions)).toBe(true);
    });

    it("partial grant still leaves missing permissions", () => {
      const manifest = makeManifest(["read:tasks", "write:tasks"]);
      const config = makeConfig(["read:tasks"]); // only safe perms granted

      expect(getMissingPermissions(manifest, config)).toEqual(["write:tasks"]);
    });
  });

  describe("validatePermissions", () => {
    it("validates known permissions as valid", () => {
      const result = validatePermissions(["read:tasks", "write:tasks", "notifications"]);
      expect(result.valid).toBe(true);
      expect(result.invalid).toHaveLength(0);
    });

    it("flags unknown permissions as invalid", () => {
      const result = validatePermissions(["read:tasks", "fly:helicopter" as SkillPermission]);
      expect(result.valid).toBe(false);
      expect(result.invalid).toContain("fly:helicopter");
    });
  });

  describe("filterToolsByPermissions", () => {
    it("includes tools with no permission requirements", () => {
      const tools = [{ name: "open_tool" }];
      const permsMap = new Map<string, SkillPermission[]>(); // no entries = no required perms
      const result = filterToolsByPermissions(tools, permsMap, ["read:tasks"]);
      expect(result).toHaveLength(1);
    });

    it("includes tools whose permissions are all granted", () => {
      const tools = [{ name: "tasks_tool" }];
      const permsMap = new Map<string, SkillPermission[]>([
        ["tasks_tool", ["read:tasks"]],
      ]);
      const result = filterToolsByPermissions(tools, permsMap, ["read:tasks", "notifications"]);
      expect(result).toHaveLength(1);
    });

    it("excludes tools with ungranted permissions", () => {
      const tools = [{ name: "write_tool" }];
      const permsMap = new Map<string, SkillPermission[]>([
        ["write_tool", ["write:tasks"]],
      ]);
      const result = filterToolsByPermissions(tools, permsMap, ["read:tasks"]);
      expect(result).toHaveLength(0);
    });

    it("only includes tools whose permissions are fully covered", () => {
      const tools = [
        { name: "read_tool" },
        { name: "write_tool" },
        { name: "free_tool" },
      ];
      const permsMap = new Map<string, SkillPermission[]>([
        ["read_tool", ["read:tasks"]],
        ["write_tool", ["write:tasks"]],
        // free_tool has no entry = no requirements
      ]);
      const result = filterToolsByPermissions(tools, permsMap, ["read:tasks"]);
      expect(result.map(t => t.name)).toEqual(["read_tool", "free_tool"]);
    });
  });

  describe("getPermissionSummary", () => {
    it("classifies permissions into low/medium/high risk tiers", () => {
      const summary = getPermissionSummary(["read:tasks", "write:tasks", "filesystem"]);
      // read:tasks is low, write:tasks is medium, filesystem is high
      expect(summary.low.length + summary.medium.length + summary.high.length).toBe(3);
    });

    it("returns empty tiers for no permissions", () => {
      const summary = getPermissionSummary([]);
      expect(summary.low).toHaveLength(0);
      expect(summary.medium).toHaveLength(0);
      expect(summary.high).toHaveLength(0);
    });
  });
});
