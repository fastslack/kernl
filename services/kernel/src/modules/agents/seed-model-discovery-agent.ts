/**
 * Seed the LLM model-discovery cron agent into the "Automations" office.
 *
 * The handler (`llm:model-discovery`) lives in builtin-handlers.ts and is wired
 * into the scheduler's handler map; this seeder just creates the agent +
 * schedule rows so the scheduler actually fires it. Runs zero-token (pure HTTP
 * probes + DB diff) every 6h.
 *
 * Idempotent: looked up by `builtin_handler`. A missing agent is created with an
 * active schedule; an existing one gets its description/flow refreshed and its
 * cron corrected, but a schedule the operator paused by hand is NEVER
 * reactivated (same convention as seed-driver-agents.ts).
 */

import type { SqliteDb } from "../../core/db/sqlite.js";
import type { AgentService } from "./service.js";
import { isoNow } from "../../core/helpers.js";
import { log } from "../../core/logger.js";

const FLOW = {
  id: "flow-automations",
  name: "Automations",
  description: "Automated system checks and alerts (scheduled background jobs).",
};

const HANDLER = "llm:model-discovery";
const NAME = "LLM Model Discovery";
const DESCRIPTION =
  "Polls every running LLM provider's available models every 6h, persists the catalog, " +
  "and notifies on new models or configured refs pointing at a vanished model. " +
  "Suggests a successor but never applies it (use kernel_models_apply_migration).";
const CRON = "0 */6 * * *"; // every 6 hours

/** Resolve the Automations flow id, creating the office if it doesn't exist. */
function resolveAutomationsFlow(service: AgentService): string {
  if (service.getFlow(FLOW.id)) return FLOW.id;
  const byName = service.listFlows().find((f) => f.name === FLOW.name);
  if (byName) return byName.id;
  const created = service.createFlow({ name: FLOW.name, description: FLOW.description });
  log.info(`Model-discovery seeder: created "${FLOW.name}" office (${created.id})`);
  return created.id;
}

/** Script agents (builtin_handler != '') rank as Cabo (tropa). */
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

export function seedModelDiscoveryAgent(db: SqliteDb, service: AgentService): void {
  const flowId = resolveAutomationsFlow(service);
  const rankId = resolveCaboRankId(db);

  const existing = db
    .prepare("SELECT id FROM agents WHERE builtin_handler = ? LIMIT 1")
    .get(HANDLER) as { id: string } | undefined;

  let agentId: string;
  if (existing) {
    db.prepare(
      "UPDATE agents SET description = ?, flow_id = ?, show_on_dashboard = 1, updated_at = ? WHERE id = ?",
    ).run(DESCRIPTION, flowId, isoNow(), existing.id);
    agentId = existing.id;
  } else {
    const created = service.createAgent({
      name: NAME,
      description: DESCRIPTION,
      system_prompt: "", // builtin handlers ignore prompts
      flow_id: flowId,
      rank_id: rankId,
      allowed_tools: [],
      max_iterations: 1,
      timeout_ms: 120_000,
      show_on_dashboard: true,
      builtin_handler: HANDLER,
    });
    agentId = created.id;
    db.prepare("UPDATE agents SET builtin_handler = ?, updated_at = ? WHERE id = ?")
      .run(HANDLER, isoNow(), agentId);
    log.info(`Model-discovery seeder: created "${NAME}" (${agentId})`);
  }

  // Ensure exactly one schedule. Create with CRON if none; if one exists, only
  // correct the cron expression — leave active state as the operator set it.
  const sched = db
    .prepare("SELECT id, cron_expression FROM agent_schedules WHERE agent_id = ? LIMIT 1")
    .get(agentId) as { id: string; cron_expression: string } | undefined;
  if (!sched) {
    service.addSchedule({ agent_id: agentId, cron_expression: CRON });
  } else if (sched.cron_expression !== CRON) {
    db.prepare("UPDATE agent_schedules SET cron_expression = ?, interval_ms = 0 WHERE id = ?")
      .run(CRON, sched.id);
  }
}
