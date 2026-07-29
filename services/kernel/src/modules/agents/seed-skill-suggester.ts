/**
 * Seed the "Skill Suggester" script agent.
 *
 * Lives in the top agent's flow so they can spot it visually next
 * to his own card. Daily cron at 05:00 — skills don't churn fast and the
 * top agent doesn't need a fresh suggestion list per hour.
 *
 * Idempotent: reruns refresh description/cron and ensure the row sits in
 * the commander flow, but never overwrite operator-tuned `variables`.
 */

import type { SqliteDb } from "../../core/db/sqlite.js";
import type { AgentService } from "./service.js";
import { isoNow } from "../../core/helpers.js";
import { log } from "../../core/logger.js";
import { SKILL_SUGGESTER_DEF } from "./skill-suggester.js";

const DEFAULT_VARS: Record<string, unknown> = {
  // Per-agent caps and gates.
  top_n_per_agent: 3,    // surface only the top 3 matches per agent
  agents_per_run: 20,    // rotate through 20 agents/run; full sweep ~daily for ~140 agents
  min_score: 1,          // any token overlap above this idf-weighted score qualifies
  // Comma-separated handler-key prefixes to skip — these agents typically
  // don't benefit from skills (scrapers are deterministic, checks are gates).
  exclude_handlers: "scraper:,check:",
};

export function seedSkillSuggester(db: SqliteDb, service: AgentService): void {
  // Resolve the top agent's flow. Strategy mirrors top-agent-seeder.ts:
  //  1. Find the top agent (highest rank) and reuse its flow_id.
  //  2. Fallback: look for the default management/executive flow by name.
  // If neither exists, skip the seed and warn — the top-agent seeder hasn't
  // run yet and we don't want to spawn the suggester in an orphan flow.
  type RankRow = { id: string; level: number; created_at?: string };
  const ranks = service.listRanks() as RankRow[];
  let flowId: string | null = null;

  if (ranks.length > 0) {
    const topRank = [...ranks].sort((a, b) => {
      if (b.level !== a.level) return b.level - a.level;
      return (a.created_at ?? "").localeCompare(b.created_at ?? "");
    })[0];
    const topAgent = db
      .prepare("SELECT flow_id FROM agents WHERE rank_id = ? LIMIT 1")
      .get(topRank.id) as { flow_id: string } | undefined;
    if (topAgent?.flow_id) flowId = topAgent.flow_id;
  }

  if (!flowId) {
    // Fallback when the top agent hasn't been seeded yet (or its row
    // doesn't carry a flow_id for some reason). The dedicated "Executive
    // Office" was retired in favor of putting the top agent into
    // Management, so we look there first and only fall back to it.
    const flow = db
      .prepare("SELECT id FROM agent_flows WHERE LOWER(name) IN (LOWER('Management'), LOWER('Executive Office')) AND active = 1 ORDER BY (LOWER(name) = LOWER('Management')) DESC LIMIT 1")
      .get() as { id: string } | undefined;
    if (flow) flowId = flow.id;
  }

  if (!flowId) {
    log.warn("Skill Suggester seeder: no top-agent flow found — top-agent-seeder must run first. Skipping.");
    return;
  }

  const existing = db
    .prepare("SELECT id, variables FROM agents WHERE builtin_handler = ? LIMIT 1")
    .get(SKILL_SUGGESTER_DEF.handler) as { id: string; variables: string } | undefined;

  let agentId: string;
  if (existing) {
    // Refresh description + flow + show_on_dashboard, but DO NOT overwrite
    // `variables` — the operator may have tuned top_n / exclude_handlers.
    db.prepare(
      `UPDATE agents SET
         description = ?,
         flow_id = ?,
         show_on_dashboard = 1,
         active = 1,
         updated_at = ?
       WHERE id = ?`,
    ).run(SKILL_SUGGESTER_DEF.description, flowId, isoNow(), existing.id);
    agentId = existing.id;
  } else {
    const created = service.createAgent({
      name: SKILL_SUGGESTER_DEF.name,
      description: SKILL_SUGGESTER_DEF.description,
      system_prompt: "", // builtin handlers ignore the prompt
      flow_id: flowId,
      allowed_tools: [],
      max_iterations: 1,
      timeout_ms: 60_000,
      variables: JSON.stringify(DEFAULT_VARS) as unknown as Record<string, string>,
      show_on_dashboard: true,
      builtin_handler: SKILL_SUGGESTER_DEF.handler,
    });
    agentId = created.id;
    // createAgent strips builtin_handler defaults — re-assert.
    db.prepare(
      "UPDATE agents SET builtin_handler = ?, variables = ?, updated_at = ? WHERE id = ?",
    ).run(SKILL_SUGGESTER_DEF.handler, JSON.stringify(DEFAULT_VARS), isoNow(), agentId);
    log.info(`Skill Suggester: created agent "${SKILL_SUGGESTER_DEF.name}" (${agentId})`);
  }

  // Schedule — ensure exactly one cron row per agent.
  const sched = db
    .prepare("SELECT id, cron_expression FROM agent_schedules WHERE agent_id = ? AND active = 1 LIMIT 1")
    .get(agentId) as { id: string; cron_expression: string } | undefined;
  if (sched) {
    if (sched.cron_expression !== SKILL_SUGGESTER_DEF.cron) {
      db.prepare(
        "UPDATE agent_schedules SET cron_expression = ?, interval_ms = 0 WHERE id = ?",
      ).run(SKILL_SUGGESTER_DEF.cron, sched.id);
    }
  } else {
    service.addSchedule({ agent_id: agentId, cron_expression: SKILL_SUGGESTER_DEF.cron });
  }
}
