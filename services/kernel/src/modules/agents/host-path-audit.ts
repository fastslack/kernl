/**
 * Host folders the kernel cannot see: refused when someone sets one, and
 * reported once when one is already stored.
 *
 * An office repo (`agent_flows.home_repo_path`) or an agent's `__cwd_path__`
 * outside every mount of a Dockerized kernel does not fail anything: the
 * claude_code executor quietly falls back to the office workspace and the
 * agents work somewhere the operator never looks. `vetAgentCwdPath` stops new
 * ones at the edit; `auditHostPaths` finds the ones already in the database at
 * boot and sends one notification for them.
 */

import { log } from "../../core/logger.js";
import { isoNow } from "../../core/helpers.js";
import { HttpError } from "../../sdk/http-error.js";
import { hostPathReachable, type HostPathCheck } from "../../core/host-paths.js";
import type { SqliteDb } from "../../core/db/sqlite.js";

function cwdOf(vars: unknown): string {
  if (!vars || typeof vars !== "object" || Array.isArray(vars)) return "";
  const cwd = (vars as Record<string, unknown>).__cwd_path__;
  return typeof cwd === "string" ? cwd.trim() : "";
}

function parseVars(raw: string | null | undefined): Record<string, unknown> {
  try {
    const value = JSON.parse(raw || "{}") as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Vet the `__cwd_path__` an agent edit carries. `next` is the variables object
 * of the request, `previousRaw` the agent's stored variables (absent on create).
 *
 * - A new or changed path the kernel cannot see → 400 with the reason.
 * - The path the agent already had → kept, with the reason as a warning: the
 *   operator saving another field of a broken agent is not blocked by it.
 * - A visible path that is read-only or not created yet → accepted, warned.
 */
export function vetAgentCwdPath(next: unknown, previousRaw?: string | null): string[] {
  const cwd = cwdOf(next);
  if (!cwd) return [];
  const check = hostPathReachable(cwd);
  if (!check.ok) {
    if (previousRaw !== undefined && cwd === cwdOf(parseVars(previousRaw))) return [check.reason];
    throw new HttpError(400, check.reason);
  }
  const warnings: string[] = [];
  if (!check.writable) {
    const strict = hostPathReachable(cwd, { requireWritable: true });
    warnings.push(strict.ok ? `${cwd} es de solo lectura para Kernl.` : strict.reason);
  }
  if (!check.exists) {
    warnings.push(`${cwd} no existe todavía: hasta que la crees, el agente trabaja en el workspace de su oficina.`);
  }
  return warnings;
}

// ── Boot audit ──────────────────────────────────────────────────

/** kv_store key holding the paths already notified (JSON string[]). */
export const NOTIFIED_KEY = "host_paths_unreachable_notified";

export interface UnreachablePath {
  path: string;
  reason: string;
  offices: string[];
  agents: string[];
}

export interface HostPathAuditDeps {
  db: SqliteDb;
  /** Sends the operator notification; false (or a throw) means nobody got it. */
  notify: (n: { title: string; body: string; priority?: "low" | "normal" | "high"; source?: string }) => Promise<boolean>;
  /** Injectable for tests; defaults to hostPathReachable requiring write access. */
  check?: (path: string) => HostPathCheck;
}

export interface HostPathAuditResult {
  unreachable: UnreachablePath[];
  /** Paths this run notified about (new since the last notification). */
  notified: string[];
}

function readNotified(db: SqliteDb): string[] {
  try {
    const row = db.prepare("SELECT value FROM kv_store WHERE key = ?").get(NOTIFIED_KEY) as { value?: string } | undefined;
    const value = JSON.parse(row?.value || "[]") as unknown;
    return Array.isArray(value) ? value.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function writeNotified(db: SqliteDb, paths: string[]): void {
  try {
    db.prepare("INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)")
      .run(NOTIFIED_KEY, JSON.stringify([...paths].sort()), isoNow());
  } catch (err) {
    log.warn(`host-path audit: could not persist notified paths: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Every unreachable office repo and agent cwd among active rows, grouped by path. */
export function findUnreachablePaths(db: SqliteDb, check: (path: string) => HostPathCheck): UnreachablePath[] {
  const byPath = new Map<string, { offices: Set<string>; agents: Set<string> }>();
  const entry = (path: string) => {
    let e = byPath.get(path);
    if (!e) byPath.set(path, (e = { offices: new Set(), agents: new Set() }));
    return e;
  };

  const flows = db
    .prepare("SELECT name, home_repo_path FROM agent_flows WHERE active = 1 AND COALESCE(home_repo_path, '') <> ''")
    .all() as Array<{ name: string; home_repo_path: string }>;
  for (const f of flows) entry(f.home_repo_path.trim()).offices.add(f.name);

  // LIKE only narrows the scan; the JSON decides.
  const agents = db
    .prepare(
      `SELECT a.name, a.variables, COALESCE(f.name, '') AS office
       FROM agents a LEFT JOIN agent_flows f ON f.id = a.flow_id
       WHERE a.active = 1 AND a.variables LIKE '%cwd_path%'`,
    )
    .all() as Array<{ name: string; variables: string; office: string }>;
  for (const a of agents) {
    const cwd = cwdOf(parseVars(a.variables));
    if (!cwd) continue;
    const e = entry(cwd);
    e.agents.add(a.name);
    if (a.office) e.offices.add(a.office);
  }

  const out: UnreachablePath[] = [];
  for (const [path, e] of byPath) {
    const result = check(path);
    if (result.ok) continue;
    out.push({ path, reason: result.reason, offices: [...e.offices].sort(), agents: [...e.agents].sort() });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function notificationBody(items: UnreachablePath[]): string {
  const blocks = items.map((u) => {
    const who = [
      u.offices.length ? `Oficinas: ${u.offices.join(", ")}` : "",
      u.agents.length ? `Agentes: ${u.agents.join(", ")}` : "",
    ].filter(Boolean).join(" · ");
    return [u.path, who, u.reason].filter(Boolean).join("\n");
  });
  return (
    blocks.join("\n\n") +
    "\n\nHasta resolverlo, esos agentes trabajan en el workspace de su oficina y sus cambios no llegan a la carpeta."
  );
}

/**
 * Log every unreachable path and notify the operator once about the ones not
 * notified before. Kernels restart many times a day, so the notified set is
 * persisted: a path is announced once, forgotten when it becomes reachable (or
 * stops being used), and announced again if it breaks again later. A failed
 * send records nothing, so the next boot retries.
 */
export async function auditHostPaths(deps: HostPathAuditDeps): Promise<HostPathAuditResult> {
  const check = deps.check ?? ((p: string) => hostPathReachable(p, { requireWritable: true }));
  const unreachable = findUnreachablePaths(deps.db, check);
  for (const u of unreachable) {
    log.warn(`host-path audit: ${u.path} (offices: ${u.offices.join(", ") || "-"}; agents: ${u.agents.join(", ") || "-"}): ${u.reason}`);
  }

  const current = new Set(unreachable.map((u) => u.path));
  const previously = readNotified(deps.db);
  const kept = previously.filter((p) => current.has(p));
  const fresh = unreachable.filter((u) => !previously.includes(u.path));

  let sent = false;
  if (fresh.length) {
    try {
      sent = await deps.notify({
        title: fresh.length === 1 ? "Kernl no ve una carpeta de trabajo" : `Kernl no ve ${fresh.length} carpetas de trabajo`,
        body: notificationBody(fresh),
        priority: "high",
        source: "agents",
      });
    } catch (err) {
      log.warn(`host-path audit: notification failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const next = sent ? [...kept, ...fresh.map((u) => u.path)] : kept;
  if (next.length !== previously.length || next.some((p) => !previously.includes(p))) writeNotified(deps.db, next);
  return { unreachable, notified: sent ? fresh.map((u) => u.path) : [] };
}
