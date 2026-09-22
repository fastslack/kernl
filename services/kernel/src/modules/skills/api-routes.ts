/**
 * Skills HTTP API Routes
 * REST endpoints for managing the skill registry
 */

import { HttpError, type KernelHttpServer, type RouteMethod } from "../../core/http-server.js";
import type { SkillRegistry } from "../../skills/registry.js";
import { log } from "../../core/logger.js";
import { skillOperations } from "./operations.js";

export function registerSkillRoutes(
  server: KernelHttpServer,
  skillRegistry: SkillRegistry,
): void {

  // ── Operations shared with the WS RPC (operations.ts) ─────────
  // The RPC action and the route are one function, so both roads answer alike.
  const op = skillOperations(skillRegistry);
  const bind = ([method, path, name]: [RouteMethod, string, string]) => server.operation(method, path, op[name]);
  ([
    ["GET", "/api/skills", "skills.list"],
    ["POST", "/api/skills/install", "skills.install"],
    ["POST", "/api/skills/enable", "skills.enable"],
    ["POST", "/api/skills/disable", "skills.disable"],
    ["DELETE", "/api/skills/uninstall", "skills.uninstall"],
  ] as Array<[RouteMethod, string, string]>).forEach(bind);

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
