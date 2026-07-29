/**
 * Skills HTTP API Routes
 * REST endpoints for managing the skill registry
 */

import type { KernelHttpServer } from "../../core/http-server.js";
import type { SkillRegistry } from "../../skills/registry.js";
import type { SkillPermission } from "../../skills/types.js";
import { log } from "../../core/logger.js";

export function registerSkillRoutes(
  server: KernelHttpServer,
  skillRegistry: SkillRegistry,
): void {

  // GET /api/skills — list all installed skills
  server.get("/api/skills", (_req, res) => {
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
    server.json(res, 200, { skills: result, total: result.length });
  });

  // GET /api/skills/:id — get single skill
  server.get("/api/skills/detail", (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const id = url.searchParams.get("id");
    if (!id) { server.json(res, 400, { error: "id required" }); return; }

    const state = skillRegistry.getSkill(id);
    if (!state) { server.json(res, 404, { error: "Skill not found" }); return; }

    server.json(res, 200, {
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
    });
  });

  // POST /api/skills/install — install from local, npm, git, or bundled
  server.post("/api/skills/install", async (req, res) => {
    try {
      const body = await server.parseBody<{
        type: string;
        path?: string;
        package?: string;
        version?: string;
        url?: string;
        ref?: string;
        id?: string;
        autoEnable?: boolean;
      }>(req);

      if (!body.type) { server.json(res, 400, { error: "type required (local|npm|git|bundled)" }); return; }

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
          server.json(res, 200, { success: true, skillId: body.id, status: state?.status ?? "installed" });
          return;
        }
      }

      let source: Parameters<typeof skillRegistry.install>[0];
      switch (body.type) {
        case "local":
          if (!body.path) { server.json(res, 400, { error: "path required for local install" }); return; }
          source = { type: "local", path: body.path };
          break;
        case "npm":
          if (!body.package) { server.json(res, 400, { error: "package required for npm install" }); return; }
          source = { type: "npm", package: body.package, version: body.version };
          break;
        case "git":
          if (!body.url) { server.json(res, 400, { error: "url required for git install" }); return; }
          source = { type: "git", url: body.url, ref: body.ref };
          break;
        case "bundled":
          if (!body.id) { server.json(res, 400, { error: "id required for bundled install" }); return; }
          source = { type: "bundled", id: body.id };
          break;
        default:
          server.json(res, 400, { error: `Unknown install type: ${body.type}` });
          return;
      }

      const skillId = await skillRegistry.install(source);
      if (!skillId) {
        server.json(res, 500, { error: "Installation failed — check server logs" });
        return;
      }

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
      server.json(res, 200, {
        success: true,
        skillId,
        status: state?.status ?? "installed",
      });
    } catch (err) {
      log.error("Failed to install skill", err);
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/skills/enable — enable a skill
  server.post("/api/skills/enable", async (req, res) => {
    try {
      const body = await server.parseBody<{ id: string; grantPermissions?: boolean }>(req);
      if (!body.id) { server.json(res, 400, { error: "id required" }); return; }

      // Auto-grant all required permissions if requested (default: true for convenience)
      const autoGrant = body.grantPermissions !== false;
      if (autoGrant) {
        const state = skillRegistry.getSkill(body.id);
        if (state?.manifest.permissions) {
          skillRegistry.grantPermissions(body.id, state.manifest.permissions);
        }
      }

      const ok = await skillRegistry.enableSkill(body.id);
      if (!ok) {
        const state = skillRegistry.getSkill(body.id);
        server.json(res, 400, { error: state?.error ?? "Failed to enable skill" });
        return;
      }
      server.json(res, 200, { success: true });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/skills/disable — disable a skill
  server.post("/api/skills/disable", async (req, res) => {
    try {
      const body = await server.parseBody<{ id: string }>(req);
      if (!body.id) { server.json(res, 400, { error: "id required" }); return; }

      await skillRegistry.disableSkill(body.id);
      server.json(res, 200, { success: true });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // DELETE /api/skills/uninstall — uninstall a skill
  server.delete("/api/skills/uninstall", async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const id = url.searchParams.get("id");
      if (!id) { server.json(res, 400, { error: "id required" }); return; }

      const ok = await skillRegistry.uninstall(id);
      if (!ok) { server.json(res, 404, { error: "Skill not found or failed to remove" }); return; }
      server.json(res, 200, { success: true });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/skills/permissions — grant/revoke permissions
  server.post("/api/skills/permissions", async (req, res) => {
    try {
      const body = await server.parseBody<{
        id: string;
        action: "grant" | "revoke";
        permissions: string[];
      }>(req);

      if (!body.id || !body.action || !body.permissions) {
        server.json(res, 400, { error: "id, action, and permissions required" }); return;
      }

      const perms = body.permissions as Parameters<typeof skillRegistry.grantPermissions>[1];
      if (body.action === "grant") {
        skillRegistry.grantPermissions(body.id, perms);
      } else {
        skillRegistry.revokePermissions(body.id, perms);
      }
      server.json(res, 200, { success: true });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // POST /api/skills/settings — update skill settings
  server.post("/api/skills/settings", async (req, res) => {
    try {
      const body = await server.parseBody<{ id: string; settings: Record<string, unknown> }>(req);
      if (!body.id || !body.settings) { server.json(res, 400, { error: "id and settings required" }); return; }

      const ok = skillRegistry.updateSettings(body.id, body.settings);
      if (!ok) { server.json(res, 404, { error: "Skill not found" }); return; }
      server.json(res, 200, { success: true });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // GET /api/skills/catalog — built-in skill catalog (marketplace)
  server.get("/api/skills/catalog", (_req, res) => {
    const installed = skillRegistry.getAllSkills();
    const catalog = BUNDLED_CATALOG.map(item => ({
      ...item,
      installed: installed.has(item.id),
      status: installed.get(item.id)?.status ?? null,
    }));
    server.json(res, 200, { catalog });
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
