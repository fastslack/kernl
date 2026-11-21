/**
 * Who is making a request.
 *
 * Two kinds of caller hold a credential:
 *
 *   * The super admin: whoever presents the kernel token (`KERNEL_AUTH_TOKEN`,
 *     or the generated `data/.kernel-auth-token`). It is not a row anywhere,
 *     so it cannot be deleted or locked out, and it is the only principal that
 *     can manage users. With auth disabled (no token configured), every caller
 *     is the super admin, as before users existed.
 *   * A user: a row in the access module's `users` table, holding one or more
 *     personal tokens (stored hashed). What a user may do is decided by the
 *     request authorizer below.
 *
 * The kernel itself stays generic: it compares the master token and asks a
 * resolver (registered by the access module) about anything else, so core
 * code never imports a module.
 */

import { timingSafeEqual, createHash } from "node:crypto";
import { formatRequirement, grants, requirementForRoute, type Requirement } from "./permissions.js";
import { scopeFor } from "./scope.js";

export type Principal =
  | { kind: "super_admin"; id: "super-admin"; name: string }
  | { kind: "user"; id: string; name: string; tokenId: string };

export const SUPER_ADMIN: Principal = Object.freeze({
  kind: "super_admin",
  id: "super-admin",
  name: "Super admin",
}) as Principal;

export function isSuperAdmin(p: Principal | null | undefined): boolean {
  return p?.kind === "super_admin";
}

/** Maps a presented token to its user, or null when it belongs to no one. */
export type UserTokenResolver = (token: string) => Principal | null;

let userTokenResolver: UserTokenResolver | null = null;

/** Registered by the access module; `null` unregisters (tests). */
export function setUserTokenResolver(fn: UserTokenResolver | null): void {
  userTokenResolver = fn;
}

/**
 * Maps a user id to that user, or null when they no longer may sign in
 * (deleted, disabled). For callers the kernel did not authenticate by
 * token itself: an RPC request the mtwRequest broker stamped with the user
 * whose token it accepted at the handshake.
 */
export type UserIdResolver = (id: string) => Principal | null;

let userIdResolver: UserIdResolver | null = null;

/** Registered by the access module; `null` unregisters (tests). */
export function setUserIdResolver(fn: UserIdResolver | null): void {
  userIdResolver = fn;
}

/** The active user with this id, or null. Fails closed. */
export function resolveUserId(id: string): Principal | null {
  if (!id) return null;
  try {
    return userIdResolver?.(id) ?? null;
  } catch {
    return null;
  }
}

/**
 * Constant-time string comparison. Both sides are hashed first so the
 * comparison never short-circuits on length, which would leak the token's
 * length to a caller timing its 401s.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * The principal a token stands for, or null when it stands for no one.
 * `masterToken` empty means auth is disabled: everyone is the super admin.
 */
export function resolveToken(token: string | null, masterToken: string): Principal | null {
  if (!masterToken) return SUPER_ADMIN;
  if (!token) return null;
  if (safeEqual(token, masterToken)) return SUPER_ADMIN;
  try {
    return userTokenResolver?.(token) ?? null;
  } catch {
    // A broken resolver must fail closed, never open.
    return null;
  }
}

/**
 * Decides whether an authenticated principal may reach a path. Returns null
 * to let the request through, or the response to send in its place.
 *
 * Synchronous for the same reason as the HTTP preconditions: it runs on
 * every request.
 */
export type RequestAuthorizer = (
  principal: Principal,
  pathname: string,
  method: string,
) => { status: number; body: unknown } | null;

/**
 * Paths every user may reach regardless of what they were granted: enough to
 * learn who they are and what they may do.
 */
export const USER_BASELINE_PATHS = ["/api/auth/me"];

/**
 * Reads every signed-in user needs for the dashboard to draw itself, whatever
 * their roles: the menu (manifest), the theme, the edition, the public
 * config, whether the kernel is up and whether a model is set up. None of
 * them carries anyone's data. GET only.
 */
export const USER_SHELL_READS = [
  "/api/manifest", "/api/health", "/api/edition", "/api/config/public",
  "/api/marketplace/theme/active", "/api/llm/readiness",
];

/** The grants a user holds (`tasks:read`, `agents:*`…), from their roles. */
export type PermissionResolver = (principal: Principal) => readonly string[];

let permissionResolver: PermissionResolver | null = null;

/** Registered by the access module; `null` unregisters (tests). */
export function setPermissionResolver(fn: PermissionResolver | null): void {
  permissionResolver = fn;
}

/** A user's grants; none when nothing says otherwise (deny by default). */
export function permissionsOf(principal: Principal): readonly string[] {
  if (principal.kind === "super_admin") return ["*:*", "system:*"];
  try {
    return permissionResolver?.(principal) ?? [];
  } catch {
    return [];
  }
}

/** True when the principal holds what the requirement asks. */
export function principalCan(principal: Principal, need: Requirement): boolean {
  if (principal.kind === "super_admin") return true;
  return grants(permissionsOf(principal), need);
}

/**
 * Deny by default. The super admin reaches everything; a user reaches the
 * baseline and whatever their roles grant, read off the path
 * (core/permissions.ts). `/mcp` lets in any user with at least one grant:
 * each tool is checked on its own when it is listed and when it is called.
 */
export const defaultRequestAuthorizer: RequestAuthorizer = (principal, pathname, method) => {
  if (principal.kind === "super_admin") return null;
  if (USER_BASELINE_PATHS.includes(pathname)) return null;
  if ((method === "GET" || method === "HEAD") && USER_SHELL_READS.includes(pathname)) return null;
  if (pathname === "/mcp") {
    // A user held to some offices stays off MCP: tools answer in prose,
    // which cannot be stripped of the agents and offices outside their
    // scope the way JSON is (core/scope.ts). They use the dashboard.
    if (scopeFor(principal)) return { status: 403, body: { error: "Forbidden", reason: "scoped_user" } };
    return permissionsOf(principal).length > 0
      ? null
      : { status: 403, body: { error: "Forbidden", reason: "no_permission" } };
  }
  const need = requirementForRoute(pathname, method);
  if (need && principalCan(principal, need)) return null;
  return {
    status: 403,
    body: { error: "Forbidden", reason: "no_permission", ...(need ? { required: formatRequirement(need) } : {}) },
  };
};

let requestAuthorizer: RequestAuthorizer = defaultRequestAuthorizer;

export function setRequestAuthorizer(fn: RequestAuthorizer | null): void {
  requestAuthorizer = fn ?? defaultRequestAuthorizer;
}

export function authorizeRequest(principal: Principal, pathname: string, method: string) {
  // The super admin is never subject to a pluggable rule: a bug in one must
  // not lock the owner out of the install that would let them fix it.
  if (principal.kind === "super_admin") return null;
  try {
    return requestAuthorizer(principal, pathname, method);
  } catch {
    return { status: 403, body: { error: "Forbidden", reason: "authorizer_failed" } };
  }
}
