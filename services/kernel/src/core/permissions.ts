/**
 * What a call needs, and whether a set of grants covers it.
 *
 * A permission is `<module>:<level>`:
 *
 *   * `module` is the feature a call belongs to (`tasks`, `agents`,
 *     `cinema`…), read off the call itself: the `/api/<module>/…` segment of
 *     a route, the `kernel_<module>_…` segment of a tool, the `<module>.…`
 *     segment of an RPC action. Offices live in the agents module, so
 *     `offices`, `office` and `flows` count as `agents`.
 *   * `level` is `read` or `write`; `write` includes `read`, `*` is both.
 *
 * Two wildcards:
 *
 *   * `*:<level>` covers every feature module, and no system module.
 *   * `system:<level>` covers the system modules: the ones that reach past
 *     the user's own data into the machine and the install (the filesystem,
 *     LLM providers and keys, extensions, settings, peering…). A role that
 *     sees "everything" should not also read the provider keys by accident,
 *     so these are granted by name or by `system:…`, never by `*`.
 *
 * Two modules are never granted at all: `access` (managing users is how a
 * restricted token becomes an unrestricted one) and `code` (running
 * arbitrary code reaches every tool at once). Only the super admin has them.
 *
 * Classification fails closed: a call whose module or level cannot be read
 * off its name counts as a write to a module named after whatever it is,
 * which a grant either names or does not.
 */

import type { ToolDefinition } from "./types.js";

export type Level = "read" | "write";

export interface Requirement {
  module: string;
  level: Level;
}

export const MODULE_ALIASES: Readonly<Record<string, string>> = {
  offices: "agents",
  office: "agents",
  flows: "agents",
  "agents-flow": "agents",
  "office-env": "agents",
};

/** Granted only by name or by `system:<level>`. */
export const SYSTEM_MODULES = new Set([
  "fs", "llm", "llm-providers", "embeddings", "marketplace", "extensions", "plugins", "registry",
  "store", "license", "update", "edition", "config", "settings", "claude-config", "security",
  "db-drivers", "sandbox-drivers", "peering", "mesh", "federation", "relay", "transfers",
  "cloudflare", "kernl", "mcp", "data", "time-machine", "secrets", "google", "email-accounts",
  "connect", "workspaces",
  // Notification channels: their bot tokens and the paired WhatsApp session.
  "channels",
  // Size of every table and of the database: the install, not anyone's data.
  "storage",
]);

/** Never granted to a user; the super admin only. */
export const RESERVED_MODULES = new Set(["access", "auth", "code"]);

/**
 * Verbs of calls that only read. A call is a read when one of these names it
 * and nothing in its name says it writes; anything else is a write.
 */
const READ_VERBS = new Set([
  "list", "get", "detail", "details", "search", "count", "stats", "export", "show", "view", "read",
  "find", "query", "status", "summary", "overview", "graph", "history", "info", "describe", "health",
  "preview", "tree", "catalog", "metrics", "usage", "report", "logs", "timeline", "lookup", "browse",
  "inspect", "who", "changes", "recent", "upcoming", "today", "overdue", "schema", "explain",
]);

const WRITE_VERBS = new Set([
  "create", "add", "update", "edit", "set", "delete", "remove", "archive", "unarchive", "complete", "log",
  "merge", "assert", "retract", "move", "assign", "send", "post", "reply", "schedule", "reschedule",
  "cancel", "import", "upsert", "rename", "toggle", "mark", "link", "unlink", "enable", "disable",
  "install", "uninstall", "approve", "reject", "publish", "adjust", "snooze", "dismiss", "restore",
  "purge", "reinforce", "feedback", "run", "execute", "trigger", "stop", "resume", "start", "invoke",
  "sync", "reset", "clear", "write", "upload", "propose", "pause",
]);

export function normalizeModule(raw: string): string {
  const m = raw.toLowerCase();
  return MODULE_ALIASES[m] ?? m;
}

function levelFromWords(words: string[]): Level {
  if (words.some((w) => WRITE_VERBS.has(w))) return "write";
  return words.some((w) => READ_VERBS.has(w)) ? "read" : "write";
}

/** `/api/<module>/…`: GET and HEAD read, everything else writes. */
export function requirementForRoute(pathname: string, method: string): Requirement | null {
  const m = /^\/api\/([^/?#]+)/.exec(pathname);
  if (!m) return null;
  const seg = decodeURIComponent(m[1]);
  if (seg === "rpc") {
    const action = decodeURIComponent(pathname.slice("/api/rpc/".length));
    return action ? requirementForRpcAction(action) : null;
  }
  const level: Level = method === "GET" || method === "HEAD" ? "read" : "write";
  if (seg === "channel") {
    // `/api/channel/<name>`: the HTTP copy of a live channel. It holds what
    // the channel's module holds (`agents.flow` → agents), so that is what a
    // user needs, not a permission on "channel".
    const name = decodeURIComponent(pathname.slice("/api/channel/".length)).split(/[./]/)[0];
    if (name) return { module: normalizeModule(name), level };
  }
  return { module: normalizeModule(seg), level };
}

/** `agents.flows.list` → agents:read. */
export function requirementForRpcAction(action: string): Requirement {
  const parts = action.split(/[.:/]/).filter(Boolean);
  const words = parts.slice(1).flatMap((p) => p.split(/[_-]/));
  return { module: normalizeModule(parts[0] ?? action), level: levelFromWords(words) };
}

/**
 * `kernel_tasks_list` → tasks:read. A tool may say outright what it needs
 * with `permission: "<module>:<level>"`; declared side effects make it a
 * write whatever its name says.
 */
export function requirementForTool(name: string, tool?: Pick<ToolDefinition, "sideEffects"> & { permission?: string }): Requirement {
  if (tool?.permission) {
    const parsed = parsePermission(tool.permission);
    if (parsed && parsed.module !== "*" && parsed.level !== "*") return { module: parsed.module, level: parsed.level };
  }
  if (name.startsWith("peer:")) return { module: "mesh", level: "write" };
  const parts = name.split("_").filter(Boolean);
  const body = parts[0] === "kernel" ? parts.slice(1) : parts;
  const module = normalizeModule(body[0] ?? name);
  const level = (tool?.sideEffects?.length ?? 0) > 0 ? "write" : levelFromWords(body.slice(1));
  return { module, level };
}

export function parsePermission(p: string): { module: string; level: Level | "*" } | null {
  const m = /^([a-z0-9_*-]+):(read|write|\*)$/.exec(p.trim().toLowerCase());
  if (!m) return null;
  return { module: m[1] === "*" ? "*" : normalizeModule(m[1]), level: m[2] as Level | "*" };
}

/** True when the string is a permission a role may hold. */
export function isGrantablePermission(p: string): boolean {
  const parsed = parsePermission(p);
  return parsed !== null && !RESERVED_MODULES.has(parsed.module);
}

/** Do these grants cover the requirement? */
export function grants(permissions: readonly string[], need: Requirement): boolean {
  if (RESERVED_MODULES.has(need.module)) return false;
  const system = SYSTEM_MODULES.has(need.module);
  for (const raw of permissions) {
    const p = parsePermission(raw);
    if (!p || RESERVED_MODULES.has(p.module)) continue;
    const levelOk = p.level === "*" || p.level === need.level || (p.level === "write" && need.level === "read");
    if (!levelOk) continue;
    if (p.module === need.module) return true;
    if (p.module === "*" && !system) return true;
    if (p.module === "system" && system) return true;
  }
  return false;
}

export function formatRequirement(r: Requirement): string {
  return `${r.module}:${r.level}`;
}
