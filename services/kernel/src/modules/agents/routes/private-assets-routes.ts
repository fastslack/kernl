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

import { resolve } from "node:path";
import type { KernelHttpServer } from "../../../core/http-server.js";

export function registerPrivateAssetRoutes(server: KernelHttpServer): void {



  // ── Per-agent private workspace (plugins + skills) ────────────
  // Each claude_code agent can own physical plugin/skill copies under
  // `data/agents/<agentId>/plugins/<name>/` and `data/agents/<agentId>/skills/<name>/`.
  // The executor's resolvers check these paths before the user-scope ones, so
  // an agent can use a plugin/skill that is NOT installed in ~/.claude/.

  server.get("/api/agents/:id/private-plugins", async (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "agent id required" }); return; }
      const { readdirSync, statSync, existsSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const dir = resolve(process.cwd(), `data/agents/${id}/plugins`);
      if (!existsSync(dir)) { server.json(res, 200, { items: [] }); return; }
      const items = readdirSync(dir)
        .filter((name) => {
          try { return statSync(resolve(dir, name)).isDirectory(); } catch { return false; }
        })
        .map((name) => ({ name, path: resolve(dir, name) }));
      server.json(res, 200, { items });
    } catch (err) {
      server.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.post("/api/agents/:id/private-plugins/copy-from-marketplace", async (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "agent id required" }); return; }
      const body = await server.parseBody<{ source: string }>(req);
      if (!body.source) { server.json(res, 400, { error: "source (marketplace/plugin) required" }); return; }
      if (!/^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_.-]*$/i.test(body.source)) {
        server.json(res, 400, { error: "source must be 'marketplace/plugin' slug" });
        return;
      }
      const [mk, pluginName] = body.source.split("/", 2);
      const home = process.env.HOST_HOME ?? (await import("node:os")).homedir();
      const { cpSync, existsSync, mkdirSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const srcPath = `${home}/.claude/plugins/marketplaces/${mk}/plugins/${pluginName}`;
      if (!existsSync(srcPath)) { server.json(res, 404, { error: `Plugin "${body.source}" not found at ${srcPath}` }); return; }
      const destDir = resolve(process.cwd(), `data/agents/${id}/plugins`);
      mkdirSync(destDir, { recursive: true });
      const destPath = resolve(destDir, pluginName);
      if (existsSync(destPath)) { server.json(res, 409, { error: `Agent already has private plugin "${pluginName}" — remove it first` }); return; }
      cpSync(srcPath, destPath, { recursive: true, dereference: true });
      server.json(res, 200, { ok: true, name: pluginName, path: destPath });
    } catch (err) {
      server.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.delete("/api/agents/:id/private-plugins/:name", async (req, res) => {
    try {
      const params = (req as unknown as { params: Record<string, string> }).params ?? {};
      const { id, name } = params;
      if (!id || !name) { server.json(res, 400, { error: "agent id + plugin name required" }); return; }
      const { rmSync, existsSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const target = resolve(process.cwd(), `data/agents/${id}/plugins/${name}`);
      if (!existsSync(target)) { server.json(res, 404, { error: "not found" }); return; }
      rmSync(target, { recursive: true, force: true });
      server.json(res, 200, { ok: true, removed: name });
    } catch (err) {
      server.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Mirror: skills
  server.get("/api/agents/:id/private-skills", async (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "agent id required" }); return; }
      const { readdirSync, statSync, existsSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const dir = resolve(process.cwd(), `data/agents/${id}/skills`);
      if (!existsSync(dir)) { server.json(res, 200, { items: [] }); return; }
      const items = readdirSync(dir)
        .filter((name) => {
          try { return statSync(resolve(dir, name)).isDirectory(); } catch { return false; }
        })
        .map((name) => ({ name, path: resolve(dir, name) }));
      server.json(res, 200, { items });
    } catch (err) {
      server.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.post("/api/agents/:id/private-skills/copy-from-user", async (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "agent id required" }); return; }
      const body = await server.parseBody<{ name: string }>(req);
      if (!body.name || !/^[a-z0-9][a-z0-9_-]*$/i.test(body.name)) {
        server.json(res, 400, { error: "name (skill slug) required" }); return;
      }
      const home = process.env.HOST_HOME ?? (await import("node:os")).homedir();
      const { cpSync, existsSync, mkdirSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const srcPath = `${home}/.claude/skills/${body.name}`;
      if (!existsSync(srcPath)) { server.json(res, 404, { error: `Skill "${body.name}" not found at ${srcPath}` }); return; }
      const destDir = resolve(process.cwd(), `data/agents/${id}/skills`);
      mkdirSync(destDir, { recursive: true });
      const destPath = resolve(destDir, body.name);
      if (existsSync(destPath)) { server.json(res, 409, { error: `Agent already has private skill "${body.name}"` }); return; }
      cpSync(srcPath, destPath, { recursive: true, dereference: true });
      server.json(res, 200, { ok: true, name: body.name, path: destPath });
    } catch (err) {
      server.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.delete("/api/agents/:id/private-skills/:name", async (req, res) => {
    try {
      const params = (req as unknown as { params: Record<string, string> }).params ?? {};
      const { id, name } = params;
      if (!id || !name) { server.json(res, 400, { error: "agent id + skill name required" }); return; }
      const { rmSync, existsSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const target = resolve(process.cwd(), `data/agents/${id}/skills/${name}`);
      if (!existsSync(target)) { server.json(res, 404, { error: "not found" }); return; }
      rmSync(target, { recursive: true, force: true });
      server.json(res, 200, { ok: true, removed: name });
    } catch (err) {
      server.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}
