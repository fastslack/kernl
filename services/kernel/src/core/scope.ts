/**
 * Which offices and agents a user may see.
 *
 * Roles say what a user may do (core/permissions.ts); a scope says on which
 * offices and agents. A user either reaches every office (the default) or
 * only the ones granted to them, plus any single agent granted on its own.
 *
 * The kernel has hundreds of routes, tools and actions that name an agent,
 * an office or a run, written long before users existed. Rather than teach
 * each one about scopes, the check happens where every call passes:
 *
 *   * Input: any id a restricted user's call carries (path params, query,
 *     body, tool or RPC arguments, under any key) is looked up. If it is an
 *     agent, an office or a run outside the scope, the call is refused.
 *     An id that names none of those passes: it is not ours to judge.
 *   * Output: JSON going back to a restricted user (route responses, RPC
 *     results, a tool's structured content) has every list item and map
 *     entry that names an out-of-scope agent, office or run removed.
 *
 * Reading versus writing: an office is *visible* when it is granted or
 * holds a granted agent, and *writable* only when it is granted. So a user
 * granted one agent sees its office in the list but cannot rename it.
 *
 * Users with no restriction, the super admin and work the kernel starts on
 * its own skip all of this.
 */

import { getPrincipal } from "./request-context.js";
import { HttpError } from "../sdk/http-error.js";
import type { Principal } from "./principal.js";
import type { Level } from "./permissions.js";

/** What a restricted user was granted. */
export interface Scope {
  offices: ReadonlySet<string>;
  agents: ReadonlySet<string>;
}

/** What an id names, as far as scopes care. */
export type RefKind =
  | { kind: "office" }
  | { kind: "agent"; officeId: string }
  | { kind: "run"; agentId: string; officeId: string };

export interface ScopeProvider {
  /** The user's scope, or null when they reach every office. */
  scopeOf(principal: Principal): Scope | null;
  /** What an id names, or null for anything that is not an agent, office or run. */
  lookup(id: string): RefKind | null;
}

let provider: ScopeProvider | null = null;

/** Registered by the access module; `null` unregisters (tests). */
export function setScopeProvider(p: ScopeProvider | null): void {
  provider = p;
}

/** The current caller's scope, or null when nothing restricts them. */
export function currentScope(): Scope | null {
  return scopeFor(getPrincipal());
}

/** A principal's scope, or null when nothing restricts them. */
export function scopeFor(principal: Principal | null): Scope | null {
  if (!principal || principal.kind === "super_admin" || !provider) return null;
  try {
    return provider.scopeOf(principal);
  } catch {
    // Could not read the scope: grant nothing rather than everything.
    return { offices: new Set(), agents: new Set() };
  }
}

function lookup(id: string): RefKind | null {
  try {
    return provider?.lookup(id) ?? null;
  } catch {
    return null;
  }
}

function officeVisible(scope: Scope, officeId: string): boolean {
  if (scope.offices.has(officeId)) return true;
  for (const agentId of scope.agents) {
    const ref = lookup(agentId);
    if (ref?.kind === "agent" && ref.officeId === officeId) return true;
  }
  return false;
}

function agentAllowed(scope: Scope, agentId: string, officeId: string): boolean {
  return scope.agents.has(agentId) || (officeId !== "" && scope.offices.has(officeId));
}

/** True when the scope reaches what this id names (or it names nothing of ours). */
export function refAllowed(scope: Scope, id: string, level: Level): boolean {
  const ref = lookup(id);
  if (!ref) return true;
  switch (ref.kind) {
    case "office":
      return level === "write" ? scope.offices.has(id) : officeVisible(scope, id);
    case "agent":
      return agentAllowed(scope, id, ref.officeId);
    case "run":
      return agentAllowed(scope, ref.agentId, ref.officeId);
  }
}

/** Ids worth looking up: short single tokens. Prose and blobs are skipped. */
function candidate(v: unknown): v is string {
  return typeof v === "string" && v.length >= 4 && v.length <= 100 && !/\s/.test(v);
}

/** Every candidate id in a value, walked a few levels down. */
function collectIds(value: unknown, out: Set<string>, depth = 0): void {
  if (out.size > 200 || depth > 4) return;
  if (candidate(value)) { out.add(value); return; }
  if (Array.isArray(value)) {
    for (const v of value.slice(0, 200)) collectIds(v, out, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k.startsWith("__")) continue;
      collectIds(v, out, depth + 1);
    }
  }
}

/**
 * Why the current caller may not make a call carrying these inputs, or null.
 * `level` is what the call does: a read may name a visible office, a write
 * only a granted one.
 */
export function scopeDenial(inputs: unknown, level: Level): string | null {
  const scope = currentScope();
  if (!scope) return null;
  const ids = new Set<string>();
  collectIds(inputs, ids);
  for (const id of ids) {
    if (!refAllowed(scope, id, level)) {
      const ref = lookup(id);
      return `Forbidden: ${ref?.kind ?? "item"} ${id} is outside the offices you can ${level === "write" ? "change" : "see"}.`;
    }
  }
  return null;
}

/** Throws a 403 when the inputs reach outside the caller's scope. */
export function assertScope(inputs: unknown, level: Level): void {
  const denial = scopeDenial(inputs, level);
  if (denial) throw new HttpError(403, denial);
}

/** Keys an item names an agent, office or run under. */
const REF_KEYS = [
  "id", "agent_id", "agentId", "flow_id", "flowId", "office_id", "officeId", "run_id", "runId",
  "home_flow_id", "target_agent_id", "lead_agent_id",
];

function itemAllowed(scope: Scope, item: Record<string, unknown>): boolean {
  for (const k of REF_KEYS) {
    const v = item[k];
    if (candidate(v) && !refAllowed(scope, v, "read")) return false;
  }
  return true;
}

function filterValue(scope: Scope, value: unknown, depth: number): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const v of value) {
      if (v && typeof v === "object" && !Array.isArray(v) && !itemAllowed(scope, v as Record<string, unknown>)) continue;
      if (candidate(v) && !refAllowed(scope, v, "read")) continue;
      out.push(filterValue(scope, v, depth + 1));
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // A map keyed by id ({ [agentId]: stats }) loses the out-of-scope keys.
    if (candidate(k) && !refAllowed(scope, k, "read")) continue;
    out[k] = filterValue(scope, v, depth + 1);
  }
  return out;
}

/**
 * The value with every out-of-scope agent, office and run removed from its
 * lists and maps, for the current caller. Unrestricted callers get the
 * value back untouched (same object).
 */
export function filterForScope<T>(value: T): T {
  const scope = currentScope();
  if (!scope) return value;
  return filterValue(scope, value, 0) as T;
}

/**
 * A user held to some offices cannot create one: it would land outside
 * their scope, so they could not see what they made. The super admin grants
 * it to them afterwards. Kernel-started work (an agent's own tools) is not
 * a user's call and is never refused here.
 */
export function assertMayCreateOffice(): void {
  if (currentScope()) throw new HttpError(403, "Forbidden: you can only work in the offices you were given; ask an admin to create this one.");
}

/** A restricted user's new agent goes into one of their granted offices. */
export function assertMayCreateAgentIn(flowId: string | null | undefined): void {
  const scope = currentScope();
  if (!scope) return;
  if (!flowId || !scope.offices.has(flowId)) {
    throw new HttpError(403, "Forbidden: a new agent has to go into one of the offices you were given.");
  }
}
