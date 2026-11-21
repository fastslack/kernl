/**
 * Users and permissions, for extension code.
 *
 * The kernel already checks every request against the caller's roles and
 * offices before an extension sees it: a route by its `/api/<module>` path,
 * a tool by its `kernel_<module>_<verb>` name, and every id in the input
 * against the caller's offices. Most extensions need nothing from here.
 *
 * Use it when a route or tool does more than its path or name says — a
 * `GET /api/cinema/export` that hands out the provider keys, a handler that
 * acts on an id it read from the database rather than from the request — or
 * to shape a response (hide a button the caller cannot use).
 *
 * Outside a request (an agent run, a trigger, a scheduled job) there is no
 * caller: everything is allowed, as an agent runs with its own tool set.
 */

import { getHost } from "./host.js";
import { getRequestContext } from "./facades.js";
import { HttpError } from "./http-error.js";
import type { Principal } from "../core/principal.js";

/** Who made the request in flight: the super admin, a user, or null outside one. */
export function currentPrincipal(): Principal | null {
  return getRequestContext().principal ?? null;
}

/** Whether the caller holds `permission` (`module:read`, `module:write`). */
export function can(permission: string): boolean {
  const host = getHost();
  if (host.can) return host.can(permission);
  // A kernel without users: only the owner gets in.
  const p = currentPrincipal();
  return !p || p.kind === "super_admin";
}

/** Throws a 403 unless the caller holds `permission`. */
export function requirePermission(permission: string): void {
  if (can(permission)) return;
  throw new HttpError(403, "Forbidden", { error: "Forbidden", reason: "no_permission", required: permission });
}

/**
 * Whether the caller's offices reach `id` (an agent, an office or a run).
 * `write` asks for a granted office; `read` also accepts the office of an
 * agent granted on its own. Ids that name none of those are in scope.
 */
export function inScope(id: string, level: "read" | "write" = "read"): boolean {
  const host = getHost();
  return host.inScope ? host.inScope(id, level) : true;
}

/** Throws a 403 unless the caller's offices reach `id`. */
export function requireInScope(id: string, level: "read" | "write" = "read"): void {
  if (inScope(id, level)) return;
  throw new HttpError(403, "Forbidden", { error: "Forbidden", reason: "out_of_scope" });
}
