/**
 * Skills HTTP API Routes
 * REST endpoints for managing the skill registry
 */

import { HttpError, type KernelHttpServer } from "../../core/http-server.js";
import type { SkillRegistry } from "../../skills/registry.js";
import type { SkillPermission } from "../../skills/types.js";
import { log } from "../../core/logger.js";

export function registerSkillRoutes(
  server: KernelHttpServer,
  skillRegistry: SkillRegistry,
): void {

  // GET /api/skills — list all installed skills
  server.route("GET", "/api/skills", () => {
    const skills = skillRegistry.getAllSkills();
    const result = Array.from(skills.entries()).map(([id, state]) => ({
      id,
      name: state.manifest.name,
      description: state.manifest.description,
      version: state.manifest.version,
      author: state.manifest.author,
      homepage: state.manifest.homepage ?? null,
      icon: state.manifest.icon ?? null,
      category: state.manifest.category ?? "custom",
      status: state.status,
      permissions: state.manifest.permissions,
      grantedPermissions: state.config.grantedPermissions,
      tags: state.manifest.tags ?? [],
      toolCount: state.skill ? state.skill.tools.length : 0,
      loadedAt: state.loadedAt ?? null,
      error: state.error ?? null,
    }));
    return { skills: result, total: result.length };
  });

  // GET /api/skills/detail?id= — get single skill
  server.route("GET", "/api/skills/detail", ({ query }) => {
    const id = query.get("id");
    if (!id) throw new HttpError(400, "id required");

    const state = skillRegistry.getSkill(id);
    if (!state) throw new HttpError(404, "Skill not found");

    return {
      id,
      name: state.manifest.name,
      description: state.manifest.description,
      version: state.manifest.version,
      author: state.manifest.author,
      homepage: state.manifest.homepage ?? null,
      icon: state.manifest.icon ?? null,
      category: state.manifest.category ?? "custom",
      status: state.status,
      permissions: state.manifest.permissions,
      grantedPermissions: state.config.grantedPermissions,
      tags: state.manifest.tags ?? [],
      configSchema: state.manifest.configSchema ?? null,
      settings: state.config.settings,
      toolCount: state.skill ? state.skill.tools.length : 0,
      tools: state.skill ? state.skill.tools.map(t => ({ name: t.name, description: t.description })) : [],
      loadedAt: state.loadedAt ?? null,
      error: state.error ?? null,
    };
  });

  // POST /api/skills/install — install from local, npm, git, or bundled
  server.route<{
    type: string;
    path?: string;
    package?: string;
    version?: string;
    url?: string;
    ref?: string;
    id?: string;
    autoEnable?: boolean;
  }>("POST", "/api/skills/install", async ({ body }) => {
    if (!body.type) throw new HttpError(400, "type required (local|npm|git|bundled)");

    // For bundled skills already registered in the registry, just enable them
    if (body.type === "bundled" && body.id) {
      const existing = skillRegistry.getSkill(body.id);
      if (existing) {
        if (body.autoEnable !== false && existing.status !== "enabled") {
          // Auto-grant all required permissions so enable succeeds
          const needed = existing.manifest.permissions as SkillPermission[];
          if (needed.length > 0) skillRegistry.grantPermissions(body.id, needed);
          await skillRegistry.enableSkill(body.id);
        }
        const state = skillRegistry.getSkill(body.id);
        return { success: true, skillId: body.id, status: state?.status ?? "installed" };
      }
    }

    let source: Parameters<typeof skillRegistry.install>[0];
    switch (body.type) {
      case "local":
        if (!body.path) throw new HttpError(400, "path required for local install");
        source = { type: "local", path: body.path };
        break;
      case "npm":
        if (!body.package) throw new HttpError(400, "package required for npm install");
        source = { type: "npm", package: body.package, version: body.version };
        break;
      case "git":
        if (!body.url) throw new HttpError(400, "url required for git install");
        source = { type: "git", url: body.url, ref: body.ref };
        break;
      case "bundled":
        if (!body.id) throw new HttpError(400, "id required for bundled install");
        source = { type: "bundled", id: body.id };
        break;
      default:
        throw new HttpError(400, `Unknown install type: ${body.type}`);
    }

    const skillId = await skillRegistry.install(source);
    if (!skillId) throw new HttpError(500, "Installation failed — check server logs");

    // Auto-enable if requested: first grant all required permissions
    if (body.autoEnable !== false) {
      const freshState = skillRegistry.getSkill(skillId);
      if (freshState) {
        const needed = freshState.manifest.permissions as SkillPermission[];
        if (needed.length > 0) skillRegistry.grantPermissions(skillId, needed);
      }
      await skillRegistry.enableSkill(skillId);
    }

    const state = skillRegistry.getSkill(skillId);
    return {
      success: true,
      skillId,
      status: state?.status ?? "installed",
    };
  });

  // POST /api/skills/enable — enable a skill
  server.route<{ id: string; grantPermissions?: boolean }>("POST", "/api/skills/enable", async ({ body }) => {
    if (!body.id) throw new HttpError(400, "id required");

    // Auto-grant all required permissions if requested (default: true for convenience)
    const autoGrant = body.grantPermissions !== false;
    if (autoGrant) {
      const state = skillRegistry.getSkill(body.id);
      if (state?.manifest.permissions) {
        skillRegistry.grantPermissions(body.id, state.manifest.permissions);
      }
    }

    if (!(await skillRegistry.enableSkill(body.id))) {
      throw new HttpError(400, skillRegistry.getSkill(body.id)?.error ?? "Failed to enable skill");
    }
    return { success: true };
  });

  // POST /api/skills/disable — disable a skill
  server.route<{ id: string }>("POST", "/api/skills/disable", async ({ body }) => {
    if (!body.id) throw new HttpError(400, "id required");
    await skillRegistry.disableSkill(body.id);
    return { success: true };
  });

  // DELETE /api/skills/uninstall?id= — uninstall a skill
  server.route("DELETE", "/api/skills/uninstall", async ({ query }) => {
    const id = query.get("id");
    if (!id) throw new HttpError(400, "id required");
    if (!(await skillRegistry.uninstall(id))) throw new HttpError(404, "Skill not found or failed to remove");
    return { success: true };
  });

  // POST /api/skills/permissions — grant/revoke permissions
  server.route<{
    id: string;
    action: "grant" | "revoke";
    permissions: string[];
  }>("POST", "/api/skills/permissions", ({ body }) => {
    if (!body.id || !body.action || !body.permissions) {
      throw new HttpError(400, "id, action, and permissions required");
    }

    const perms = body.permissions as Parameters<typeof skillRegistry.grantPermissions>[1];
    if (body.action === "grant") {
      skillRegistry.grantPermissions(body.id, perms);
    } else {
      skillRegistry.revokePermissions(body.id, perms);
    }
    return { success: true };
  });

  // POST /api/skills/settings — update skill settings
  server.route<{ id: string; settings: Record<string, unknown> }>("POST", "/api/skills/settings", ({ body }) => {
    if (!body.id || !body.settings) throw new HttpError(400, "id and settings required");
    if (!skillRegistry.updateSettings(body.id, body.settings)) throw new HttpError(404, "Skill not found");
    return { success: true };
  });

  // GET /api/skills/catalog — built-in skill catalog (marketplace)
  server.route("GET", "/api/skills/catalog", () => {
    const installed = skillRegistry.getAllSkills();
    const catalog = BUNDLED_CATALOG.map(item => ({
      ...item,
      installed: installed.has(item.id),
      status: installed.get(item.id)?.status ?? null,
    }));
    return { catalog };
  });

  log.info("Skill routes registered (/api/skills/*)");
}

/** Built-in catalog of bundled skills available for install */
const BUNDLED_CATALOG = [
  {
    id: "morning-briefing",
    name: "Morning Briefing",
    description: "Generates a personalized daily briefing with tasks, reminders, weather and key metrics every morning",
    version: "1.0.0",
    author: "Kernl",
    icon: "☀️",
    category: "productivity",
    tags: ["automation", "daily", "briefing", "morning"],
    permissions: ["read:tasks", "read:reminders", "notifications"],
    source: { type: "bundled", id: "morning-briefing" },
    installed: false,
  },
  {
    id: "stale-contacts",
    name: "Stale Contacts Monitor",
    description: "Monitors contacts you haven't interacted with in a while and surfaces them for follow-up",
    version: "1.0.0",
    author: "Kernl",
    icon: "👤",
    category: "productivity",
    tags: ["crm", "contacts", "follow-up", "automation"],
    permissions: ["read:contacts", "notifications"],
    source: { type: "bundled", id: "stale-contacts" },
    installed: false,
  },
  {
    id: "task-prioritizer",
    name: "Task Prioritizer",
    description: "Analyzes your task backlog and automatically re-prioritizes based on deadlines, dependencies and context",
    version: "1.0.0",
    author: "Kernl",
    icon: "⚡",
    category: "productivity",
    tags: ["tasks", "gtd", "priority", "automation"],
    permissions: ["read:tasks", "write:tasks", "notifications"],
    source: { type: "bundled", id: "task-prioritizer" },
    installed: false,
  },
  {
    id: "water-tracker",
    name: "Water Tracker",
    description: "Reminds you to drink water throughout the day based on your daily goal and current intake",
    version: "1.0.0",
    author: "Kernl",
    icon: "💧",
    category: "health",
    tags: ["health", "habits", "reminders", "wellness"],
    permissions: ["read:reminders", "write:reminders", "notifications"],
    source: { type: "bundled", id: "water-tracker" },
    installed: false,
  },
  {
    id: "event-notifier",
    name: "Event Notifier",
    description: "Formats upcoming events into ready-to-share notification messages for Telegram, WhatsApp, or Mattermost",
    version: "1.0.0",
    author: "Kernl",
    icon: "📣",
    category: "events",
    tags: ["events", "notifications", "sharing", "automation"],
    permissions: ["read:events", "notifications"],
    source: { type: "bundled", id: "event-notifier" },
    installed: false,
  },
];
