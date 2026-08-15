/**
 * Generic driver-agent seeder.
 *
 * One idempotent upsert path for every builtin (no-LLM) scheduled agent:
 *   - the kernel's own generic defs (`KERNEL_AGENT_DEFS` in
 *     builtin-handlers.ts — checks, proactive briefings, marketplace sync,
 *     reflection sweeps), and
 *   - every `AgentDriver` def contributed by modules/extensions via
 *     `KernelModule.getAgentDrivers()` (collected by
 *     `ModuleRegistry.collectAgentDrivers()`).
 *
 * Replaces the per-extension seeders (the retired seed-cinema-agents.ts) with the
 * same conventions those established:
 *   - agents are looked up by `builtin_handler` (stable id — DB rows keep
 *     resolving across refactors);
 *   - missing agents are created with an active schedule;
 *   - existing agents get description/flow refreshed and their cron corrected,
 *     but a schedule the operator paused by hand is NEVER reactivated;
 *   - defs without a `cron` are skipped (handler-only drivers).
 */

import type { SqliteDb } from "../../core/db/sqlite.js";
import type { AgentService } from "./service.js";
import { isoNow } from "../../core/helpers.js";
import { log } from "../../core/logger.js";

export interface DriverAgentDef {
  handler: string;
  name: string;
  description: string;
  cron?: string;
  /** Flow (office) name. Defaults to "Automations". */
  flow?: string;
  /** Per-run timeout. Defaults to 120s. */
  timeout_ms?: number;
  /** Declared dead upstream — do not schedule, and park any existing row. */
  retired?: boolean;
}

const DEFAULT_FLOW = "Automations";

/**
 * Split a driver list into the ones to seed and the handler ids to park.
 *
 * A driver marked `retired` is one whose upstream is gone, not whose code is
 * broken — the module that owns it says so, rather than the kernel keeping a
 * list of other people's handler ids. Dropping the def alone is not enough and
 * that is the whole reason this exists: the `agents` row from previous boots
 * keeps its schedule, and with no def to match, the scheduler falls through to
 * the LLM executor and burns tokens on an agent with an empty prompt. The
 * handler id has to reach `retireHandlers()` for the row to actually stop.
 */
export function splitRetiredDrivers(
  defs: ReadonlyArray<DriverAgentDef>,
): { active: DriverAgentDef[]; retiredHandlers: string[] } {
  const active: DriverAgentDef[] = [];
  const retiredHandlers: string[] = [];
  for (const def of defs) {
    if (def.retired) retiredHandlers.push(def.handler);
    else active.push(def);
  }
  return { active, retiredHandlers };
}

/** Stable ids for well-known offices (matches the in-tree seeders). */
const KNOWN_FLOW_IDS: Record<string, string> = {
  Automations: "flow-automations",
};

const FLOW_DESCRIPTIONS: Record<string, string> = {
  Automations: "Automated system checks and alerts (scheduled background jobs).",
  Proactive: "Proactive briefings and monitors (scheduled background jobs).",
};

/** Resolve a flow id by name, creating the office if it doesn't exist. */
function resolveFlowId(
  service: AgentService,
  name: string,
  cache: Map<string, string>,
): string {
  const cached = cache.get(name);
  if (cached) return cached;

  let id: string | null = null;
  const stableId = KNOWN_FLOW_IDS[name];
  if (stableId && service.getFlow(stableId)) {
    id = stableId;
  } else {
    const byName = service.listFlows().find((f) => f.name === name);
    if (byName) {
      id = byName.id;
    } else {
      const created = service.createFlow({
        name,
        description: FLOW_DESCRIPTIONS[name] ?? `${name} agents (scheduled background jobs).`,
      });
      log.info(`Driver seeder: created "${name}" office (${created.id})`);
      id = created.id;
    }
  }
  cache.set(name, id);
  return id;
}

// The agents service refuses NEW schedules that fire more often than
// KERNEL_AGENT_MIN_SCHEDULE_SECONDS (default 300s). Some drivers declare
// faster crons (e.g. gsync:gmail every 2 min — legacy deployments created
// those schedules before the floor existed). For NEW schedules we clamp the
// simple `*/N * * * *` minute-step shape up to the floor so the agent still
// gets a working schedule; EXISTING schedules are never rewritten to a
// clamped value (legacy sub-floor cadences keep running untouched).
/** Resolve the schedule floor (seconds). Prefers the injected value (from
 *  `config.agents.minScheduleSeconds`); falls back to the same env read as
 *  before so config-less callers keep working. */
function resolveMinScheduleSeconds(injected?: number): number {
  return injected ?? Math.max(1, Number(process.env.KERNEL_AGENT_MIN_SCHEDULE_SECONDS ?? 300));
}

function clampCronToFloor(cron: string, minSeconds: number): { cron: string; clamped: boolean } {
  const m = /^\*\/(\d+) \* \* \* \*$/.exec(cron.trim());
  if (!m) return { cron, clamped: false };
  const stepSeconds = Number(m[1]) * 60;
  if (stepSeconds >= minSeconds) return { cron, clamped: false };
  const minutes = Math.min(59, Math.max(1, Math.ceil(minSeconds / 60)));
  return { cron: `*/${minutes} * * * *`, clamped: true };
}

/** Builtin/script agents (builtin_handler != '') always rank as Cabo (tropa). */
function resolveCaboRankId(db: SqliteDb): string {
  const row = db
    .prepare("SELECT id FROM agent_ranks WHERE name = 'Cabo' LIMIT 1")
    .get() as { id: string } | undefined;
  if (row) return row.id;
  const lowest = db
    .prepare("SELECT id FROM agent_ranks WHERE level >= 2 ORDER BY level ASC LIMIT 1")
    .get() as { id: string } | undefined;
  return lowest?.id ?? "";
}

/**
 * Park agents whose handler no longer has a def — e.g. a check that got folded
 * into a digest agent. The row and its history are kept (soft stop: agent and
 * schedule go inactive) so the office history stays readable and an operator
 * can re-enable it by hand.
 *
 * Retiring matters beyond tidiness: the scheduler falls back to the LLM
 * executor for any active agent whose `builtin_handler` is missing from the
 * handler map, so an orphaned driver row would quietly start burning tokens.
 */
function retireHandlers(db: SqliteDb, handlers: ReadonlyArray<string>): void {
  if (handlers.length === 0) return;
  const now = isoNow();
  let retired = 0;

  for (const handler of handlers) {
    try {
      const rows = db
        .prepare("SELECT id FROM agents WHERE builtin_handler = ? AND active = 1")
        .all(handler) as Array<{ id: string }>;
      for (const row of rows) {
        // Clearing flow_id moves it off the office floor (floor-plan.ts skips
        // agents whose flow doesn't resolve) without losing the row or its runs.
        db.prepare("UPDATE agents SET active = 0, flow_id = '', updated_at = ? WHERE id = ?").run(now, row.id);
        db.prepare("UPDATE agent_schedules SET active = 0 WHERE agent_id = ?").run(row.id);
        retired++;
      }
    } catch (err) {
      log.warn(`Driver seeder: failed to retire "${handler}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (retired > 0) {
    log.info(`Driver seeder: retired ${retired} superseded agent(s) — their checks now run inside a digest agent`);
  }
}

/**
 * Upsert one agent + schedule row per def with a cron. Never touches the
 * active state of an existing schedule.
 */
export function seedDriverAgents(
  db: SqliteDb,
  service: AgentService,
  defs: ReadonlyArray<DriverAgentDef>,
  minScheduleSeconds?: number,
  retiredHandlers: ReadonlyArray<string> = [],
): void {
  retireHandlers(db, retiredHandlers);
  const rankId = resolveCaboRankId(db);
  const flowCache = new Map<string, string>();
  const minSeconds = resolveMinScheduleSeconds(minScheduleSeconds);
  let created = 0;

  for (const def of defs) {
    if (!def.cron) continue; // handler-only driver — nothing to schedule
    try {
      const flowId = resolveFlowId(service, def.flow || DEFAULT_FLOW, flowCache);

      const existing = db
        .prepare("SELECT id FROM agents WHERE builtin_handler = ? LIMIT 1")
        .get(def.handler) as { id: string } | undefined;

      let agentId: string;
      if (existing) {
        // Refresh editable fields + home; never touch active state.
        db.prepare(
          "UPDATE agents SET description = ?, flow_id = ?, show_on_dashboard = 1, updated_at = ? WHERE id = ?",
        ).run(def.description, flowId, isoNow(), existing.id);
        agentId = existing.id;
      } else {
        const agent = service.createAgent({
          name: def.name,
          description: def.description,
          system_prompt: "", // builtin handlers ignore prompts
          flow_id: flowId,
          rank_id: rankId,
          allowed_tools: [],
          max_iterations: 1,
          timeout_ms: def.timeout_ms ?? 120_000,
          show_on_dashboard: true,
          builtin_handler: def.handler,
        });
        agentId = agent.id;
        // createAgent's defaults can drop builtin_handler on a future
        // refactor — re-assert it explicitly (same guard as the old seeders).
        db.prepare("UPDATE agents SET builtin_handler = ?, updated_at = ? WHERE id = ?")
          .run(def.handler, isoNow(), agentId);
        created++;
        log.info(`Driver seeder: created "${def.name}" (${def.handler})`);
      }

      // Ensure exactly one schedule. Create with the def cron if none exists;
      // if one exists, only correct the cron expression — leave active state
      // as the operator set it (a hand-paused schedule stays paused).
      const { cron: effectiveCron, clamped } = clampCronToFloor(def.cron, minSeconds);
      const sched = db
        .prepare("SELECT id, cron_expression FROM agent_schedules WHERE agent_id = ? LIMIT 1")
        .get(agentId) as { id: string; cron_expression: string } | undefined;
      if (!sched) {
        if (clamped) {
          log.info(
            `Driver seeder: "${def.handler}" cron ${def.cron} is below the ` +
            `${minSeconds}s schedule floor — clamped to ${effectiveCron} ` +
            `(lower KERNEL_AGENT_MIN_SCHEDULE_SECONDS to opt in to the faster cadence)`,
          );
        }
        service.addSchedule({ agent_id: agentId, cron_expression: effectiveCron });
      } else if (!clamped && sched.cron_expression !== def.cron) {
        // Never rewrite an existing schedule to a clamped cron — legacy
        // deployments with sub-floor cadences keep their cadence.
        db.prepare("UPDATE agent_schedules SET cron_expression = ?, interval_ms = 0 WHERE id = ?")
          .run(def.cron, sched.id);
      }
    } catch (err) {
      // One broken def must never block the rest of the seeding pass.
      log.warn(`Driver seeder: failed to seed "${def.handler}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (created > 0) {
    log.info(`Driver seeder: ${created} new agent(s) created (${defs.length} defs scanned)`);
  }
}
