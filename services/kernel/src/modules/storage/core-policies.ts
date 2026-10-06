/**
 * Retention for the tables the kernel core writes about itself: agent runs,
 * their event log, evolution history, notifications and LLM usage. Extensions
 * declare their own through `getRetentionPolicies()`.
 *
 * These replace the hardcoded cutoffs of the old `script:cleanup`.
 */

import type { RetentionPolicy } from "../../core/types.js";
import { agePolicy } from "../../sdk/retention.js";

const BUILTIN_AGENT = `agent_id IN (SELECT id FROM agents WHERE builtin_handler IS NOT NULL AND builtin_handler <> '')`;

export function corePolicies(): RetentionPolicy[] {
  return [
    // Steps go with their run: agent_run_steps.run_id is ON DELETE CASCADE.
    agePolicy({
      id: "agents.scheduled-runs",
      label: "Automatic agent runs",
      description: "Completed runs of agents without an LLM (polls, scheduled checks) and their steps.",
      kind: "operational",
      table: "agent_runs",
      alsoTables: ["agent_run_steps"],
      dateColumn: "created_at",
      where: `status = 'completed' AND ${BUILTIN_AGENT}`,
      defaultDays: 14,
      defaultEnabled: true,
    }),
    agePolicy({
      id: "agents.failed-runs",
      label: "Failed or cancelled runs",
      description: "Any agent. Kept longer because they help diagnose problems.",
      kind: "operational",
      table: "agent_runs",
      dateColumn: "created_at",
      where: "status IN ('failed','cancelled')",
      defaultDays: 60,
      defaultEnabled: true,
    }),
    agePolicy({
      id: "agents.llm-runs",
      label: "LLM agent runs",
      description: "Completed runs of agents that use a model: results and steps. They feed the agent's memory.",
      kind: "personal",
      table: "agent_runs",
      dateColumn: "created_at",
      where: `status = 'completed' AND NOT ${BUILTIN_AGENT}`,
      defaultDays: 180,
      defaultEnabled: false,
    }),
    agePolicy({
      id: "agents.event-log",
      label: "Agent event log",
      description: "Detailed log of every run (events, tokens, durations).",
      kind: "operational",
      table: "agent_event_log",
      dateColumn: "created_at",
      defaultDays: 30,
      defaultEnabled: true,
    }),
    agePolicy({
      id: "agents.prompt-versions",
      label: "Old prompt versions",
      description: "Inactive agent prompt versions. The active one and the 5 newest of each agent are always kept.",
      kind: "operational",
      table: "agent_prompt_versions",
      dateColumn: "created_at",
      where: `active = 0 AND (SELECT COUNT(*) FROM agent_prompt_versions newer
                WHERE newer.agent_id = agent_prompt_versions.agent_id
                  AND newer.version > agent_prompt_versions.version) >= 5`,
      defaultDays: 30,
      defaultEnabled: true,
    }),
    agePolicy({
      id: "agents.evolution-rejected",
      label: "Rejected evolution proposals",
      description: "Prompt optimizer cycles that were rejected or failed. Accepted ones are kept.",
      kind: "operational",
      table: "agent_evolution_runs",
      dateColumn: "created_at",
      where: "status IN ('rejected','failed')",
      defaultDays: 30,
      defaultEnabled: true,
    }),
    agePolicy({
      id: "dashboard.notifications",
      label: "Read notifications",
      description: "Dashboard notifications already read. Unread ones are never touched.",
      kind: "operational",
      table: "notifications",
      dateColumn: "created_at",
      where: "read = 1",
      defaultDays: 7,
      defaultEnabled: true,
    }),
    agePolicy({
      id: "llm.usage-daily",
      label: "Daily model usage",
      description: "Daily totals of calls, tokens and cost per model.",
      kind: "operational",
      table: "llm_usage_daily",
      dateColumn: "day",
      defaultDays: 365,
      dayOptions: [90, 180, 365, 730],
      defaultEnabled: true,
    }),
  ];
}
