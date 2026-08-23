/**
 * Repos RPC actions — minimal surface so the dashboard (or any mtwRequest
 * client) can list/register/unregister repos without going through MCP.
 */

import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { RpcAction } from "../../../../../src/core/mtw/rpc-handler.js";
import { RepoService } from "./service.js";

export function reposRpcActions(db: SqliteDb, visibleRoots: string[] = []): RpcAction[] {
  const service = new RepoService(db);
  return [
    {
      // The register form's alternative to a free-text path box. Returns the
      // checkouts the kernel can actually reach, flagged with whether they are
      // already registered, so the form can offer them instead of letting
      // someone type a path this process was never able to see.
      name: "repos.candidates",
      handler: async () => {
        const known = new Set(service.list({ limit: 500 }).map((r) => r.path));
        const found = RepoService.discoverCandidates(visibleRoots);
        return {
          roots: visibleRoots,
          candidates: found.map((c) => ({ ...c, registered: known.has(c.path) })),
        };
      },
    },
    {
      name: "repos.access.set",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) throw new Error("id required");
        const repo = service.resolve({ id });
        if (!repo) throw new Error("not found");
        const agents = Array.isArray(args.agents)
          ? args.agents.filter((a): a is string => typeof a === "string")
          : [];
        const shared = args.shared === undefined ? undefined : args.shared !== false;
        if (shared !== undefined) service.update(id, { shared });
        service.setAccess(id, agents);
        return { ok: true, shared: shared ?? !!repo.shared, agents: service.getAccess(id) };
      },
    },
    {
      name: "repos.list",
      handler: async (args) => {
        const tag = typeof args.tag === "string" ? args.tag : undefined;
        const query = typeof args.query === "string" ? args.query : undefined;
        const limit = Math.min(200, Math.max(1, typeof args.limit === "number" ? args.limit : 100));
        const repos = service.list({ tag, query, limit });
        // The dashboard is a human surface, so it sees private repos too — it
        // has to, to manage them. Agents go through the tools, which scope.
        return { repos: repos.map((r) => ({ ...r, agents: r.shared ? [] : service.getAccess(r.id) })) };
      },
    },
    {
      name: "repos.register",
      handler: async (args) => {
        const name = typeof args.name === "string" ? args.name : "";
        const path = typeof args.path === "string" ? args.path : "";
        const description = typeof args.description === "string" ? args.description : undefined;
        const tags = typeof args.tags === "string" ? args.tags : undefined;
        const shared = args.shared === false ? false : true;
        const res = service.create({ name, path, description, tags, shared }, { visibleRoots });
        if (!res.ok) throw new Error(res.error);
        // A private repo with no agents named is reachable by nobody, which is
        // never what someone meant — the caller sends them together.
        const agents = Array.isArray(args.agents)
          ? args.agents.filter((a): a is string => typeof a === "string")
          : [];
        if (!shared && agents.length > 0) service.setAccess(res.repo.id, agents);
        return { ok: true, repo: res.repo, agents: service.getAccess(res.repo.id) };
      },
    },
    {
      name: "repos.unregister",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) throw new Error("id required");
        const ok = service.unregister(id);
        return { ok };
      },
    },
    {
      name: "repos.get",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : undefined;
        const name = typeof args.name === "string" ? args.name : undefined;
        const repo = service.resolve({ id, name });
        if (!repo) throw new Error("not found");
        return { repo };
      },
    },
  ];
}
