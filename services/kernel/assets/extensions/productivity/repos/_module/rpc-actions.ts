/**
 * Repos RPC actions — minimal surface so the dashboard (or any mtwRequest
 * client) can list/register/unregister repos without going through MCP.
 */

import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { RpcAction } from "../../../../../src/core/mtw/rpc-handler.js";
import { RepoService } from "./service.js";

export function reposRpcActions(db: SqliteDb): RpcAction[] {
  const service = new RepoService(db);
  return [
    {
      name: "repos.list",
      handler: async (args) => {
        const tag = typeof args.tag === "string" ? args.tag : undefined;
        const query = typeof args.query === "string" ? args.query : undefined;
        const limit = Math.min(200, Math.max(1, typeof args.limit === "number" ? args.limit : 100));
        return { repos: service.list({ tag, query, limit }) };
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
        const res = service.create({ name, path, description, tags, shared });
        if (!res.ok) throw new Error(res.error);
        return { ok: true, repo: res.repo };
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
