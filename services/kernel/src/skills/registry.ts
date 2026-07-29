/**
 * Skill Registry
 * Manages installed skills, their configuration, and lifecycle
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { log } from "../core/logger.js";
import type { ModuleContext, ToolDefinition } from "../core/types.js";
import type { EventBus } from "../core/event-bus.js";
import {
  loadManifest,
  loadSkill,
  discoverSkills,
  installSkill,
} from "./loader.js";
import {
  hasAllPermissions,
  getMissingPermissions,
  SAFE_PERMISSIONS,
} from "./permissions.js";
import type {
  SkillState,
  SkillConfig,
  SkillManifest,
  SkillSource,
  SkillRegistryConfig,
  SkillPermission,
  SkillEvent,
} from "./types.js";

const CONFIG_FILE = "skills-config.json";

/**
 * Skill Registry
 * Central manager for all skills
 */
export class SkillRegistry {
  private skills: Map<string, SkillState> = new Map();
  private configs: Map<string, SkillConfig> = new Map();
  private ctx: ModuleContext | null = null;

  constructor(
    private config: SkillRegistryConfig,
    private events?: EventBus
  ) {
    // Ensure directories exist
    mkdirSync(config.skillsPath, { recursive: true });
    mkdirSync(config.dataPath, { recursive: true });

    // Load saved configs
    this.loadConfigs();
  }

  /**
   * Initialize the registry and load all skills
   */
  async initialize(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;

    log.info("SkillRegistry: initializing...");

    // Discover installed skills
    const manifests = await discoverSkills(this.config.skillsPath);

    for (const [id, manifest] of manifests) {
      await this.registerSkill(manifest);
    }

    // Enable skills that are configured as enabled
    for (const [id, state] of this.skills) {
      if (state.config.enabled) {
        await this.enableSkill(id);
      }
    }

    log.info(`SkillRegistry: initialized with ${this.skills.size} skills`);
  }

  /**
   * Shutdown all skills
   */
  async shutdown(): Promise<void> {
    log.info("SkillRegistry: shutting down...");

    for (const [id, state] of this.skills) {
      if (state.skill?.shutdown) {
        try {
          await state.skill.shutdown();
        } catch (err) {
          log.error(`Failed to shutdown skill ${id}`, err);
        }
      }
    }

    this.saveConfigs();
    log.info("SkillRegistry: shutdown complete");
  }

  /**
   * Register a skill (without enabling)
   */
  private async registerSkill(manifest: SkillManifest): Promise<void> {
    // Check if blocked
    if (this.config.blockedSkills.includes(manifest.id)) {
      log.warn(`Skill ${manifest.id} is blocked`);
      return;
    }

    // Get or create config
    let config = this.configs.get(manifest.id);
    if (!config) {
      config = {
        enabled: this.config.autoEnable,
        grantedPermissions: this.config.defaultPermissions.filter((p) =>
          manifest.permissions.includes(p)
        ),
        settings: {},
      };
      this.configs.set(manifest.id, config);
    }

    // Create state
    const state: SkillState = {
      manifest,
      config,
      skill: null,
      status: "installed",
    };

    this.skills.set(manifest.id, state);
    log.debug(`Registered skill: ${manifest.id}`);
  }

  /**
   * Install a skill from a source
   */
  async install(source: SkillSource): Promise<string | null> {
    const manifest = await installSkill(source, this.config.skillsPath);
    
    if (!manifest) {
      return null;
    }

    await this.registerSkill(manifest);
    this.emitEvent({ type: "skill:installed", skillId: manifest.id });
    this.saveConfigs();

    return manifest.id;
  }

  /**
   * Uninstall a skill
   */
  async uninstall(skillId: string): Promise<boolean> {
    const state = this.skills.get(skillId);
    if (!state) {
      log.warn(`Skill ${skillId} not found`);
      return false;
    }

    // Disable first
    if (state.status === "enabled") {
      await this.disableSkill(skillId);
    }

    // Remove directory
    const { rmSync } = await import("fs");
    const skillPath = join(this.config.skillsPath, skillId);

    try {
      rmSync(skillPath, { recursive: true, force: true });
    } catch (err) {
      log.error(`Failed to remove skill directory: ${skillPath}`, err);
      return false;
    }

    // Remove from registry
    this.skills.delete(skillId);
    this.configs.delete(skillId);
    
    this.emitEvent({ type: "skill:uninstalled", skillId });
    this.saveConfigs();

    log.info(`Uninstalled skill: ${skillId}`);
    return true;
  }

  /**
   * Enable a skill
   */
  async enableSkill(skillId: string): Promise<boolean> {
    const state = this.skills.get(skillId);
    if (!state) {
      log.warn(`Skill ${skillId} not found`);
      return false;
    }

    if (state.status === "enabled") {
      return true;
    }

    if (!this.ctx) {
      log.error("Cannot enable skill: registry not initialized");
      return false;
    }

    // Check permissions
    const missing = getMissingPermissions(state.manifest, state.config);
    if (missing.length > 0) {
      log.warn(
        `Skill ${skillId} cannot be enabled: missing permissions: ${missing.join(", ")}`
      );
      state.status = "error";
      state.error = `Missing permissions: ${missing.join(", ")}`;
      return false;
    }

    // Load the skill
    const skillPath = join(this.config.skillsPath, skillId);
    const skill = await loadSkill(skillPath, state.manifest);

    if (!skill) {
      state.status = "error";
      state.error = "Failed to load skill";
      return false;
    }

    // Initialize
    try {
      await skill.initialize(this.ctx, state.config);
      
      state.skill = skill;
      state.status = "enabled";
      state.config.enabled = true;
      state.loadedAt = new Date();
      state.error = undefined;

      this.emitEvent({ type: "skill:enabled", skillId });
      this.saveConfigs();

      log.info(`Enabled skill: ${skillId}`);
      return true;
    } catch (err) {
      state.status = "error";
      state.error = err instanceof Error ? err.message : "Unknown error";
      this.emitEvent({ type: "skill:error", skillId, error: state.error });
      log.error(`Failed to enable skill ${skillId}`, err);
      return false;
    }
  }

  /**
   * Disable a skill
   */
  async disableSkill(skillId: string): Promise<boolean> {
    const state = this.skills.get(skillId);
    if (!state) {
      log.warn(`Skill ${skillId} not found`);
      return false;
    }

    if (state.status !== "enabled") {
      return true;
    }

    // Shutdown
    if (state.skill?.shutdown) {
      try {
        await state.skill.shutdown();
      } catch (err) {
        log.error(`Error shutting down skill ${skillId}`, err);
      }
    }

    state.skill = null;
    state.status = "disabled";
    state.config.enabled = false;
    state.loadedAt = undefined;

    this.emitEvent({ type: "skill:disabled", skillId });
    this.saveConfigs();

    log.info(`Disabled skill: ${skillId}`);
    return true;
  }

  /**
   * Grant permissions to a skill
   */
  grantPermissions(skillId: string, permissions: SkillPermission[]): boolean {
    const state = this.skills.get(skillId);
    if (!state) return false;

    // Only grant permissions that the skill requested
    const validPermissions = permissions.filter((p) =>
      state.manifest.permissions.includes(p)
    );

    for (const p of validPermissions) {
      if (!state.config.grantedPermissions.includes(p)) {
        state.config.grantedPermissions.push(p);
      }
    }

    this.saveConfigs();
    return true;
  }

  /**
   * Revoke permissions from a skill
   */
  revokePermissions(skillId: string, permissions: SkillPermission[]): boolean {
    const state = this.skills.get(skillId);
    if (!state) return false;

    state.config.grantedPermissions = state.config.grantedPermissions.filter(
      (p) => !permissions.includes(p)
    );

    this.saveConfigs();
    return true;
  }

  /**
   * Get all tools from enabled skills
   */
  getTools(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];

    for (const [id, state] of this.skills) {
      if (state.status === "enabled" && state.skill) {
        // Prefix tool names with skill ID for namespacing
        for (const tool of state.skill.tools) {
          tools.push({
            ...tool,
            name: `skill_${id}_${tool.name}`,
          });
        }
      }
    }

    return tools;
  }

  /**
   * Get skill state
   */
  getSkill(skillId: string): SkillState | undefined {
    return this.skills.get(skillId);
  }

  /**
   * Get all skills
   */
  getAllSkills(): Map<string, SkillState> {
    return new Map(this.skills);
  }

  /**
   * Get enabled skills
   */
  getEnabledSkills(): SkillState[] {
    return Array.from(this.skills.values()).filter(
      (s) => s.status === "enabled"
    );
  }

  /**
   * Update skill settings
   */
  updateSettings(skillId: string, settings: Record<string, unknown>): boolean {
    const state = this.skills.get(skillId);
    if (!state) return false;

    state.config.settings = { ...state.config.settings, ...settings };
    this.saveConfigs();
    return true;
  }

  // ── Usage Tracking ──────────────────────────────────

  /**
   * Record a tool call for usage statistics
   */
  recordToolCall(
    skillId: string,
    toolName: string,
    success: boolean,
    responseTimeMs?: number,
  ): void {
    const state = this.skills.get(skillId);
    if (!state) return;

    // Initialize stats if needed
    if (!state.usageStats) {
      state.usageStats = {
        totalCalls: 0,
        successCount: 0,
        failureCount: 0,
        tools: {},
      };
    }

    const stats = state.usageStats;
    stats.totalCalls++;
    stats.lastCallAt = new Date().toISOString();

    if (success) {
      stats.successCount++;
    } else {
      stats.failureCount++;
    }

    // Track per-tool stats
    if (!stats.tools[toolName]) {
      stats.tools[toolName] = { calls: 0, successes: 0, failures: 0 };
    }

    const toolStats = stats.tools[toolName];
    toolStats.calls++;
    if (success) {
      toolStats.successes++;
    } else {
      toolStats.failures++;
    }

    // Update average response time
    if (responseTimeMs !== undefined) {
      if (toolStats.avgMs === undefined) {
        toolStats.avgMs = responseTimeMs;
      } else {
        // Rolling average
        toolStats.avgMs = (toolStats.avgMs * (toolStats.calls - 1) + responseTimeMs) / toolStats.calls;
      }

      if (stats.avgResponseMs === undefined) {
        stats.avgResponseMs = responseTimeMs;
      } else {
        stats.avgResponseMs = (stats.avgResponseMs * (stats.totalCalls - 1) + responseTimeMs) / stats.totalCalls;
      }
    }

    // Emit event if failure rate is high
    const failureRate = stats.failureCount / stats.totalCalls;
    if (stats.totalCalls >= 10 && failureRate > 0.3) {
      this.emitEvent({
        type: "skill:error",
        skillId,
        error: `High failure rate: ${(failureRate * 100).toFixed(1)}% (${stats.failureCount}/${stats.totalCalls})`,
      });
    }
  }

  /**
   * Get usage statistics for a skill
   */
  getUsageStats(skillId: string): SkillState["usageStats"] | undefined {
    return this.skills.get(skillId)?.usageStats;
  }

  /**
   * Get all skills with usage statistics
   */
  getUsageReport(): Array<{
    skillId: string;
    name: string;
    stats: SkillState["usageStats"];
    failureRate: number;
  }> {
    const report: Array<{
      skillId: string;
      name: string;
      stats: SkillState["usageStats"];
      failureRate: number;
    }> = [];

    for (const [skillId, state] of this.skills) {
      if (!state.usageStats) continue;

      const failureRate = state.usageStats.totalCalls > 0
        ? state.usageStats.failureCount / state.usageStats.totalCalls
        : 0;

      report.push({
        skillId,
        name: state.manifest.name,
        stats: state.usageStats,
        failureRate,
      });
    }

    // Sort by total calls descending
    return report.sort((a, b) => (b.stats?.totalCalls ?? 0) - (a.stats?.totalCalls ?? 0));
  }

  /**
   * Reset usage statistics for a skill
   */
  resetUsageStats(skillId: string): boolean {
    const state = this.skills.get(skillId);
    if (!state) return false;

    state.usageStats = undefined;
    return true;
  }

  // ── Persistence ─────────────────────────────────────

  private loadConfigs(): void {
    const configPath = join(this.config.dataPath, CONFIG_FILE);
    
    if (!existsSync(configPath)) {
      return;
    }

    try {
      const content = readFileSync(configPath, "utf-8");
      const data = JSON.parse(content) as Record<string, SkillConfig>;

      for (const [id, config] of Object.entries(data)) {
        this.configs.set(id, config);
      }

      log.debug(`Loaded ${this.configs.size} skill configs`);
    } catch (err) {
      log.error("Failed to load skill configs", err);
    }
  }

  private saveConfigs(): void {
    const configPath = join(this.config.dataPath, CONFIG_FILE);
    
    try {
      const data: Record<string, SkillConfig> = {};
      for (const [id, config] of this.configs) {
        data[id] = config;
      }

      writeFileSync(configPath, JSON.stringify(data, null, 2));
      log.debug("Saved skill configs");
    } catch (err) {
      log.error("Failed to save skill configs", err);
    }
  }

  private emitEvent(event: SkillEvent): void {
    if (this.events) {
      this.events.emit(event.type, event);
    }
  }
}

/**
 * Create a SkillRegistry with default configuration
 */
export function createSkillRegistry(
  basePath: string,
  events?: EventBus
): SkillRegistry {
  return new SkillRegistry(
    {
      skillsPath: join(basePath, "assets", "skills"),
      dataPath: join(basePath, "data"),
      autoEnable: false,
      defaultPermissions: SAFE_PERMISSIONS,
      blockedSkills: [],
    },
    events
  );
}
