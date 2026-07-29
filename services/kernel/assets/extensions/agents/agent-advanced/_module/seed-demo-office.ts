/**
 * Demo Office seeder — creates 3 active flows with 12 agents that talk to
 * each other on cron schedules and produce visible activity in the 3D
 * visualizer. Activated by env DEMO_OFFICE=1 (see bootstrap).
 *
 * Idempotent: every agent is upserted by slug, every flow by name. Re-running
 * the seeder does not duplicate anything; it just refreshes config.
 *
 * What you'll see in the 3D office:
 *   - Newsroom: Editor (manager) dispatches story assignments every minute
 *     via post_to_colleague. Workers wake up via InboxWaker (feature A) and
 *     auto-respond, generating ping-pong walkers and beams.
 *   - Engineering: VP Eng holds a synthetic standup every 90s — walkers
 *     converge on a meeting room, bubbles per turn.
 *   - Operations: Ops Lead posts to the "Incident wire" conversation every
 *     2 min. Devops/Support/SRE are subscribed (feature C) so they wake up
 *     automatically and respond.
 *   - Cross-office escalation: the Editor pings the VP Eng (manager →
 *     manager, cross-office) on every roundup, drawing an orange beam.
 */

import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { EventBus } from "../../../../../src/core/event-bus.js";
import type { AgentService } from "../../../../../src/modules/agents/service.js";
import type { AgentExecutor } from "../../../../../src/modules/agents/executor.js";
import type { Agent, AgentFlow } from "../../../../../src/modules/agents/types.js";
import { isoNow } from "../../../../../src/core/helpers.js";
import { log } from "../../../../../src/core/logger.js";
import { DEMO_SLUGS } from "./demo-handlers.js";

interface FlowSpec {
  key: keyof typeof DEMO_SLUGS;
  name: string;
  description: string;
  color: string;
}

const FLOWS: FlowSpec[] = [
  {
    key: "newsroom",
    name: "Newsroom",
    description: "Editorial team — assignments, fact-checks, copy review.",
    color: "#f59e0b",
  },
  {
    key: "engineering",
    name: "Engineering (Demo)",
    description: "Standups, reviews, eng coordination.",
    color: "#3b82f6",
  },
  {
    key: "ops",
    name: "Operations (Demo)",
    description: "Incident response and reliability watch.",
    color: "#10b981",
  },
];

interface AgentSpec {
  slug: string;
  name: string;
  description: string;
  flowKey: keyof typeof DEMO_SLUGS;
  role: "manager" | "worker";
  builtin_handler: string;
  /**
   * Rank name from the ladder seeded by ranks-seeder.ts. Managers get
   * Senior Manager (✦✦) and workers get Senior Specialist (★★) so the 3D
   * visualizer shows clear insignia even though every demo agent has
   * a builtin_handler (which would otherwise mark them all as Junior Associate).
   */
  rank_name: "Senior Manager" | "Senior Specialist";
  /** Cron — only for managers. Workers react to inbox, no cron needed. */
  cron?: string;
}

const AGENTS: AgentSpec[] = [
  // ── Newsroom ────────────────────────────────────────────
  {
    slug: DEMO_SLUGS.newsroom.editor,
    name: "Editor in Chief",
    description: "Newsroom manager — assigns stories and chases sources.",
    flowKey: "newsroom",
    role: "manager",
    rank_name: "Senior Manager",
    builtin_handler: "demo:newsroom:editor-roundup",
    cron: "* * * * *", // every minute
  },
  {
    slug: DEMO_SLUGS.newsroom.reporter,
    name: "Reporter",
    description: "Writes drafts. Replies on inbox wake.",
    flowKey: "newsroom",
    role: "worker",
    rank_name: "Senior Specialist",
    builtin_handler: `demo:worker:auto-respond:${DEMO_SLUGS.newsroom.reporter}`,
  },
  {
    slug: DEMO_SLUGS.newsroom.fact,
    name: "Fact Checker",
    description: "Verifies sources. Replies on inbox wake.",
    flowKey: "newsroom",
    role: "worker",
    rank_name: "Senior Specialist",
    builtin_handler: `demo:worker:auto-respond:${DEMO_SLUGS.newsroom.fact}`,
  },
  {
    slug: DEMO_SLUGS.newsroom.copy,
    name: "Copy Editor",
    description: "Polishes drafts. Replies on inbox wake.",
    flowKey: "newsroom",
    role: "worker",
    rank_name: "Senior Specialist",
    builtin_handler: `demo:worker:auto-respond:${DEMO_SLUGS.newsroom.copy}`,
  },

  // ── Engineering ─────────────────────────────────────────
  {
    slug: DEMO_SLUGS.engineering.vp,
    name: "VP Engineering",
    description: "Engineering manager — runs standups and clears blockers.",
    flowKey: "engineering",
    role: "manager",
    rank_name: "Senior Manager",
    builtin_handler: "demo:engineering:standup",
    // Every 3 minutes — the standup is now LLM-driven (real conversation),
    // typical run is 40–80s end-to-end. Tightening the cron to 1m would
    // overlap meetings and the visualizer collapses concurrent walkers.
    cron: "*/3 * * * *",
  },
  {
    slug: DEMO_SLUGS.engineering.backend,
    name: "Backend Dev",
    description: "Server-side engineer. Replies on inbox wake.",
    flowKey: "engineering",
    role: "worker",
    rank_name: "Senior Specialist",
    builtin_handler: `demo:worker:auto-respond:${DEMO_SLUGS.engineering.backend}`,
  },
  {
    slug: DEMO_SLUGS.engineering.frontend,
    name: "Frontend Dev",
    description: "UI engineer. Replies on inbox wake.",
    flowKey: "engineering",
    role: "worker",
    rank_name: "Senior Specialist",
    builtin_handler: `demo:worker:auto-respond:${DEMO_SLUGS.engineering.frontend}`,
  },
  {
    slug: DEMO_SLUGS.engineering.qa,
    name: "QA Engineer",
    description: "Test automation. Replies on inbox wake.",
    flowKey: "engineering",
    role: "worker",
    rank_name: "Senior Specialist",
    builtin_handler: `demo:worker:auto-respond:${DEMO_SLUGS.engineering.qa}`,
  },

  // ── Ops ─────────────────────────────────────────────────
  {
    slug: DEMO_SLUGS.ops.lead,
    name: "Ops Lead",
    description: "Operations manager — runs the incident wire.",
    flowKey: "ops",
    role: "manager",
    rank_name: "Senior Manager",
    builtin_handler: "demo:ops:incident-watch",
    cron: "*/2 * * * *", // every 2 minutes
  },
  {
    slug: DEMO_SLUGS.ops.devops,
    name: "DevOps",
    description: "Pipelines and infra. Subscribed to Incident wire.",
    flowKey: "ops",
    role: "worker",
    rank_name: "Senior Specialist",
    builtin_handler: `demo:worker:auto-respond:${DEMO_SLUGS.ops.devops}`,
  },
  {
    slug: DEMO_SLUGS.ops.support,
    name: "Support",
    description: "Customer triage. Subscribed to Incident wire.",
    flowKey: "ops",
    role: "worker",
    rank_name: "Senior Specialist",
    builtin_handler: `demo:worker:auto-respond:${DEMO_SLUGS.ops.support}`,
  },
  {
    slug: DEMO_SLUGS.ops.sre,
    name: "SRE",
    description: "Reliability engineer. Subscribed to Incident wire.",
    flowKey: "ops",
    role: "worker",
    rank_name: "Senior Specialist",
    builtin_handler: `demo:worker:auto-respond:${DEMO_SLUGS.ops.sre}`,
  },
];

function findFlowByName(db: SqliteDb, name: string): AgentFlow | undefined {
  return db
    .prepare("SELECT * FROM agent_flows WHERE name = ? AND active = 1")
    .get(name) as AgentFlow | undefined;
}

function ensureFlow(service: AgentService, db: SqliteDb, spec: FlowSpec): AgentFlow {
  const existing = findFlowByName(db, spec.name);
  if (existing) return existing;
  return service.createFlow({
    name: spec.name,
    description: spec.description,
    color: spec.color,
  });
}

function upsertAgent(
  service: AgentService,
  db: SqliteDb,
  spec: AgentSpec,
  flowId: string,
  rankIdByName: Map<string, string>,
): Agent {
  const rankId = rankIdByName.get(spec.rank_name) ?? "";
  const existing = service.getAgentBySlug(spec.slug);
  if (existing) {
    // Refresh fields that we own from the seeder. Wake-on-inbox is forced ON
    // for the demo so workers participate in the inbox-driven flow.
    // model_chain forced empty so the agent inherits the user's global
    // `agents.defaultModelChain` (configured from the /models dashboard).
    // Don't hardcode providers here — the user already chose them.
    // NOTE: do NOT touch `active`. If the operator disabled an agent by
    // hand (typical reason: a runaway loop, or temporarily silencing a
    // chatty colleague), the seeder must respect that decision across
    // restarts.
    db.prepare(
      `UPDATE agents SET
         description = ?,
         flow_id = ?,
         role = ?,
         rank_id = ?,
         builtin_handler = ?,
         model_chain = '',
         wake_on_inbox = 1,
         updated_at = ?
       WHERE id = ?`,
    ).run(
      spec.description,
      flowId,
      spec.role,
      rankId,
      spec.builtin_handler,
      isoNow(),
      existing.id,
    );
    return service.getAgent(existing.id)!;
  }

  // Fresh insert via service (handles columns + initial prompt version).
  const created = service.createAgent({
    name: spec.name,
    description: spec.description,
    flow_id: flowId,
    wake_on_inbox: true,
    rank_id: rankId,
  });

  // Backfill the columns that createAgent doesn't accept (slug, role,
  // builtin_handler are write-once at seed time for demo agents).
  // model_chain stays empty — the agent will fall through to the global
  // `agents.defaultModelChain` configured in /models.
  db.prepare(
    `UPDATE agents SET
       slug = ?,
       role = ?,
       builtin_handler = ?,
       source_extension_id = 'demo-office',
       updated_at = ?
     WHERE id = ?`,
  ).run(spec.slug, spec.role, spec.builtin_handler, isoNow(), created.id);
  return service.getAgent(created.id)!;
}

function ensureSchedule(
  service: AgentService,
  db: SqliteDb,
  agent: Agent,
  cron: string,
): void {
  // Drop any other active schedule on this agent so a stale cron from a
  // previous seed (e.g. "* * * * *") doesn't keep firing alongside the new
  // one. Only schedules with a different cron_expression are deactivated;
  // an exact match is reused to keep next_run_at intact.
  db.prepare(
    `UPDATE agent_schedules SET active = 0
     WHERE agent_id = ? AND active = 1 AND cron_expression <> ?`,
  ).run(agent.id, cron);

  const existing = db
    .prepare(
      `SELECT id FROM agent_schedules
       WHERE agent_id = ? AND cron_expression = ? AND active = 1
       LIMIT 1`,
    )
    .get(agent.id, cron) as { id: string } | undefined;
  if (existing) return;
  service.addSchedule({ agent_id: agent.id, cron_expression: cron });
}

function ensureSubscriptions(service: AgentService): void {
  // Subscribe Ops workers to a shared "Incident wire" conversation. Idempotent.
  const lead = service.getAgentBySlug(DEMO_SLUGS.ops.lead);
  const devops = service.getAgentBySlug(DEMO_SLUGS.ops.devops);
  const support = service.getAgentBySlug(DEMO_SLUGS.ops.support);
  const sre = service.getAgentBySlug(DEMO_SLUGS.ops.sre);
  if (!lead) return;
  const subscribers = [devops, support, sre].filter((a): a is Agent => !!a);
  if (subscribers.length === 0) return;

  const convo = service.findOrCreateChatConversation({
    topic: "Incident wire",
    participants: [lead.id, ...subscribers.map(s => s.id)],
    initiator_agent_id: lead.id,
  });
  for (const s of subscribers) {
    service.subscribeAgentToConversation({
      agent_id: s.id,
      conversation_id: convo.id,
      mode: "responder",
    });
  }
}

/**
 * Trigger a one-shot kickoff meeting a few seconds after boot so the user
 * sees the live-meeting modal without waiting for the cron to fire. Uses
 * the same builtin_handler the schedule would trigger, so the run flows
 * through the normal executor path and emits the same events.
 */
function scheduleKickoffMeeting(
  service: AgentService,
  executor: AgentExecutor,
  events: EventBus,
): void {
  log.info("Demo Office: kickoff standup scheduled in 8s");
  setTimeout(() => {
    log.info("Demo Office: kickoff timer fired — looking up VP Engineering by slug");
    const vp = service.getAgentBySlug(DEMO_SLUGS.engineering.vp);
    if (!vp) {
      log.warn(`Demo Office kickoff: VP Engineering not found (slug=${DEMO_SLUGS.engineering.vp}). Did the seeder finish?`);
      return;
    }
    const run = service.createRun({
      agent_id: vp.id,
      trigger_type: "manual",
      trigger_payload: { via: "demo_kickoff" },
      goal: "Demo kickoff standup",
    });
    service.updateRun(run.id, { status: "running", started_at: isoNow() });
    log.info(`Demo Office: triggering kickoff standup — agent=${vp.name} run=${run.id}`);
    executor.execute({ agent: vp, goal: "Demo kickoff standup", run, service, events })
      .then((result) => {
        service.updateRun(run.id, {
          status: result.status,
          result: result.result,
          error: result.error,
          steps_count: result.steps_count,
          tokens_used: result.tokens_used,
          completed_at: isoNow(),
        });
        log.info(`Demo Office: kickoff finished — status=${result.status} steps=${result.steps_count}`);
      })
      .catch((err) => {
        service.updateRun(run.id, {
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
          completed_at: isoNow(),
        });
        log.warn(`Demo Office kickoff failed: ${String(err)}`);
      });
  }, 8_000); // 8s — give the dashboard WS time to connect first
}

export function seedDemoOffice(
  db: SqliteDb,
  service: AgentService,
  executor?: AgentExecutor,
  events?: EventBus,
): void {
  log.info("Demo Office: seeding 3 flows + 12 agents (idempotent).");

  // 0) Resolve rank ids — ranks-seeder.ts ran earlier and populated the
  //    catalog. Demo agents force their rank explicitly because they all
  //    have a builtin_handler, which would otherwise auto-assign them all
  //    to "Cabo" (level 2) and flatten the visible hierarchy in the 3D view.
  const ranks = service.listRanks();
  const rankIdByName = new Map<string, string>();
  for (const r of ranks) rankIdByName.set(r.name, r.id);

  // 1) Flows
  const flowIdByKey = new Map<keyof typeof DEMO_SLUGS, string>();
  for (const f of FLOWS) {
    const flow = ensureFlow(service, db, f);
    flowIdByKey.set(f.key, flow.id);
  }

  // 2) Agents
  const inserted: string[] = [];
  for (const spec of AGENTS) {
    const flowId = flowIdByKey.get(spec.flowKey);
    if (!flowId) continue;
    const agent = upsertAgent(service, db, spec, flowId, rankIdByName);
    inserted.push(`${spec.role === "manager" ? "👔" : "👤"} ${agent.name} [${spec.rank_name}]`);
    if (spec.cron) ensureSchedule(service, db, agent, spec.cron);
  }

  // 3) Subscriptions for the Incident wire (feature C demo).
  ensureSubscriptions(service);

  log.info(`Demo Office: ready — ${inserted.length} agent(s): ${inserted.join(", ")}`);

  // 4) Kickoff: fire one standup right away so the user can see the live
  //    meeting modal without waiting for the cron tick. Skipped when the
  //    seeder is invoked without an executor (tests).
  if (executor && events) scheduleKickoffMeeting(service, executor, events);
}
