/**
 * Skill registry operations the dashboard reaches over both the WS RPC and
 * HTTP (`skills.*` ↔ `/api/skills*`).
 *
 * The RPC action and the HTTP route are the same request by two roads and
 * have to answer alike. They used to be written twice and had drifted: every
 * RPC failure came back as a resolved `{ error }` instead of an error, and
 * `skills.install` over RPC turned any value into a path/package/url with
 * `String()`. Now dashboard/rpc-actions.ts exposes this map as is and
 * api-routes.ts binds each entry to its path; where the two disagreed, the
 * fuller behaviour won.
 */

import type { Operation } from "../../sdk/args.js";
import { pickArgs } from "../../sdk/args.js";
import { HttpError } from "../../sdk/http-error.js";
import type { SkillRegistry } from "../../skills/registry.js";
import type { SkillPermission } from "../../skills/types.js";

export function skillOperations(skillRegistry: SkillRegistry): Record<string, Operation> {
  const requiredId = (input: Record<string, unknown>): string => {
    const id = typeof input.id === "string" ? input.id : "";
    if (!id) throw new HttpError(400, "id required");
    return id;
  };
  /** Grant every permission the manifest asks for, so enable can succeed. */
  const grantAll = (id: string) => {
    const needed = skillRegistry.getSkill(id)?.manifest.permissions as SkillPermission[] | undefined;
    if (needed && needed.length > 0) skillRegistry.grantPermissions(id, needed);
  };

  return {
    // List all installed skills
    "skills.list": () => {
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
    },

    // Install from local, npm, git, or bundled
    "skills.install": async (input) => {
      const args = pickArgs(input, {
        type: "string", path: "string", package: "string", version: "string",
        url: "string", ref: "string", id: "string",
      });
      const autoEnable = input.autoEnable !== false;
      if (!args.type) throw new HttpError(400, "type required (local|npm|git|bundled)");

      // For bundled skills already registered in the registry, just enable them
      if (args.type === "bundled" && args.id) {
        const existing = skillRegistry.getSkill(args.id);
        if (existing) {
          if (autoEnable && existing.status !== "enabled") {
            grantAll(args.id);
            await skillRegistry.enableSkill(args.id);
          }
          return { success: true, skillId: args.id, status: skillRegistry.getSkill(args.id)?.status ?? "installed" };
        }
      }

      let source: Parameters<typeof skillRegistry.install>[0];
      switch (args.type) {
        case "local":
          if (!args.path) throw new HttpError(400, "path required for local install");
          source = { type: "local", path: args.path };
          break;
        case "npm":
          if (!args.package) throw new HttpError(400, "package required for npm install");
          source = { type: "npm", package: args.package, version: args.version };
          break;
        case "git":
          if (!args.url) throw new HttpError(400, "url required for git install");
          source = { type: "git", url: args.url, ref: args.ref };
          break;
        case "bundled":
          if (!args.id) throw new HttpError(400, "id required for bundled install");
          source = { type: "bundled", id: args.id };
          break;
        default:
          throw new HttpError(400, `Unknown install type: ${args.type}`);
      }

      const skillId = await skillRegistry.install(source);
      if (!skillId) throw new HttpError(500, "Installation failed — check server logs");

      // Auto-enable if requested: first grant all required permissions
      if (autoEnable) {
        grantAll(skillId);
        await skillRegistry.enableSkill(skillId);
      }

      return { success: true, skillId, status: skillRegistry.getSkill(skillId)?.status ?? "installed" };
    },

    "skills.enable": async (input) => {
      const id = requiredId(input);
      // Auto-grant all required permissions if requested (default: true for convenience)
      if (input.grantPermissions !== false) grantAll(id);
      if (!(await skillRegistry.enableSkill(id))) {
        throw new HttpError(400, skillRegistry.getSkill(id)?.error ?? "Failed to enable skill");
      }
      return { success: true };
    },

    "skills.disable": async (input) => {
      await skillRegistry.disableSkill(requiredId(input));
      return { success: true };
    },

    "skills.uninstall": async (input) => {
      if (!(await skillRegistry.uninstall(requiredId(input)))) throw new HttpError(404, "Skill not found or failed to remove");
      return { success: true };
    },
  };
}
