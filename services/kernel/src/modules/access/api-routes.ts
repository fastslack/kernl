/**
 * HTTP surface of the access module.
 *
 *   GET    /api/auth/me                     who am I (any authenticated caller)
 *   GET    /api/access/users                list users
 *   POST   /api/access/users                { name, email? }
 *   PUT    /api/access/users/:id            { name?, email?, status? }
 *   DELETE /api/access/users/:id            soft delete, revokes every token
 *   GET    /api/access/users/:id/tokens     list a user's tokens (never the secret)
 *   POST   /api/access/users/:id/tokens     { label?, expires_at? } → the token, once
 *   DELETE /api/access/tokens/:id           revoke
 *   PUT    /api/access/users/:id/roles      { role_ids } → replaces the user's roles
 *   GET    /api/access/roles                list roles with their permissions
 *   POST   /api/access/roles                { name, description?, permissions }
 *   PUT    /api/access/roles/:id            { name?, description?, permissions? }
 *   DELETE /api/access/roles/:id            soft delete (built-in roles refuse)
 *   GET    /api/access/permissions          what a permission can name
 *   GET    /api/access/users/:id/scope      { mode, offices, agents, projects }
 *   PUT    /api/access/users/:id/scope      { mode?, offices?, agents?, projects? } → replaces it
 *
 * Everything under /api/access is for the super admin alone. The request
 * authorizer already keeps users out; the check here holds even if a later
 * authorizer grants a user something under this prefix by mistake, since
 * users managing users is how a restricted token becomes an unrestricted one.
 */

import type { KernelHttpServer } from "../../core/http-server.js";
import { HttpError } from "../../sdk/http-error.js";
import { getPrincipal } from "../../core/request-context.js";
import { isSuperAdmin, permissionsOf } from "../../core/principal.js";
import { MODULE_ALIASES, RESERVED_MODULES, SYSTEM_MODULES } from "../../core/permissions.js";
import { AccessError, type AccessService } from "./service.js";
import { brokerSupportsPrincipals } from "../../core/mtw/broker-features.js";

function requireSuperAdmin(): void {
  if (!isSuperAdmin(getPrincipal())) throw new HttpError(403, "Forbidden");
}

/** Runs a service call, turning its errors into the HTTP status they carry. */
function call<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof AccessError) throw new HttpError(err.status, err.message);
    throw err;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * How to read a permission list, for the dashboard to decide which menu
 * entries to show without a copy of core/permissions.ts. The kernel still
 * decides every call; this only spares a user tabs that would answer 403.
 */
function grammar() {
  return {
    aliases: MODULE_ALIASES,
    system_modules: [...SYSTEM_MODULES].sort(),
    reserved_modules: [...RESERVED_MODULES].sort(),
  };
}

export function registerAccessRoutes(server: KernelHttpServer, access: AccessService, opts: { authEnabled: boolean }): void {
  server.route("GET", "/api/auth/me", () => {
    const p = getPrincipal();
    if (!p) throw new HttpError(401, "Unauthorized");
    const permissions = [...permissionsOf(p)];
    if (p.kind === "super_admin") {
      return { kind: p.kind, id: p.id, name: p.name, authEnabled: opts.authEnabled, permissions, grammar: grammar() };
    }
    const user = access.getUser(p.id);
    return {
      kind: p.kind,
      id: p.id,
      name: user?.name ?? p.name,
      email: user?.email ?? "",
      authEnabled: opts.authEnabled,
      roles: access.userRoleIds(p.id),
      permissions,
      scope: call(() => access.getScope(p.id)),
      grammar: grammar(),
      // Whether the broker would let this user on (core/mtw/broker-features.ts);
      // the dashboard stays on HTTP alone when it would not.
      liveSocket: brokerSupportsPrincipals(),
    };
  });

  server.route("GET", "/api/access/users", () => {
    requireSuperAdmin();
    return {
      users: access.listUsers().map((u) => ({
        ...u,
        role_ids: access.userRoleIds(u.id),
        scope: access.getScope(u.id),
      })),
    };
  });

  server.route("GET", "/api/access/users/:id/scope", ({ params }) => {
    requireSuperAdmin();
    return { scope: call(() => access.getScope(params.id)) };
  });

  server.route("PUT", "/api/access/users/:id/scope", ({ params, body }) => {
    requireSuperAdmin();
    return {
      scope: call(() => access.setScope(params.id, {
        mode: str(body?.mode),
        offices: body?.offices,
        agents: body?.agents,
        projects: body?.projects,
      })),
    };
  }, { requireBody: true });

  server.route("PUT", "/api/access/users/:id/roles", ({ params, body }) => {
    requireSuperAdmin();
    const roleIds = body?.role_ids;
    if (!Array.isArray(roleIds) || roleIds.some((r) => typeof r !== "string")) {
      throw new HttpError(400, "role_ids must be a list of role ids");
    }
    return { role_ids: call(() => access.setUserRoles(params.id, roleIds as string[])) };
  }, { requireBody: true });

  server.route("GET", "/api/access/roles", () => {
    requireSuperAdmin();
    return { roles: access.listRoles() };
  });

  server.route("POST", "/api/access/roles", ({ body }) => {
    requireSuperAdmin();
    return {
      role: call(() => access.createRole({
        name: str(body?.name) ?? "",
        description: str(body?.description),
        permissions: body?.permissions,
      })),
    };
  }, { requireBody: true });

  server.route("PUT", "/api/access/roles/:id", ({ params, body }) => {
    requireSuperAdmin();
    return {
      role: call(() => access.updateRole(params.id, {
        name: str(body?.name),
        description: str(body?.description),
        permissions: body?.permissions,
      })),
    };
  }, { requireBody: true });

  server.route("DELETE", "/api/access/roles/:id", ({ params }) => {
    requireSuperAdmin();
    call(() => access.deleteRole(params.id));
    return { ok: true };
  });

  // What the role editor needs to explain a permission: the levels, the
  // wildcards, and which modules `*` does not reach.
  server.route("GET", "/api/access/permissions", () => {
    requireSuperAdmin();
    return {
      levels: ["read", "write", "*"],
      wildcards: { "*": "every feature module", system: "every system module" },
      system_modules: [...SYSTEM_MODULES].sort(),
      reserved_modules: [...RESERVED_MODULES].sort(),
    };
  });

  server.route("POST", "/api/access/users", ({ body }) => {
    requireSuperAdmin();
    return { user: call(() => access.createUser({ name: str(body?.name) ?? "", email: str(body?.email) })) };
  }, { requireBody: true });

  server.route("PUT", "/api/access/users/:id", ({ params, body }) => {
    requireSuperAdmin();
    return {
      user: call(() => access.updateUser(params.id, {
        name: str(body?.name),
        email: str(body?.email),
        status: str(body?.status),
      })),
    };
  }, { requireBody: true });

  server.route("DELETE", "/api/access/users/:id", ({ params }) => {
    requireSuperAdmin();
    call(() => access.deleteUser(params.id));
    return { ok: true };
  });

  server.route("GET", "/api/access/users/:id/tokens", ({ params }) => {
    requireSuperAdmin();
    if (!access.getUser(params.id)) throw new HttpError(404, "user not found");
    return { tokens: access.listTokens(params.id) };
  });

  server.route("POST", "/api/access/users/:id/tokens", ({ params, body }) => {
    requireSuperAdmin();
    const { token, record } = call(() => access.createToken(params.id, {
      label: str(body?.label),
      expires_at: str(body?.expires_at) ?? null,
    }));
    // The only time the plaintext leaves the kernel.
    return { token, record };
  });

  server.route("DELETE", "/api/access/tokens/:id", ({ params }) => {
    requireSuperAdmin();
    call(() => access.revokeToken(params.id));
    return { ok: true };
  });
}
