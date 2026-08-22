#!/usr/bin/env bun
/**
 * Seeds the agent that drives the "Junta y Crisis" demo.
 *
 *   bun run scripts/seed-demo-director.ts
 *   KERNEL_DB_PATH=/path/to/kernel.db bun run scripts/seed-demo-director.ts
 *
 * The demo itself is a builtin handler (`demo:board:crisis`, registered
 * unconditionally by the agent-advanced extension), and a builtin handler only
 * ever fires for an agent whose `builtin_handler` column names it. `POST
 * /api/agents` cannot set that column, so the director has to be seeded here.
 *
 * Idempotent: re-running refreshes the description and re-points the handler,
 * and never un-pauses a director the operator paused on purpose. The agent is
 * deliberately left with NO schedule — the demo runs when somebody asks for it.
 *
 * After seeding against the live DB, restart the kernel so the scheduler and
 * the dashboard pick the agent up.
 */

import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { BOARD_CRISIS_HANDLER } from "../assets/extensions/agents/agent-advanced/_module/demo-board-crisis.js";

const DB_PATH = process.env.KERNEL_DB_PATH ?? resolve(process.cwd(), "data/kernel.db");
const DIRECTOR_NAME = "Demo Director";

const DESCRIPTION =
  'Corre la demo "Junta y Crisis": una junta directiva con un delegado por ' +
  "oficina, interrumpida por la caída de infraestructura de una de ellas. No " +
  "tiene cron — se dispara a mano.";

function main(): void {
  console.log(`🎬 seed-demo-director — db=${DB_PATH}`);

  const db = new Database(DB_PATH);
  try {
    runMigrations(db, "agents", agentsMigrations);
    const service = new AgentService(db, new EventBus());

    // Home it wherever the top-ranked agent lives, so the director sits with
    // the leadership rather than landing in whichever office happens to be
    // first. Falls back to unassigned on an instance with no ranks yet.
    const ranked = service.listAgentsWithRanks();
    const top = ranked
      .filter((r) => r.rank)
      .sort((a, b) => (b.rank?.level ?? 0) - (a.rank?.level ?? 0))[0];
    const flowId = top?.agent.flow_id ?? "";
    const flowName = flowId ? service.getFlow(flowId)?.name ?? flowId : "(sin oficina)";

    const existing = service.listAgents().find((a) => a.name === DIRECTOR_NAME);

    if (existing) {
      // No flow_id here on purpose: updateAgent doesn't take one, and an
      // operator who moved the director to another office should keep it there.
      service.updateAgent(existing.id, {
        description: DESCRIPTION,
        builtin_handler: BOARD_CRISIS_HANDLER,
      });
      console.log(`\n✓ Director actualizado — ${existing.id}`);
    } else {
      const agent = service.createAgent({
        name: DIRECTOR_NAME,
        description: DESCRIPTION,
        builtin_handler: BOARD_CRISIS_HANDLER,
        flow_id: flowId,
        show_on_dashboard: false,
        // Nothing should be able to start the demo by accident: no inbox wake,
        // and the seeder never adds a schedule.
        wake_on_inbox: false,
      });
      console.log(`\n✓ Director creado — ${agent.id}`);
    }

    const id = existing?.id ?? service.listAgents().find((a) => a.name === DIRECTOR_NAME)?.id;
    console.log(`   oficina:  ${flowName}`);
    console.log(`   handler:  ${BOARD_CRISIS_HANDLER}`);
    console.log(`\nReiniciá el kernel y después disparala con:`);
    console.log(`   POST /api/agents/run  { "agent_id": "${id}" }`);
  } finally {
    db.close();
  }
}

main();
