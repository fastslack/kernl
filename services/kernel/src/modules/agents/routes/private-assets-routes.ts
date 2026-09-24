/**
 * Per-agent private plugins and skills.
 *
 * Each claude_code agent can own physical copies under
 * `data/agents/<agentId>/plugins/<name>/` and `.../skills/<name>/`. The
 * executor's resolvers check these paths before the user-scope ones, so an
 * agent can use a plugin or skill that is NOT installed in `~/.claude/`.
 *
 * Split out of `api-routes.ts` unchanged; it works on the filesystem and needs
 * nothing from the agents module beyond the HTTP server.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { HttpError, type KernelHttpServer } from "../../../core/http-server.js";

export function registerPrivateAssetRoutes(server: KernelHttpServer): void {

  // ── Per-agent private workspace (plugins + skills) ────────────
  // Each claude_code agent can own physical plugin/skill copies under
  // `data/agents/<agentId>/plugins/<name>/` and `data/agents/<agentId>/skills/<name>/`.
  // The executor's resolvers check these paths before the user-scope ones, so
  // an agent can use a plugin/skill that is NOT installed in ~/.claude/.

  /** The directories directly under `dir`, `[]` when it does not exist. */
  function listDirs(dir: string): Array<{ name: string; path: string }> {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => {
        try { return statSync(resolve(dir, name)).isDirectory(); } catch { return false; }
      })
      .map((name) => ({ name, path: resolve(dir, name) }));
  }

  /** Remove `target` recursively, 404 when it is not there. */
  function removeOrNotFound(target: string, name: string) {
    if (!existsSync(target)) throw new HttpError(404, "not found");
    rmSync(target, { recursive: true, force: true });
    return { ok: true, removed: name };
  }

  server.route("GET", "/api/agents/:id/private-plugins", ({ params: { id } }) => ({
    items: listDirs(resolve(process.cwd(), `data/agents/${id}/plugins`)),
  }));

  server.route<{ source: string }>("POST", "/api/agents/:id/private-plugins/copy-from-marketplace", ({ params: { id }, body }) => {
    if (!body.source) throw new HttpError(400, "source (marketplace/plugin) required");
    if (!/^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_.-]*$/i.test(body.source)) {
      throw new HttpError(400, "source must be 'marketplace/plugin' slug");
    }
    const [mk, pluginName] = body.source.split("/", 2);
    const home = process.env.HOST_HOME ?? homedir();
    const srcPath = `${home}/.claude/plugins/marketplaces/${mk}/plugins/${pluginName}`;
    if (!existsSync(srcPath)) throw new HttpError(404, `Plugin "${body.source}" not found at ${srcPath}`);
    const destDir = resolve(process.cwd(), `data/agents/${id}/plugins`);
    mkdirSync(destDir, { recursive: true });
    const destPath = resolve(destDir, pluginName);
    if (existsSync(destPath)) throw new HttpError(409, `Agent already has private plugin "${pluginName}" — remove it first`);
    cpSync(srcPath, destPath, { recursive: true, dereference: true });
    return { ok: true, name: pluginName, path: destPath };
  });

  server.route("DELETE", "/api/agents/:id/private-plugins/:name", ({ params: { id, name } }) =>
    removeOrNotFound(resolve(process.cwd(), `data/agents/${id}/plugins/${name}`), name));

  // Mirror: skills
  server.route("GET", "/api/agents/:id/private-skills", ({ params: { id } }) => ({
    items: listDirs(resolve(process.cwd(), `data/agents/${id}/skills`)),
  }));

  server.route<{ name: string }>("POST", "/api/agents/:id/private-skills/copy-from-user", ({ params: { id }, body }) => {
    if (!body.name || !/^[a-z0-9][a-z0-9_-]*$/i.test(body.name)) {
      throw new HttpError(400, "name (skill slug) required");
    }
    const home = process.env.HOST_HOME ?? homedir();
    const srcPath = `${home}/.claude/skills/${body.name}`;
    if (!existsSync(srcPath)) throw new HttpError(404, `Skill "${body.name}" not found at ${srcPath}`);
    const destDir = resolve(process.cwd(), `data/agents/${id}/skills`);
    mkdirSync(destDir, { recursive: true });
    const destPath = resolve(destDir, body.name);
    if (existsSync(destPath)) throw new HttpError(409, `Agent already has private skill "${body.name}"`);
    cpSync(srcPath, destPath, { recursive: true, dereference: true });
    return { ok: true, name: body.name, path: destPath };
  });

  server.route("DELETE", "/api/agents/:id/private-skills/:name", ({ params: { id, name } }) =>
    removeOrNotFound(resolve(process.cwd(), `data/agents/${id}/skills/${name}`), name));
}
