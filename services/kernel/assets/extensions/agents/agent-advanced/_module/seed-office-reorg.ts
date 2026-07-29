/**
 * Office bootstrap — guarantees the shared offices exist before the other
 * seeders run.
 *
 * Runs BEFORE system-seeder, seed-audit-ceo, seed-error-auditor, etc. so
 * downstream logic already sees the flow it expects to attach agents to.
 *
 * Right now that means one thing: ensure the "Communications" office exists
 * (teal) as the home for every communications-related agent — Gmail/Contacts/
 * Calendar sync, Graph Enrichment, and Email Triage.
 *
 * Source of truth after this step: the driver definitions in
 * `agent-drivers.ts` mark those agents with `flow: "Communications"`, so any
 * future seeding re-run resolves the same row. Idempotent.
 */

import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { AgentService } from "../../../../../src/modules/agents/service.js";
import { log } from "../../../../../src/core/logger.js";

const COMMS_FLOW = {
  name: "Communications",
  description:
    "Communications office: Gmail sync, Contacts sync, Calendar sync, Graph enrichment, and email triage. Serves every other office that needs inbox/CRM data.",
  color: "#0ea5a4",
};

export function seedOfficeReorg(db: SqliteDb, service: AgentService): void {
  const existing = db
    .prepare("SELECT id FROM agent_flows WHERE name = ? AND active = 1")
    .get(COMMS_FLOW.name) as { id: string } | undefined;
  if (existing) return;

  const created = service.createFlow(COMMS_FLOW);
  log.info(`Office bootstrap: created flow "${COMMS_FLOW.name}" (${created.id})`);
}
