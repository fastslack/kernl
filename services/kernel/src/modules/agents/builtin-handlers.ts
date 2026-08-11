/**
 * Builtin Handlers — lightweight agent handlers that run without LLM.
 *
 * Each handler is a function that performs a check or proactive behavior
 * and returns a result string. The scheduler calls these directly instead
 * of going through the LLM executor when an agent has `builtin_handler` set.
 *
 * ── Coupling shape with extensions ─────────────────────────────────────
 * This file only contains KERNEL-GENERIC handlers (checks, proactive
 * briefings, marketplace/model-discovery, reflection, plus the sub-registries
 * for scripts / job scrapers / skill suggester / personal scrapers).
 *
 * Extension-owned handlers do NOT live here anymore. Each extension ships its
 * own `AgentDriver[]` via `KernelModule.getAgentDrivers()` (see
 * `assets/extensions/<cat>/<slug>/_module/agent-drivers.ts`); bootstrap
 * collects them with `ModuleRegistry.collectAgentDrivers()`, merges the run
 * closures into this map, and seeds their agent rows with the generic driver
 * seeder (`./seed-driver-agents.ts`). The kernel never names an extension.
 *
 * `getAgentHandlers()` (lazy code-bundle factories consumed through
 * `loadExtHandler`) remains available as a secondary channel for handlers
 * that need to share code across extensions.
 */

import type { SqliteDb } from "../../core/db/sqlite.js";
import type { Notifier } from "../../core/notify/notifier.js";
import type { KernelConfig } from "../../core/config.js";
import type { AgentDriverResult } from "../../core/types.js";
import { log } from "../../core/logger.js";
import { safeQuery, safeQueryOne } from "../../core/db/query-helpers.js";
import { messagesFor, localeFor } from "./builtin-messages.js";
import {
  CHECK_PROBES,
  CHECK_DIGEST_DEFS,
  composeDigest,
  type CheckDigestDef,
} from "./builtin-checks.js";
import { ModelCatalog } from "../../core/llm/model-catalog.js";
import { ModelBlocklist } from "../../core/llm/model-blocklist.js";
import {
  discoverModels,
  formatDiscoveryNotification,
  type DiscoveryRegistry,
} from "../../core/llm/model-discovery.js";
import { runStoreUpdates } from "../store/auto-update.js";
import { DEFAULT_STORE_URL } from "../store/index.js";

// ── Types ──────────────────────────────────────

/**
 * A no-LLM handler body. Returning a string means the run SUCCEEDED; returning
 * `{ ok: false, error }` (or throwing) marks the run failed and feeds the
 * auto-pause circuit breaker. See `./driver-result.ts`.
 */
export type BuiltinHandler = () => Promise<AgentDriverResult>;

export interface BuiltinHandlerContext {
  db: SqliteDb;
  notifier: Notifier;
  config: KernelConfig;
  services?: Record<string, unknown>;
  /**
   * Registry of agent-handler factories self-published by extensions via
   * `KernelModule.getAgentHandlers()`. Replaces the previous pattern of
   * dynamic-importing extension paths from inside this file (which broke
   * the "kernel doesn't know its extensions" invariant). Each entry is
   * lazy: the factory only fires when an agent first invokes the handler.
   *
   * Lookup convention: `<extension>:<handler>` (e.g. `"myext:my-helper"`).
   * Returns the extension's module bundle — call sites narrow to the
   * specific shape they need.
   */
  agentHandlerRegistry?: Map<string, () => Promise<unknown>>;
}

/**
 * Pulls a named handler bundle from the registry. Throws a clean error when
 * the extension that owns this handler isn't active — surfaces in the agent
 * run log so the user knows which extension to install/enable.
 *
 * Exported for kernel-generic handlers/sub-registries that may need to reach
 * an extension-published bundle without importing extension paths. Extension
 * drivers themselves call their own module code directly.
 */
export async function loadExtHandler<T>(
  ctx: BuiltinHandlerContext,
  name: string,
): Promise<T> {
  const factory = ctx.agentHandlerRegistry?.get(name);
  if (!factory) {
    throw new Error(
      `Agent handler "${name}" not registered. The owning extension is not active — install/enable it from /extensions.`,
    );
  }
  return (await factory()) as T;
}

// ── Check Handlers ─────────────────────────────
//
// The SQL lives in ./builtin-checks.ts as notification-free *probes*; the two
// wrappers below turn probes into agent handlers. `digestHandler` is what lets
// several checks share one agent and emit a single notification instead of one
// per check (five of them used to fire at 09:00 sharp).

/** One probe, one agent — the classic shape. */
function probeHandler(ctx: BuiltinHandlerContext, key: string): BuiltinHandler {
  return async () => {
    const probe = CHECK_PROBES[key];
    if (!probe) return `Unknown check probe "${key}".`;
    const found = probe.run(ctx.db);
    if (!found) return probe.clear;
    await ctx.notifier.send({ title: probe.title, body: found });
    return found;
  };
}

/** Several probes, one agent, one notification with every finding. */
function digestHandler(ctx: BuiltinHandlerContext, def: CheckDigestDef): BuiltinHandler {
  return async () => {
    const members = def.members.map((k) => CHECK_PROBES[k]).filter(Boolean);
    const { text, hits } = composeDigest(ctx.db, members);
    if (hits === 0) return text;
    await ctx.notifier.send({ title: def.title, body: text });
    return text;
  };
}

// ── Proactive Handlers ─────────────────────────

function morningBriefing(ctx: BuiltinHandlerContext): BuiltinHandler {
  return async () => {
    const todayTasks = safeQueryOne<{ c: number }>(ctx.db,
      `SELECT COUNT(*) as c FROM tasks WHERE status NOT IN ('done', 'cancelled') AND date(due_date) = date('now')`,
    )?.c ?? 0;

    const overdueTasks = safeQueryOne<{ c: number }>(ctx.db,
      `SELECT COUNT(*) as c FROM tasks WHERE status NOT IN ('done', 'cancelled') AND due_date < date('now')`,
    )?.c ?? 0;

    const upcomingReminders = safeQuery<{ title: string; trigger_at: string }>(ctx.db,
      `SELECT title, trigger_at FROM reminders
       WHERE status = 'active' AND trigger_at > datetime('now') AND trigger_at < datetime('now', '+12 hours')
       ORDER BY trigger_at LIMIT 5`,
    );

    const t = messagesFor(ctx.config?.language).morning;
    const locale = localeFor(ctx.config?.language ?? "en");
    const lines: string[] = [t.greeting];

    if (todayTasks > 0) lines.push(t.tasksToday(todayTasks));
    if (overdueTasks > 0) lines.push(t.tasksOverdue(overdueTasks));

    if (upcomingReminders.length > 0) {
      lines.push(t.upcomingReminders);
      for (const r of upcomingReminders) {
        const time = new Date(r.trigger_at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
        lines.push(`• ${time} — ${r.title}`);
      }
    }

    if (lines.length === 1) lines.push(t.nothingPending);

    const body = lines.join("\n");
    // No `channel`: Notifier treats that as "all" and broadcasts to every
    // registered provider. Pinning one (it used to pin telegram) means the
    // notification is dropped on any box where that provider isn't configured
    // — which is the default — so the briefing was computed daily and thrown
    // away. The operator's configured channels decide where this lands.
    await ctx.notifier.send({ title: "Morning Briefing", body });
    return body;
  };
}

function eveningSummary(ctx: BuiltinHandlerContext): BuiltinHandler {
  return async () => {
    const completedToday = safeQueryOne<{ c: number }>(ctx.db,
      `SELECT COUNT(*) as c FROM tasks WHERE status = 'done' AND date(updated_at) = date('now')`,
    )?.c ?? 0;

    const remainingTasks = safeQueryOne<{ c: number }>(ctx.db,
      `SELECT COUNT(*) as c FROM tasks WHERE status NOT IN ('done', 'cancelled')`,
    )?.c ?? 0;

    const tomorrowTasks = safeQueryOne<{ c: number }>(ctx.db,
      `SELECT COUNT(*) as c FROM tasks WHERE status NOT IN ('done', 'cancelled') AND date(due_date) = date('now', '+1 day')`,
    )?.c ?? 0;

    const firedReminders = safeQueryOne<{ c: number }>(ctx.db,
      `SELECT COUNT(*) as c FROM reminders WHERE date(last_fired_at) = date('now')`,
    )?.c ?? 0;

    const t = messagesFor(ctx.config?.language).evening;
    const lines: string[] = [
      t.heading,
      t.completed(completedToday),
      t.remaining(remainingTasks),
      t.tomorrow(tomorrowTasks),
      t.remindersFired(firedReminders),
    ];

    if (completedToday > 0) lines.push(t.wellDone);

    const body = lines.join("\n");
    await ctx.notifier.send({ title: "Evening Summary", body });
    return body;
  };
}

function agentMonitor(ctx: BuiltinHandlerContext): BuiltinHandler {
  return async () => {
    try {
      const offlineThreshold = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const newlyOffline = safeQuery<{ id: string; name: string }>(ctx.db,
        `SELECT id, name FROM external_agents
         WHERE status = 'online' AND last_seen_at IS NOT NULL AND last_seen_at < ?`,
        offlineThreshold,
      );

      const t = messagesFor(ctx.config?.language).monitor;

      for (const agent of newlyOffline) {
        ctx.db.prepare(`UPDATE external_agents SET status = 'offline', updated_at = datetime('now') WHERE id = ?`).run(agent.id);
        await ctx.notifier.send({ title: `${agent.name} offline`, body: t.offlineBody, priority: "normal" });
        log.warn(`Agent went offline: ${agent.name}`);
      }

      return newlyOffline.length > 0
        ? `${t.someOffline(newlyOffline.length)} ${newlyOffline.map((a) => a.name).join(", ")}`
        : t.allOnline;
    } catch {
      return messagesFor(ctx.config?.language).monitor.skipped;
    }
  };
}

function weeklyDigest(ctx: BuiltinHandlerContext): BuiltinHandler {
  return async () => {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const tasksCompleted = safeQueryOne<{ c: number }>(ctx.db,
      `SELECT COUNT(*) as c FROM tasks WHERE status = 'done' AND updated_at >= ?`, weekAgo,
    )?.c ?? 0;

    const tasksCreated = safeQueryOne<{ c: number }>(ctx.db,
      `SELECT COUNT(*) as c FROM tasks WHERE created_at >= ?`, weekAgo,
    )?.c ?? 0;

    const remindersFired = safeQueryOne<{ c: number }>(ctx.db,
      `SELECT COUNT(*) as c FROM reminders WHERE last_fired_at >= ?`, weekAgo,
    )?.c ?? 0;

    const contactsAdded = safeQueryOne<{ c: number }>(ctx.db,
      `SELECT COUNT(*) as c FROM contacts WHERE created_at >= ?`, weekAgo,
    )?.c ?? 0;

    // Sum per currency instead of assuming euros: `purchases.currency` is a
    // real column (default EUR) and a kernel in Buenos Aires or Austin will
    // have ARS or USD rows. Printing "€" over them was simply wrong.
    let purchaseTotals: Array<{ currency: string; total: number }> = [];
    try {
      purchaseTotals = ctx.db
        .prepare(
          `SELECT currency, COALESCE(SUM(total_price), 0) AS total
             FROM purchases WHERE purchased_at >= ?
            GROUP BY currency HAVING total > 0 ORDER BY total DESC`,
        )
        .all(weekAgo) as Array<{ currency: string; total: number }>;
    } catch { /* table may not exist */ }

    const completionRate = tasksCreated > 0 ? Math.round((tasksCompleted / tasksCreated) * 100) : 0;

    const t = messagesFor(ctx.config?.language).weekly;
    const lines: string[] = [
      t.heading,
      t.tasksCreated(tasksCreated),
      t.tasksCompleted(tasksCompleted),
      t.remindersFired(remindersFired),
      t.contactsAdded(contactsAdded),
    ];

    for (const p of purchaseTotals) {
      lines.push(t.spending((p.total / 100).toFixed(2), p.currency));
    }
    lines.push(t.completionRate(completionRate));

    const body = lines.join("\n");
    await ctx.notifier.send({ title: "Weekly Digest", body });
    return body;
  };
}

/**
 * Refresh every subscribed catalog repo. Returns a one-line summary suitable
 * for the agent run history. Posts a notification when new items appear.
 */
function marketplaceSyncRepos(ctx: BuiltinHandlerContext): BuiltinHandler {
  return async () => {
    const repos = ctx.services?.marketplaceRepos as {
      list(): Array<{ id: string; name: string; items_found: number }>;
      syncAll(): Promise<Array<{ id: string; url: string; items: number; commit_sha: string | null; error?: string }>>;
    } | null;
    if (!repos) return "Catalog repos service not available.";

    const before = new Map(repos.list().map((r) => [r.id, r.items_found]));
    const results = await repos.syncAll();
    if (!results.length) return "No subscribed catalog repos.";

    let totalNew = 0;
    let errors = 0;
    const lines: string[] = [];
    for (const r of results) {
      if (r.error) {
        errors++;
        lines.push(`  ✗ ${r.url}: ${r.error}`);
        continue;
      }
      const wasFound = before.get(r.id) ?? 0;
      const delta = r.items - wasFound;
      if (delta > 0) totalNew += delta;
      const tag = delta > 0 ? `+${delta} new` : delta < 0 ? `${delta} removed` : "no change";
      lines.push(`  ✓ ${r.url}: ${r.items} item${r.items === 1 ? "" : "s"} (${tag})`);
    }

    if (totalNew > 0) {
      try {
        await ctx.notifier.send({
          title: "Marketplace: new items in subscribed repos",
          body: `${totalNew} new item(s) across ${results.length} repo(s)`,
        });
      } catch { /* non-fatal */ }
    }

    return `Synced ${results.length} repo(s), +${totalNew} new, ${errors} error(s)\n${lines.join("\n")}`;
  };
}

/**
 * Store auto-update — checks the Kernl store catalog for newer versions of
 * already-installed, licensed extensions and applies them in place via
 * `runStoreUpdates` (Task 4 engine). Gated on `config.store.autoUpdate`
 * (default true); free users (no license JWT) are a strict no-op inside
 * `runStoreUpdates` itself — no network chatter. Notifies + reminds to
 * reload the kernel when at least one extension was updated (live
 * module-code reload isn't implemented — see runtime notes).
 */
function storeAutoUpdate(ctx: BuiltinHandlerContext): BuiltinHandler {
  return async () => {
    if (!ctx.config?.store?.autoUpdate) return "auto-update disabled";

    const getExtensionService = ctx.services?.getExtensionService as
      | (() => import("../extensions/index.js").ExtensionService | null)
      | undefined;
    const licenseHas = ctx.services?.licenseHas as ((feature: string) => boolean) | undefined;
    const licenseJwt = ctx.services?.licenseJwt as (() => string | null) | undefined;
    if (!getExtensionService || !licenseHas || !licenseJwt) {
      return "Store auto-update service not available.";
    }

    const storeUrl = process.env.KERNEL_STORE_URL ?? "https://issuer.lifekernl.com";
    const report = await runStoreUpdates({
      storeUrl,
      getExtensionService,
      licenseHas,
      licenseJwt,
    });

    if (report.catalogError) {
      return `Store auto-update: could not reach the store: ${report.catalogError}`;
    }

    if (report.updated.length > 0) {
      const lines = report.updated.map((r) =>
        r.ok ? `${r.slug}: ${r.from} → ${r.to}` : `${r.slug}: ${r.from} → ${r.to} (failed: ${r.error})`,
      );
      try {
        await ctx.notifier.send({
          title: "Extensions updated",
          body: `${lines.join("\n")}\nReload the kernel to activate.`,
        });
      } catch { /* non-fatal */ }
    }

    return `Store auto-update: checked ${report.checked}, updated ${report.updated.filter((r) => r.ok).length}, skipped ${report.skipped}, ${report.errors} error(s)`;
  };
}

/**
 * Poll every running LLM provider's available models, reconcile the persistent
 * catalog, and notify on new models or configured refs that now point at a
 * vanished model. Zero LLM tokens — pure HTTP probes + DB diff. Never mutates
 * config; applying a suggested migration is a gated user action
 * (`kernel_models_apply_migration`).
 */
function llmModelDiscovery(ctx: BuiltinHandlerContext): BuiltinHandler {
  return async () => {
    const registry = ctx.services?.llmRegistry as DiscoveryRegistry | null;
    if (!registry) return "LLM provider registry not available.";

    const catalog = new ModelCatalog(ctx.db);
    const blocklist = new ModelBlocklist(ctx.db);
    const report = await discoverModels({
      registry,
      catalog,
      blocklist,
      config: ctx.config,
      db: ctx.db,
    });

    const note = formatDiscoveryNotification(report);
    if (note) {
      try {
        await ctx.notifier.send(note);
      } catch {
        /* non-fatal */
      }
    }

    return (
      `Model discovery: ${report.added.length} new, ${report.removed.length} gone, ` +
      `${report.brokenRefs.length} broken ref(s).`
    );
  };
}

// ── Reflection optimizer (Autogenesis-style) ──

function reflectAll(ctx: BuiltinHandlerContext): BuiltinHandler {
  return async () => {
    const optimizer = ctx.services?.reflectionOptimizer as
      | { runCycle: (agentId: string, overrides?: Record<string, unknown>) => Promise<unknown> }
      | undefined;
    const service = ctx.services?.agentService as
      | { listAgents: (f?: { active?: boolean }) => Array<{ id: string; name: string }> }
      | undefined;
    if (!optimizer || !service) return "Reflection optimizer not configured.";
    const agents = service.listAgents({ active: true });
    let proposed = 0, accepted = 0, skipped = 0, failed = 0;
    for (const a of agents) {
      try {
        const run = (await optimizer.runCycle(a.id)) as
          | { status: string } | null;
        if (!run) { skipped++; continue; }
        proposed++;
        if (run.status === "accepted") accepted++;
      } catch (err) {
        failed++;
        log.warn(`Reflection cycle failed for ${a.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return `Reflection sweep: scanned ${agents.length} agents — ${proposed} proposals, ${accepted} auto-committed, ${skipped} skipped (no failures), ${failed} errored.`;
  };
}

// ── Workspace evolver monitor ─────────────────────────
//
// Read-only observer: scans every workspace, reads .evolve/policy.json (if
// present), reports tree dirty/clean state and last-evolution-run status.
// Does NOT auto-trigger cycles — that decision belongs to a supervising
// agent (using kernel_workspace_evolution_run_cycle) or a human.

interface WorkspaceForMonitor { id: string; name: string; owner_flow_id: string; }
interface EvolutionRowForMonitor { status: string; created_at: string; }

function reflectWorkspaces(ctx: BuiltinHandlerContext): BuiltinHandler {
  return async () => {
    const evolver = ctx.services?.workspaceEvolver as
      | {
          describe: (id: string) => Promise<{
            workspace_id: string;
            initialised: boolean;
            policy: unknown;
            head_ref: string | null;
          }>;
        }
      | undefined;
    const wsService = ctx.services?.workspaceService as
      | { listAll: () => WorkspaceForMonitor[] }
      | undefined;
    const agentService = ctx.services?.agentService as
      | { listEvolutionRunsByWorkspace: (id: string, limit?: number) => EvolutionRowForMonitor[] }
      | undefined;

    if (!evolver || !wsService || !agentService) {
      return "Workspace evolver monitor not configured.";
    }

    const all = wsService.listAll();
    const lines: string[] = [];
    let withPolicy = 0, withoutPolicy = 0, dirty = 0, errored = 0;

    for (const ws of all) {
      try {
        const state = await evolver.describe(ws.id);
        if (!state.policy) { withoutPolicy++; continue; }
        withPolicy++;

        const history = agentService.listEvolutionRunsByWorkspace(ws.id, 5);
        const accepted = history.filter((h) => h.status === "accepted").length;
        const rejected = history.filter((h) => h.status === "rejected").length;
        const last = history[0];
        const lastSlug = last ? `${last.status}@${last.created_at.slice(0, 10)}` : "no runs";
        lines.push(
          `• ${ws.name} (${ws.id.slice(0, 8)}) — head ${state.head_ref?.slice(0, 8) ?? "?"} — ${accepted}✓/${rejected}✗ — last ${lastSlug}`,
        );
      } catch (err) {
        errored++;
        log.warn(`reflect-workspaces failed for ${ws.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const summary = [
      `Workspace evolver monitor: ${all.length} workspace(s)`,
      `  • policied: ${withPolicy}`,
      `  • un-policied: ${withoutPolicy}`,
      `  • dirty: ${dirty}`,
      `  • errored: ${errored}`,
    ].join("\n");

    if (lines.length === 0) {
      return `${summary}\n(no workspaces with .evolve/policy.json yet — call POST /api/workspaces/<id>/evolution/init to opt in)`;
    }
    return `${summary}\n${lines.join("\n")}`;
  };
}

// ── Personal scrapers (loaded dynamically if present) ──
// Instance-specific scrapers (target cities, event IDs, etc.) live in
// `./personal-scrapers.ts`, which is gitignored. We import it dynamically at
// module load time; if the file doesn't exist (the default on a fresh clone
// of the public repo), these scrapers simply aren't registered and nothing
// else is affected.
let personalScraperDefs: Array<{
  handler: string; name: string; description: string; cron: string; flow: string;
}> = [];
let registerPersonalScrapers:
  | ((map: Map<string, BuiltinHandler>, ctx: BuiltinHandlerContext) => void)
  | null = null;
try {
  // @ts-ignore — dynamic import of an optional file that may not exist in
  // the public repo (gitignored). `@ts-ignore` is used instead of
  // `@ts-expect-error` because the file DOES exist in instances that have it.
  const mod = await import("./personal-scrapers.js");
  personalScraperDefs = mod.PERSONAL_SCRAPER_DEFS ?? [];
  registerPersonalScrapers = mod.registerPersonalScrapers ?? null;
  if (personalScraperDefs.length > 0) {
    log.info(`Loaded ${personalScraperDefs.length} personal scraper(s) from personal-scrapers.ts`);
  }
} catch {
  // personal-scrapers.ts not installed — public deployment, skip.
}


// ── Registry ───────────────────────────────────

import { createScriptHandlers } from "./script-handlers.js";
import { registerJobScrapers } from "./job-scrapers.js";
import { registerSkillSuggester } from "./skill-suggester.js";

/**
 * Kernel-generic builtin agent definitions (handler id + metadata + cron).
 *
 * Consumed by the generic driver seeder (`./seed-driver-agents.ts`) so every
 * def below gets an idempotent `agents` row + cron schedule at boot —
 * alongside the extension-contributed `AgentDriver` defs collected via
 * `ModuleRegistry.collectAgentDrivers()`.
 *
 * Deliberately NOT included here (each has its own registration path):
 *   - extension handlers (cinema/comms/social/gsync/trading/torrents…) —
 *     they ship as AgentDrivers inside their own extensions now;
 *   - `llm:model-discovery` (seed-model-discovery-agent.ts, env-gated);
 *   - the skill suggester (seed-skill-suggester.ts — commander flow);
 *   - job scrapers / CLI scripts / personal scrapers — their handlers are
 *     registered below but agent rows are seeded manually (scripts/seeds/*)
 *     or per-instance, exactly as before.
 */
export const KERNEL_AGENT_DEFS: Array<{
  handler: string;
  name: string;
  description: string;
  cron: string;
  flow: string;  // flow name to group under
}> = [
  // Automation checks — grouped into digests (see CHECK_DIGEST_DEFS, spread in
  // below). Only checks with no cadence partner stay standalone here.
  { handler: "check:low-stock",           name: "Low Stock Alert",           description: "Checks for products below min stock",              cron: "0 10 * * *",     flow: "Automations" },
  { handler: "check:medications",         name: "Medication Reminder",       description: "Lists active medications for today",               cron: "0 8,20 * * *",   flow: "Automations" },
  ...CHECK_DIGEST_DEFS.map(({ handler, name, description, cron, flow }) => ({ handler, name, description, cron, flow })),
  // Proactive behaviors
  { handler: "proactive:morning-briefing", name: "Morning Briefing",         description: "Daily morning briefing with tasks, reminders",     cron: "0 7 * * *",      flow: "Proactive" },
  { handler: "proactive:evening-summary",  name: "Evening Summary",          description: "Daily evening summary of completed work",          cron: "0 21 * * *",     flow: "Proactive" },
  { handler: "proactive:agent-monitor",    name: "Agent Offline Monitor",    description: "Checks for external agents that went offline",     cron: "*/5 * * * *",    flow: "Proactive" },
  { handler: "proactive:weekly-digest",    name: "Weekly Digest",            description: "Weekly summary of tasks, contacts, spending",      cron: "0 9 * * 0",      flow: "Proactive" },
  // Marketplace
  { handler: "marketplace:sync-repos",  name: "Catalog Repos Sync",     description: "Re-clones every subscribed catalog repo (path C) and refreshes the discovered items count. Notifies when new items appear.", cron: "0 */6 * * *",   flow: "Automations" },
  // Store (paid extensions)
  { handler: "store:auto-update",  name: "Store Auto-Update",  description: "Checks the Kernl store for newer versions of installed, licensed extensions and applies them in place. Free/no-license is a strict no-op. Notifies when an update lands.", cron: "0 4 * * *",   flow: "Automations" },
  // Agent self-evolution (Autogenesis-style reflection loop)
  { handler: "evolution:reflect-all",        name: "Reflection Optimizer",       description: "Scans all active agents, runs a reflection cycle on any with enough recent failures, auto-commits winning candidates",     cron: "0 */6 * * *",  flow: "Automations" },
  { handler: "evolution:reflect-workspaces", name: "Workspace Evolver Monitor",  description: "Scans every workspace with .evolve/policy.json, reports head sha and last evolution outcomes. Read-only — does NOT auto-trigger cycles.", cron: "0 */6 * * *", flow: "Automations" },
];

/** Create the builtin handler map */
export function createBuiltinHandlers(ctx: BuiltinHandlerContext): Map<string, BuiltinHandler> {
  const map = new Map<string, BuiltinHandler>();

  // Automation checks — one handler per probe (so a retired `check:*` id keeps
  // working if an operator wired it by hand), plus one handler per digest.
  for (const key of Object.keys(CHECK_PROBES)) {
    map.set(`check:${key}`, probeHandler(ctx, key));
  }
  for (const def of CHECK_DIGEST_DEFS) {
    map.set(def.handler, digestHandler(ctx, def));
  }

  // Proactive behaviors
  map.set("proactive:morning-briefing", morningBriefing(ctx));
  map.set("proactive:evening-summary",  eveningSummary(ctx));
  map.set("proactive:agent-monitor",    agentMonitor(ctx));
  map.set("proactive:weekly-digest",    weeklyDigest(ctx));

  // Marketplace + model catalog
  map.set("marketplace:sync-repos",  marketplaceSyncRepos(ctx));
  map.set("llm:model-discovery",     llmModelDiscovery(ctx));

  // Store (paid extensions) auto-update
  map.set("store:auto-update", storeAutoUpdate(ctx));

  // Agent self-evolution
  map.set("evolution:reflect-all", reflectAll(ctx));
  map.set("evolution:reflect-workspaces", reflectWorkspaces(ctx));

  // Scrapers — delegated to personal-scrapers.ts when present (gitignored).
  registerPersonalScrapers?.(map, ctx);

  // Job-board scrapers (generic, always available).
  registerJobScrapers(map, ctx);

  // Skill Suggester — deterministic scanner that proposes installed skills
  // to attach to each agent. Lives in the commander's flow; runs daily.
  registerSkillSuggester(map, ctx);

  // CLI Scripts
  for (const [key, handler] of createScriptHandlers(ctx)) {
    map.set(key, handler);
  }

  return map;
}
