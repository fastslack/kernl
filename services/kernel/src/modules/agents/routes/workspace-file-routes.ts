/**
 * Reading an agent's files: the workspaces it can see, and the contents of the
 * directory it actually runs in.
 *
 * Split out of `api-routes.ts` unchanged. `wsService` is optional for the same
 * reason it is optional upstream — without it the workspace listings degrade
 * to what the agent record itself can tell us.
 */

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { KernelHttpServer } from "../../../core/http-server.js";
import { isPathInside } from "../../../core/fs-paths.js";
import type { AgentService } from "../service.js";
import type { WorkspaceServiceLike } from "../advanced-types.js";

export function registerWorkspaceFileRoutes(
  server: KernelHttpServer,
  service: AgentService,
  wsService?: WorkspaceServiceLike,
): void {
  // ── Workspace API ─────────────────────────────
  const workspaceRoot = resolve(process.cwd(), "data", "workspaces");

  /**
   * The absolute directory an agent runs in outside data/workspaces: its own
   * `__cwd_path__`, else — when it has no `__workspace__` of its own — the git
   * repo its office was promoted to. Mirrors `resolveCwd()` in the claude-code
   * executor. An office home that is a kernel workspace is served by
   * /api/agents/workspace/:wsId instead. "" when neither applies.
   */
  function agentCwdRoot(agent: { flow_id?: string }, vars: Record<string, unknown>): string {
    // isAbsolute, not startsWith("/"): C:\code\proj is absolute too.
    if (typeof vars.__cwd_path__ === "string" && isAbsolute(vars.__cwd_path__)) return vars.__cwd_path__;
    if (vars.__workspace__ || !agent.flow_id) return "";
    const repo = service.getFlow(agent.flow_id)?.home_repo_path ?? "";
    return repo && isAbsolute(repo) && existsSync(repo) ? repo : "";
  }

  async function computeWsStats(wsId: string): Promise<{ files: number; bytes: number; mtime: number }> {
    const { readdir, stat } = await import("node:fs/promises");
    let files = 0, bytes = 0, mtime = 0;
    const base = resolve(workspaceRoot, wsId);
    async function walk(d: string): Promise<void> {
      let ents;
      try { ents = await readdir(d, { withFileTypes: true }); } catch { return; }
      for (const ent of ents) {
        if (ent.name === "node_modules" || ent.name === ".git") continue;
        const sub = resolve(d, ent.name);
        if (ent.isDirectory()) await walk(sub);
        else {
          const s = await stat(sub).catch(() => null);
          if (s) { files++; bytes += s.size; if (s.mtimeMs > mtime) mtime = s.mtimeMs; }
        }
      }
    }
    await walk(base);
    return { files, bytes, mtime };
  }



  // GET /api/agents/workspaces — offices with their workspaces nested
  server.get("/api/agents/workspaces", async (_req, res) => {
    try {
      if (!wsService) { server.json(res, 200, { offices: [] }); return; }
      const all = wsService.listAll();
      const flows = service.listFlows?.() ?? [];
      const flowById = new Map(flows.map((f: { id: string; name: string; color: string }) => [f.id, f]));

      const officeMap = new Map<string, { flow_id: string; name: string; color: string; workspaces: Array<Record<string, unknown>> }>();
      for (const w of all) {
        const stats = await computeWsStats(w.id);
        const meta = flowById.get(w.owner_flow_id);
        if (!officeMap.has(w.owner_flow_id)) {
          officeMap.set(w.owner_flow_id, {
            flow_id: w.owner_flow_id,
            name: meta?.name ?? w.owner_flow_id,
            color: meta?.color ?? "#6366f1",
            workspaces: [],
          });
        }
        officeMap.get(w.owner_flow_id)!.workspaces.push({
          id: w.id,
          name: w.name,
          description: w.description,
          shared: w.shared === 1,
          files: stats.files,
          bytes: stats.bytes,
          mtime: stats.mtime,
        });
      }

      const offices = [...officeMap.values()].sort((a, b) => a.name.localeCompare(b.name));
      for (const o of offices) o.workspaces.sort((a, b) => (b.mtime as number) - (a.mtime as number));
      server.json(res, 200, { offices });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // GET /api/agents/workspace/:wsId — list files recursively
  server.get("/api/agents/workspace/:wsId", async (req, res) => {
    try {
      const wsId = (req as unknown as { params: Record<string, string> }).params?.wsId;
      if (!wsId) { server.json(res, 400, { error: "wsId required" }); return; }
      // Validate workspace exists (if service available) — otherwise fall back to raw dir
      if (wsService && !wsService.get(wsId)) { server.json(res, 404, { error: "workspace not found" }); return; }
      const dir = resolve(workspaceRoot, wsId);
      if (!dir.startsWith(workspaceRoot)) { server.json(res, 403, { error: "forbidden" }); return; }

      const files: Array<{ path: string; type: string; size: number }> = [];
      async function walk(d: string, prefix: string): Promise<void> {
        const { readdir, stat } = await import("node:fs/promises");
        let entries;
        try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          const rel = prefix ? `${prefix}/${e.name}` : e.name;
          if (e.name === "node_modules" || e.name === ".git") continue;
          if (e.isDirectory()) {
            files.push({ path: rel, type: "dir", size: 0 });
            await walk(resolve(d, e.name), rel);
          } else {
            const s = await stat(resolve(d, e.name)).catch(() => ({ size: 0 }));
            files.push({ path: rel, type: "file", size: s.size });
          }
        }
      }
      await walk(dir, "");
      const ws = wsService?.get(wsId);
      server.json(res, 200, {
        workspace_id: wsId,
        workspace: ws ? { id: ws.id, name: ws.name, description: ws.description, shared: ws.shared === 1, owner_flow_id: ws.owner_flow_id } : null,
        files,
        total: files.length,
      });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // GET /api/agents/workspace/:wsId/file?path=... — read a file
  server.get("/api/agents/workspace/:wsId/file", async (req, res) => {
    try {
      const wsId = (req as unknown as { params: Record<string, string> }).params?.wsId;
      const url = new URL(req.url ?? "/", "http://localhost");
      const filePath = url.searchParams.get("path") ?? "";
      if (!wsId || !filePath) { server.json(res, 400, { error: "wsId and path required" }); return; }
      if (wsService && !wsService.get(wsId)) { server.json(res, 404, { error: "workspace not found" }); return; }
      const target = resolve(workspaceRoot, wsId, filePath);
      if (!target.startsWith(resolve(workspaceRoot, wsId))) { server.json(res, 403, { error: "forbidden" }); return; }

      const { readFile } = await import("node:fs/promises");
      const content = await readFile(target, "utf-8");
      server.json(res, 200, { path: filePath, content, size: content.length });
    } catch {
      server.json(res, 404, { error: "file not found" });
    }
  });

  // GET /api/agents/:id/cwd-files — list files under an agent's __cwd_path__
  // (an absolute repo path OUTSIDE data/workspaces). Jailed to that path.
  server.get("/api/agents/:id/cwd-files", async (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      if (!id) { server.json(res, 400, { error: "id required" }); return; }
      const agent = service.getAgent(id);
      if (!agent) { server.json(res, 404, { error: "Agent not found" }); return; }
      let vars: Record<string, unknown> = {};
      try { vars = JSON.parse((agent as { variables?: string }).variables || "{}"); } catch { /* defaults */ }
      const cwd = agentCwdRoot(agent, vars);
      if (!cwd) { server.json(res, 400, { error: "agent has no absolute __cwd_path__ or office repo home" }); return; }
      const root = resolve(cwd);
      const { readdir, stat } = await import("node:fs/promises");
      const files: Array<{ path: string; type: string; size: number }> = [];
      async function walk(d: string, prefix: string, depth: number): Promise<void> {
        if (depth > 8) return;
        let entries;
        try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (e.name === "node_modules" || e.name === ".git" || e.name === ".wrangler") continue;
          const rel = prefix ? `${prefix}/${e.name}` : e.name;
          if (e.isDirectory()) {
            files.push({ path: rel, type: "dir", size: 0 });
            await walk(resolve(d, e.name), rel, depth + 1);
          } else {
            const s = await stat(resolve(d, e.name)).catch(() => ({ size: 0 }));
            files.push({ path: rel, type: "file", size: (s as { size: number }).size });
          }
        }
      }
      await walk(root, "", 0);
      const previewUrl = typeof vars.__preview_url__ === "string" ? vars.__preview_url__ : null;
      server.json(res, 200, { cwd: root, preview_url: previewUrl, files, total: files.length });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  // GET /api/agents/:id/cwd-file?path=... — read a file jailed under __cwd_path__
  server.get("/api/agents/:id/cwd-file", async (req, res) => {
    try {
      const id = (req as unknown as { params: Record<string, string> }).params?.id;
      const url = new URL(req.url ?? "/", "http://localhost");
      const filePath = url.searchParams.get("path") ?? "";
      if (!id || !filePath) { server.json(res, 400, { error: "id and path required" }); return; }
      const agent = service.getAgent(id);
      if (!agent) { server.json(res, 404, { error: "Agent not found" }); return; }
      let vars: Record<string, unknown> = {};
      try { vars = JSON.parse((agent as { variables?: string }).variables || "{}"); } catch { /* defaults */ }
      const cwd = agentCwdRoot(agent, vars);
      if (!cwd) { server.json(res, 400, { error: "agent has no absolute __cwd_path__ or office repo home" }); return; }
      const root = resolve(cwd);
      const target = resolve(root, filePath);
      if (!isPathInside(root, target)) { server.json(res, 403, { error: "forbidden" }); return; }
      const { readFile, stat } = await import("node:fs/promises");
      const s = await stat(target).catch(() => null);
      if (!s || !s.isFile()) { server.json(res, 404, { error: "file not found" }); return; }
      if (s.size > 512 * 1024) { server.json(res, 200, { path: filePath, content: `(file too large to preview: ${s.size} bytes)`, size: s.size }); return; }
      const content = await readFile(target, "utf-8");
      server.json(res, 200, { path: filePath, content, size: content.length });
    } catch {
      server.json(res, 404, { error: "file not found" });
    }
  });
}
