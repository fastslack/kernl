/**
 * access module — users, personal tokens and roles.
 *
 * The kernel token stays the super admin (core/principal.ts). This module
 * adds users, each with tokens of their own, and tells the kernel who a
 * presented token belongs to and what their roles grant. The kernel
 * applies those grants (core/principal.ts, core/tool-permission-guard.ts);
 * a user with no role reaches nothing.
 *
 * No MCP tools: managing users is the super admin's job, over
 * /api/access (api-routes.ts), and an agent has no business minting
 * credentials.
 */

import type { KernelModule, ModuleContext, ToolDefinition } from "../../core/types.js";
import { runMigrations } from "../../core/db/migrations.js";
import { setPermissionResolver, setUserTokenResolver } from "../../core/principal.js";
import { setScopeProvider } from "../../core/scope.js";
import { accessMigrations } from "./migrations.js";
import { AccessService, setAccessService } from "./service.js";

export function createAccessModule(): KernelModule {
  return {
    name: "access",
    async initialize(ctx: ModuleContext) {
      runMigrations(ctx.sqlite, "access", accessMigrations);
      const service = new AccessService(ctx.sqlite);
      setAccessService(service);
      setUserTokenResolver((token) => service.resolve(token));
      setPermissionResolver((p) => (p.kind === "user" ? service.permissionsForUser(p.id) : []));
      setScopeProvider({
        scopeOf: (p) => (p.kind === "user" ? service.scopeForUser(p.id) : null),
        lookup: (id) => service.refs.lookup(id),
      });
    },
    getTools(): ToolDefinition[] {
      return [];
    },
    async shutdown() {
      setUserTokenResolver(null);
      setPermissionResolver(null);
      setScopeProvider(null);
      setAccessService(null);
    },
  };
}
