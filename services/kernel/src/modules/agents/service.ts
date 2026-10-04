import type { SqliteDb } from "../../core/db/sqlite.js";
import type { EventBus } from "../../core/event-bus.js";
import type { KernelConfig } from "../../core/config.js";
import type { ProjectGateLike } from "./advanced-types.js";
import { newId, isoNow } from "../../core/helpers.js";
import { buildPatch, type PatchColumn } from "../../sdk/query-helpers.js";
import { agentModelChain } from "./agent-fields.js";
import { log } from "../../core/logger.js";
import type {
  Agent,
  AgentFlow,
  AgentRank,
  AgentRun,
  EventTrigger,
  AgentSchedule,
  AgentChain,
  AgentOfficeInboxMessage,
  AgentPromptVersion,
  ModelChainEntry,
  AgentConversation,
  AgentMessage,
  AgentMessageRole,
} from "./types.js";
import { AgentChainsService } from "./services/chains-service.js";
import { AgentEventLogService } from "./services/event-log-service.js";
import { AgentEvolutionService } from "./services/evolution-service.js";
import { AgentTriggersService } from "./services/triggers-service.js";
import { AgentSchedulesService } from "./services/schedules-service.js";
import { AgentPromptVersionsService } from "./services/prompt-versions-service.js";
import { AgentSubscriptionsService } from "./services/subscriptions-service.js";
import { AgentConversationsService } from "./services/conversations-service.js";
import { AgentMemoryService } from "./services/memory-service.js";
import { AgentFlowsService } from "./services/flows-service.js";
import { AgentRanksService } from "./services/ranks-service.js";
import { AgentRunsService } from "./services/runs-service.js";
import { AgentFeedbackService } from "./services/feedback-service.js";
import { OfficeTeamError, DISTRIBUTE_CHAIN_LABEL, TOP_RANK_IDS_SQL } from "./office-team.js";

export type QuestionStatus = "triage" | "pending" | "answered" | "dismissed";
export interface AgentQuestion {
  id: string; from_agent_id: string; flow_id: string; meeting_id: string; run_id: string;
  question: string; context: string; options: Array<{ label: string; value?: string; url?: string }>;
  status: QuestionStatus; selected_option: string; selected_index: number;
  answered_note: string; answered_at: string | null;
  answered_by: "" | "chief" | "human"; chief_note: string; triage_started_at: string | null;
  created_at: string;
}

/** Fallback for `config.agents.autoPauseThreshold` when no config is injected. */
const DEFAULT_AUTO_PAUSE_THRESHOLD = 3;

/** Stable topic so every auto-pause alert for the same pair lands in one thread. */
const AUTO_PAUSE_ALERT_TOPIC = "Agent auto-pause alerts";

/** The agent columns updateAgent may write, and how each field is stored. */
const AGENT_PATCH: Record<string, PatchColumn> = {
  name: "text",
  description: "text",
  system_prompt: "text",
  goal_template: "text",
  allowed_tools: "json",
  denied_tools: "json",
  provider: "text",
  model: "text",
  max_iterations: "text",
  timeout_ms: "text",
  active: "bool",
  max_tokens: "text",
  max_errors: "text",
  variables: "json",
  show_on_dashboard: "bool",
  builtin_handler: "text",
  rank_id: "text",
  // An empty chain is stored as "" (not "[]"): "no chain, use the defaults".
  model_chain: { to: (chain: ModelChainEntry[]) => (chain.length > 0 ? JSON.stringify(chain) : "") },
  wake_on_inbox: "bool",
  progressive_discovery: "bool",
  skin_id: "text",
  under_revision: "bool",
  executor_type: "text",
  skills: { column: "skills_json", to: (slugs: string[]) => JSON.stringify(slugs) },
};

/**
 * Methods AgentService serves straight from one of its sub-services: same
 * name, same signature, no logic of its own. They used to be written out one
 * by one (96 of them, each repeating its full parameter types); now the
 * table below binds them in the constructor, and the interface merged into
 * the class gives them their types from the sub-service itself. Every
 * existing `agentService.*` call site keeps working unchanged. A method with
 * logic of its own stays written out in the class.
 */
const DELEGATED = {
  memory: ["setEmbeddingsClient", "getEmbeddingsClient", "addLearning", "getLearnings", "addMemory", "getMemory", "clearMemory", "getRelevantMemory", "getRelevantMemoryByEmbedding", "findSimilarPastRuns", "findSimilarPastRunsByEmbedding", "getRelevantLearnings", "getRelevantLearningsByEmbedding", "updateLearningConfidence", "deactivateLearning", "getLearningsActiveAt", "reinforceLearningsForRun", "cleanupLowConfidenceLearnings"],
  flows: ["createFlow", "ensureOfficeHome", "resolveFlowHome", "getFlowWorkspace", "setFlowWorkspaceSpec", "prepareFlowWorkspace", "setFlowRepo", "listFlows", "getFlow", "updateFlow", "deleteFlow", "assignAgentToFlow", "syncLots"],
  ranks: ["createRank", "listRanks", "getRank", "getTopAgent", "updateRank", "deleteRank", "assignRankToAgent"],
  runs: ["createRun", "getRun", "listRuns", "cancelRun", "cleanupStaleRuns", "recoverStaleRuns", "addStep", "getSteps", "getRunEvents", "saveCheckpoint", "getCheckpoint", "reopenRun", "markCheckpointResumed", "deleteCheckpoint", "getRunConditions", "setRunCondition"],
  triggers: ["addEventTrigger", "listEventTriggers", "getActiveEventTriggers", "removeEventTrigger", "updateTriggerLastFired"],
  schedules: ["addSchedule", "listSchedules", "getDueSchedules", "removeSchedule", "getSchedule", "updateSchedule", "updateScheduleNextRun"],
  feedback: ["addFeedback", "getFeedback"],
  conversations: ["createConversation", "getConversation", "findOrCreateChatConversation", "listConversations", "closeConversation", "archiveConversation", "archiveClosedConversations", "parseParticipants", "addParticipant", "postMessage", "getMessage", "listMessages", "getDebateCooldown", "recordDebateCooldown", "countRecentAutoDebates"],
  chains: ["addChain", "listChains", "getChainsBySource", "removeChain"],
  eventLog: ["logEvent", "getEventLog", "getEventLogCount", "clearEventLog"],
  promptVersions: ["activatePromptVersion", "listPromptVersions", "getPromptVersion", "getActivePromptVersion", "restorePromptVersion", "diffPromptVersions"],
  evolution: ["createEvolutionRun", "updateEvolutionRun", "listEvolutionRuns", "listEvolutionRunsByWorkspace", "getEvolutionRun"],
  subscriptions: ["subscribeAgentToConversation", "unsubscribeAgentFromConversation", "getSubscription", "listSubscriptionsForConversation", "listSubscriptionsForAgent", "markSubscriptionFired"],
} as const;

export interface AgentService extends
  Pick<AgentMemoryService, (typeof DELEGATED)["memory"][number]>,
  Pick<AgentFlowsService, (typeof DELEGATED)["flows"][number]>,
  Pick<AgentRanksService, (typeof DELEGATED)["ranks"][number]>,
  Pick<AgentRunsService, (typeof DELEGATED)["runs"][number]>,
  Pick<AgentTriggersService, (typeof DELEGATED)["triggers"][number]>,
  Pick<AgentSchedulesService, (typeof DELEGATED)["schedules"][number]>,
  Pick<AgentFeedbackService, (typeof DELEGATED)["feedback"][number]>,
  Pick<AgentConversationsService, (typeof DELEGATED)["conversations"][number]>,
  Pick<AgentChainsService, (typeof DELEGATED)["chains"][number]>,
  Pick<AgentEventLogService, (typeof DELEGATED)["eventLog"][number]>,
  Pick<AgentPromptVersionsService, (typeof DELEGATED)["promptVersions"][number]>,
  Pick<AgentEvolutionService, (typeof DELEGATED)["evolution"][number]>,
  Pick<AgentSubscriptionsService, (typeof DELEGATED)["subscriptions"][number]> {}

export class AgentService {
  /**
   * Per-aggregate services this class delegates to. Each owns its own tables;
   * the delegating methods below keep every existing `agentService.*` call
   * site working unchanged.
   */
  private readonly chains: AgentChainsService;
  private readonly eventLog: AgentEventLogService;
  private readonly evolution: AgentEvolutionService;
  private readonly triggers: AgentTriggersService;
  private readonly schedules: AgentSchedulesService;
  private readonly promptVersions: AgentPromptVersionsService;
  private readonly subscriptions: AgentSubscriptionsService;
  private readonly conversations: AgentConversationsService;
  private readonly memory: AgentMemoryService;
  private readonly flows: AgentFlowsService;
  private readonly ranks: AgentRanksService;
  private readonly runs: AgentRunsService;
  private readonly feedback: AgentFeedbackService;
  /** Projects seam (src/modules/projects) — null until bootstrap registers it. */
  private projectGate: ProjectGateLike | null = null;

  setProjectGate(gate: ProjectGateLike | null): void { this.projectGate = gate; }
  getProjectGate(): ProjectGateLike | null { return this.projectGate; }

  constructor(
    private db: SqliteDb,
    private events: EventBus,
    /**
     * Optional — live KernelConfig, so `addSchedule`'s rate-limit floor reads
     * the same `config.agents.minScheduleSeconds` the rest of the app uses
     * instead of re-reading `process.env.KERNEL_AGENT_MIN_SCHEDULE_SECONDS`
     * directly (which can diverge once config is hot-reloaded). Trailing +
     * optional so existing call sites (demo scripts, tests) are unaffected.
     */
    private config?: KernelConfig,
  ) {
    this.chains = new AgentChainsService(db, events);
    this.eventLog = new AgentEventLogService(db);
    this.evolution = new AgentEvolutionService(db, events);
    this.triggers = new AgentTriggersService(db, events);
    this.schedules = new AgentSchedulesService(db, events, config);
    this.promptVersions = new AgentPromptVersionsService(db, events, (id) => this.getAgent(id));
    this.subscriptions = new AgentSubscriptionsService(
      db,
      (id) => this.getAgent(id),
      (id) => this.getConversation(id),
    );
    this.conversations = new AgentConversationsService(db, events);
    this.memory = new AgentMemoryService(db);
    this.flows = new AgentFlowsService(db, events, (id) => this.getAgent(id));
    this.ranks = new AgentRanksService(
      db,
      events,
      (id) => this.getAgent(id),
      (filters) => this.listAgents(filters),
    );
    this.runs = new AgentRunsService(
      db,
      events,
      (id) => this.getAgent(id),
      (table, column, modelColumn, rowId, text) =>
        this.scheduleEmbed(table, column, modelColumn, rowId, text),
      () => this.projectGate,
    );
    this.feedback = new AgentFeedbackService(
      db,
      events,
      (id) => this.getRun(id),
      (agentId, runCreatedAt, outcome) =>
        this.reinforceLearningsForRun(agentId, runCreatedAt, outcome),
    );

    // Bind the pass-through methods listed in DELEGATED (see above).
    for (const [sub, names] of Object.entries(DELEGATED)) {
      const target = this[sub as keyof typeof DELEGATED] as unknown as Record<string, (...args: unknown[]) => unknown>;
      for (const name of names) {
        (this as unknown as Record<string, unknown>)[name] = target[name].bind(target);
      }
    }

    // Keep every office on a lot of the 3D floor whichever path wrote its
    // agents (create, edit, office kit, MCP): each one announces itself here.
    events.on("data.changed", (payload) => {
      const p = payload as { module?: string; action?: string } | undefined;
      if (p?.module !== "agents" || p.action === "lots_synced") return;
      try {
        this.flows.syncLots();
      } catch (err) {
        log.warn(`syncLots failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  /** @see AgentMemoryService.scheduleEmbed — `createRun` embeds its goal through here. */
  private scheduleEmbed(
    table: "agent_memory" | "agent_learnings" | "agent_runs",
    column: "embedding" | "goal_embedding",
    modelColumn: "embedding_model" | "goal_embedding_model",
    rowId: string,
    text: string,
  ): void {
    this.memory.scheduleEmbed(table, column, modelColumn, rowId, text);
  }


  // ── Flows (offices) → AgentFlowsService ────────────

  /**
   * Make `agentId` the one lead of its office: it becomes `manager` and every
   * other manager of the office becomes `worker`, in one transaction. Role is
   * deliberately not editable through `updateAgent`.
   *
   * The top-rank agent (the "headquarters" Chief — the agent whose rank has
   * the highest `agent_ranks.level`) is never part of an office's lead set:
   * it can't be made a lead, and it is excluded from the demotion sweep so
   * making someone else the lead never touches its `role`. Same exclusion
   * clause as `AgentFlowsService.deleteFlow`.
   */
  setOfficeLead(flowId: string, agentId: string): { lead_id: string; demoted: string[] } {
    const flow = this.getFlow(flowId);
    if (!flow || flow.active !== 1) throw new OfficeTeamError(`Office not found: ${flowId}`, 404);
    const agent = this.getAgent(agentId);
    if (!agent || agent.flow_id !== flowId) throw new OfficeTeamError(`Agent ${agentId} is not in this office`, 400);
    const isTopRank = this.db
      .prepare(`SELECT 1 FROM agents WHERE id = ? AND COALESCE(rank_id, '') IN (${TOP_RANK_IDS_SQL})`)
      .get(agentId);
    if (isTopRank) throw new OfficeTeamError("the headquarters agent cannot lead an office", 400);
    const now = isoNow();
    const trx = this.db.transaction(() => {
      const demoted = (this.db
        .prepare(
          `SELECT id FROM agents WHERE flow_id = ? AND role = 'manager' AND id <> ?
             AND COALESCE(rank_id, '') NOT IN (${TOP_RANK_IDS_SQL})`,
        )
        .all(flowId, agentId) as Array<{ id: string }>).map((row) => row.id);
      this.db
        .prepare(
          `UPDATE agents SET role = 'worker', updated_at = ?
             WHERE flow_id = ? AND role = 'manager' AND id <> ?
               AND COALESCE(rank_id, '') NOT IN (${TOP_RANK_IDS_SQL})`,
        )
        .run(now, flowId, agentId);
      this.db.prepare("UPDATE agents SET role = 'manager', updated_at = ? WHERE id = ?").run(now, agentId);
      this.handOverToLead(flowId, agentId, demoted);
      return demoted;
    });
    const demoted = trx();
    this.events.emit("data.changed", { module: "agents", action: "office_lead_set" });
    return { lead_id: agentId, demoted };
  }

  /**
   * "El jefe reparte al equipo". On: a chain lead → member labelled
   * office:distribute for every member the lead does not already chain to
   * (a hand-made chain counts — nobody runs twice). Off: remove the
   * office:distribute chains to office members; other chains stay.
   *
   * Lead and members are the set the rail shows: every agent of the office
   * whatever its `active` (pausing and deleteAgent both only set active = 0),
   * minus the top-rank agent, excluded with deleteFlow's rule. Paused members
   * get their chain too; the executor skips inactive targets until resumed.
   */
  setLeadDistributes(flowId: string, enabled: boolean): { lead_id: string; created: number; removed: number } {
    const flow = this.getFlow(flowId);
    if (!flow || flow.active !== 1) throw new OfficeTeamError(`Office not found: ${flowId}`, 404);
    const notTopRank = `COALESCE(rank_id, '') NOT IN (${TOP_RANK_IDS_SQL})`;
    const leads = this.db
      .prepare(`SELECT id FROM agents WHERE flow_id = ? AND role = 'manager' AND ${notTopRank}`)
      .all(flowId) as Array<{ id: string }>;
    if (leads.length === 0) throw new OfficeTeamError("This office has no lead", 400);
    if (leads.length > 1) {
      throw new OfficeTeamError("This office has more than one lead; make one of them the lead first", 409);
    }
    const leadId = leads[0].id;
    let created = 0;
    let removed = 0;
    const trx = this.db.transaction(() => {
      if (enabled) {
        created = this.chainLeadToMembers(flowId, leadId);
      } else {
        const rows = this.db
          .prepare(
            `SELECT c.id FROM agent_chains c JOIN agents a ON a.id = c.target_agent_id
              WHERE c.source_agent_id = ? AND c.label = ? AND a.flow_id = ?`,
          )
          .all(leadId, DISTRIBUTE_CHAIN_LABEL, flowId) as Array<{ id: string }>;
        for (const row of rows) {
          if (this.removeChain(row.id)) removed++;
        }
      }
    });
    trx();
    return { lead_id: leadId, created, removed };
  }

  /**
   * Give the new lead what the demoted managers ran as lead, so the office
   * keeps one lead cadence and one set of office:distribute chains.
   * Schedules move to the new lead unless it already has an active one (its
   * cadence wins and the demoted ones are deleted). office:distribute chains
   * from a demoted manager are deleted and, if there were any, rebuilt from
   * the new lead as "El jefe reparte" on does. Other chains stay.
   * Runs inside setOfficeLead's transaction; `demoted` never holds the top-rank agent.
   */
  private handOverToLead(flowId: string, leadId: string, demoted: string[]): void {
    let distributed = false;
    for (const formerId of demoted) {
      const leadHasSchedule = this.db
        .prepare("SELECT 1 FROM agent_schedules WHERE agent_id = ? AND active = 1")
        .get(leadId);
      if (leadHasSchedule) {
        this.db.prepare("DELETE FROM agent_schedules WHERE agent_id = ?").run(formerId);
      } else {
        this.db.prepare("UPDATE agent_schedules SET agent_id = ? WHERE agent_id = ?").run(leadId, formerId);
      }
      const removed = this.db
        .prepare("DELETE FROM agent_chains WHERE source_agent_id = ? AND label = ?")
        .run(formerId, DISTRIBUTE_CHAIN_LABEL);
      if (removed.changes > 0) distributed = true;
    }
    if (distributed) this.chainLeadToMembers(flowId, leadId);
  }

  /**
   * Chain the lead to every member of its office it does not already chain
   * to (a hand-made chain counts), labelled office:distribute. Members are the
   * office's agents whatever their `active`, minus the lead and the top-rank
   * agent. Call inside a transaction; returns how many chains were created.
   */
  private chainLeadToMembers(flowId: string, leadId: string): number {
    const members = this.db
      .prepare(`SELECT id FROM agents WHERE flow_id = ? AND id <> ? AND COALESCE(rank_id, '') NOT IN (${TOP_RANK_IDS_SQL})`)
      .all(flowId, leadId) as Array<{ id: string }>;
    const chained = new Set(this.getChainsBySource(leadId).map((c) => c.target_agent_id));
    let created = 0;
    for (const member of members) {
      if (chained.has(member.id)) continue;
      this.addChain({ source_agent_id: leadId, target_agent_id: member.id, label: DISTRIBUTE_CHAIN_LABEL });
      created++;
    }
    return created;
  }

  // ── Ranks → AgentRanksService ───────────────────────


  // ── Model fallback chain ────────────────────────────

  /**
   * Resolve an agent's effective model chain for LLM invocation.
   * If `model_chain` is populated, returns that list (validated/filtered).
   * Otherwise returns a 1-entry fallback list from `(provider, model)`.
   * Entries with blank provider AND blank model are filtered out.
   */
  resolveModelChain(agent: Agent): ModelChainEntry[] {
    const chain = agentModelChain(agent);
    // No usable chain (empty, malformed, or every entry blank) → the single pair.
    return chain.length > 0 ? chain : [{ provider: agent.provider, model: agent.model }];
  }

  setModelChain(agentId: string, chain: ModelChainEntry[]): boolean {
    const agent = this.getAgent(agentId);
    if (!agent) return false;
    const serialized = chain.length > 0 ? JSON.stringify(chain) : "";
    this.db.prepare("UPDATE agents SET model_chain = ?, updated_at = ? WHERE id = ?")
      .run(serialized, isoNow(), agentId);
    this.events.emit("data.changed", { module: "agents", action: "agent_model_chain_changed" });
    return true;
  }

  /** Switch the agent's execution engine between 'native' (multi-provider) and 'claude_code' (SDK). */
  setExecutorType(agentId: string, executorType: "native" | "claude_code"): boolean {
    if (executorType !== "native" && executorType !== "claude_code") return false;
    const agent = this.getAgent(agentId);
    if (!agent) return false;
    this.db.prepare("UPDATE agents SET executor_type = ?, updated_at = ? WHERE id = ?")
      .run(executorType, isoNow(), agentId);
    this.events.emit("data.changed", { module: "agents", action: "agent_executor_type_changed" });
    return true;
  }

  /** Resolve each active agent's rank (left-join style). Unranked agents have rank=null. */
  listAgentsWithRanks(): Array<{ agent: Agent; rank: AgentRank | null }> {
    const agents = this.listAgents({ active: true });
    const ranks = new Map(this.listRanks().map(r => [r.id, r]));
    return agents.map(a => ({ agent: a, rank: ranks.get(a.rank_id) ?? null }));
  }

  /**
   * Build a compact directory of every active agent in the fleet, grouped by
   * office (flow). Injected into every run's system prompt so every agent
   * knows who exists and how to reach them — no need to call directory first.
   *
   * Rendered fresh on each run; ~100 tokens per 30 agents. Callers can pass
   * the current agent's id to exclude it from the listing.
   */
  buildDirectoryBlock(currentAgentId: string): string {
    const agents = this.listAgents({ active: true }).filter(a => a.id !== currentAgentId);
    if (agents.length === 0) return "";

    const flows = this.listFlows();
    const flowById = new Map(flows.map(f => [f.id, f]));
    const byFlow = new Map<string, Agent[]>();
    const unassigned: Agent[] = [];
    for (const a of agents) {
      if (a.flow_id && flowById.has(a.flow_id)) {
        const list = byFlow.get(a.flow_id) ?? [];
        list.push(a);
        byFlow.set(a.flow_id, list);
      } else {
        unassigned.push(a);
      }
    }

    const lines: string[] = [
      "## Fleet directory — who else exists",
      "Every agent below can be reached through the social tools. You do NOT need to call kernel_agents_directory first for names listed here — IDs are only required if you need the exact UUID.",
      "",
    ];
    for (const flow of flows) {
      const list = byFlow.get(flow.id);
      if (!list || list.length === 0) continue;
      lines.push(`### ${flow.name}`);
      for (const a of list) {
        const rank = this.getRank(a.rank_id);
        const rankTag = rank ? ` ${rank.insignia || ""} ${rank.name}`.trim() : "";
        const desc = a.description ? ` — ${a.description.slice(0, 120)}` : "";
        lines.push(`- **${a.name}**${rankTag ? ` (${rankTag})` : ""} \`${a.id}\`${desc}`);
      }
      lines.push("");
    }
    if (unassigned.length > 0) {
      lines.push("### Unassigned");
      for (const a of unassigned) {
        const desc = a.description ? ` — ${a.description.slice(0, 120)}` : "";
        lines.push(`- **${a.name}** \`${a.id}\`${desc}`);
      }
      lines.push("");
    }

    lines.push("## How to reach anyone above");
    lines.push("- `kernel_agents_ask_supervisor({ question, context, options })` — when you are in doubt (unclear requirements, priorities, or a decision you are not authorized to make), ask the chief instead of guessing. Exactly 4 concrete options, your preferred one first. Keep working on what doesn't depend on it; the answer comes back on its own. Never re-ask an answered question.");
    lines.push("- `kernel_agents_post_to_colleague({ to_agent_id, subject, body })` — async, non-blocking. They read it on their next run and reply through their own outbox. Use for clarifications and back-and-forth threads between agents. Works ACROSS offices.");
    lines.push("- `kernel_agents_invoke({ agent_id, goal })` — blocking. You wait for their result. Use for single pointed questions that must be resolved before you continue.");
    lines.push("- `kernel_agents_call_meeting({ topic, attendee_ids })` — group deliberation. Use when 2+ other agents need to converge on an answer and you want their input recorded. You become moderator (or the highest-ranked attendee takes over).");
    lines.push("- When replying to another agent, wrap your output like `<msg role=\"answer\" replies_to=\"<their-message-id>\">...</msg>`. Valid roles: `answer` (agreeing/informing), `counter` (disagreeing — triggers debate if 2+ of you disagree), `question`, `stmt`, `summary`, `vote`. If you skip the wrapper your reply defaults to `answer`.");
    return lines.join("\n");
  }

  /**
   * Build the hierarchy-aware context block that gets injected into an agent's
   * system prompt at execution time. Returns '' if the agent has no rank.
   */
  buildHierarchyBlock(agentId: string): string {
    const me = this.getAgent(agentId);
    if (!me) return "";
    const myRank = this.getRank(me.rank_id);
    if (!myRank) return "";

    const all = this.listAgentsWithRanks().filter(x => x.rank && x.agent.id !== me.id);
    const superiors = all
      .filter(x => x.rank!.level > myRank.level)
      .sort((a, b) => b.rank!.level - a.rank!.level)
      .slice(0, 10);
    const peers = all
      .filter(x => x.rank!.level === myRank.level)
      .slice(0, 6);
    const subordinates = all
      .filter(x => x.rank!.level < myRank.level)
      .sort((a, b) => b.rank!.level - a.rank!.level)
      .slice(0, 6);

    const lines: string[] = [
      "## Reporting hierarchy",
      `Your rank: **${myRank.name}** ${myRank.insignia} (level ${myRank.level}).`,
    ];
    if (superiors.length > 0) {
      lines.push("Seniors (have authority over your decisions):");
      for (const s of superiors) lines.push(`  - ${s.agent.name} — ${s.rank!.name} ${s.rank!.insignia}`);
    } else {
      lines.push("You are the highest active rank — you report to the human.");
    }
    if (peers.length > 0) {
      lines.push("Peers (same rank):");
      for (const p of peers) lines.push(`  - ${p.agent.name}`);
    }
    if (subordinates.length > 0) {
      lines.push("Reports:");
      for (const s of subordinates) lines.push(`  - ${s.agent.name} — ${s.rank!.name} ${s.rank!.insignia}`);
    }
    lines.push("");
    lines.push("**Working rules:**");
    lines.push("- In meetings or disagreements, the final call belongs to the highest rank present.");
    lines.push("- You don't invoke a senior the way you'd invoke a peer — frame *requests* or *escalations*, and accept their decision.");
    lines.push("- You can give a report clear directives and expect them to be carried out.");
    lines.push("- If you receive a goal from a report, you may redefine it, reprioritize it, or decline it with justification.");
    lines.push("- Identity and rank are respected within and across offices — the hierarchy is global.");

    return lines.join("\n");
  }

  // ── Agent CRUD ──────────────────────────────────────

  createAgent(input: {
    name: string;
    description?: string;
    system_prompt?: string;
    goal_template?: string;
    allowed_tools?: string[];
    denied_tools?: string[];
    provider?: string;
    model?: string;
    max_iterations?: number;
    timeout_ms?: number;
    flow_id?: string;
    max_tokens?: number;
    max_errors?: number;
    variables?: Record<string, string>;
    show_on_dashboard?: boolean;
    rank_id?: string;
    model_chain?: ModelChainEntry[];
    wake_on_inbox?: boolean;
    progressive_discovery?: boolean;
    skin_id?: string;
    builtin_handler?: string;
    /** 'manager' or 'worker'. Managers can spawn / update / delete other
     *  agents via the kernel_agents_create policy gate. Defaults to 'worker'. */
    role?: string;
  }): Agent {
    const now = isoNow();
    const agent: Agent = {
      id: newId(),
      name: input.name,
      description: input.description ?? "",
      system_prompt: input.system_prompt ?? "",
      goal_template: input.goal_template ?? "",
      allowed_tools: JSON.stringify(input.allowed_tools ?? []),
      denied_tools: JSON.stringify(input.denied_tools ?? []),
      provider: input.provider ?? "",
      model: input.model ?? "",
      max_iterations: input.max_iterations ?? 15,
      timeout_ms: input.timeout_ms ?? 300_000,
      active: 1,
      flow_id: input.flow_id ?? "",
      max_tokens: input.max_tokens ?? 150_000,
      max_errors: input.max_errors ?? 3,
      variables: JSON.stringify(input.variables ?? {}),
      show_on_dashboard: input.show_on_dashboard ? 1 : 0,
      builtin_handler: input.builtin_handler ?? "",
      rank_id: input.rank_id ?? "",
      model_chain: input.model_chain && input.model_chain.length > 0 ? JSON.stringify(input.model_chain) : "",
      wake_on_inbox: input.wake_on_inbox === false ? 0 : 1,
      progressive_discovery: input.progressive_discovery ? 1 : 0,
      skin_id: input.skin_id ?? "",
      created_at: now,
      updated_at: now,
    };

    const role = input.role === "manager" ? "manager" : "worker";
    this.db
      .prepare(
        `INSERT INTO agents (id, name, description, system_prompt, goal_template,
         allowed_tools, denied_tools, provider, model, max_iterations, timeout_ms,
         active, flow_id, max_tokens, max_errors, variables, show_on_dashboard, builtin_handler, rank_id, model_chain, wake_on_inbox, progressive_discovery, skin_id, role, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        agent.id, agent.name, agent.description, agent.system_prompt,
        agent.goal_template, agent.allowed_tools, agent.denied_tools,
        agent.provider, agent.model, agent.max_iterations, agent.timeout_ms,
        agent.active, agent.flow_id, agent.max_tokens, agent.max_errors,
        agent.variables, agent.show_on_dashboard, agent.builtin_handler, agent.rank_id, agent.model_chain, agent.wake_on_inbox, agent.progressive_discovery, agent.skin_id, role,
        agent.created_at, agent.updated_at,
      );

    // Seed version lineage — every agent starts at v1 marked 'initial'.
    this.writePromptVersion({
      agent_id: agent.id,
      version: 1,
      system_prompt: agent.system_prompt,
      goal_template: agent.goal_template,
      parent_version: 0,
      source: "initial",
      note: "created",
      active: 1,
      created_at: now,
    });

    this.events.emit("data.changed", { module: "agents", action: "agent_created" });
    return agent;
  }

  /** Raw db handle — used by the office-kit engine and in-module helpers
   *  that need statements the service doesn't wrap. */
  getDb(): SqliteDb {
    return this.db;
  }

  getAgent(id: string): Agent | undefined {
    return this.db
      .prepare("SELECT * FROM agents WHERE id = ?")
      .get(id) as Agent | undefined;
  }

  /** Look up an agent by its `slug` (unique). Returns undefined if not found. */
  getAgentBySlug(slug: string): Agent | undefined {
    if (!slug) return undefined;
    return this.db
      .prepare("SELECT * FROM agents WHERE slug = ?")
      .get(slug) as Agent | undefined;
  }

  /**
   * Installed skills, as the scorer wants them. Lives here rather than in the
   * route because the route has no business holding SQL, and the daily
   * suggester reads the same shape (skill-suggester.ts:186).
   */
  listInstalledSkillRows(): Array<{ slug: string; name: string; manifest_json: string }> {
    try {
      return this.db
        .prepare(
          `SELECT slug, name, manifest_json
             FROM installed_extensions
            WHERE type = 'skill' AND status = 'active'`,
        )
        .all() as Array<{ slug: string; name: string; manifest_json: string }>;
    } catch {
      return [];
    }
  }

  listAgents(filters?: { active?: boolean }): Agent[] {
    let sql = "SELECT * FROM agents WHERE 1=1";
    const params: unknown[] = [];

    if (filters?.active !== undefined) {
      sql += " AND active = ?";
      params.push(filters.active ? 1 : 0);
    }

    sql += " ORDER BY created_at DESC";
    return this.db.prepare(sql).all(...params) as Agent[];
  }

  updateAgent(
    id: string,
    input: Partial<{
      name: string;
      description: string;
      system_prompt: string;
      goal_template: string;
      allowed_tools: string[];
      denied_tools: string[];
      provider: string;
      model: string;
      max_iterations: number;
      timeout_ms: number;
      active: boolean;
      max_tokens: number;
      max_errors: number;
      variables: Record<string, string>;
      show_on_dashboard: boolean;
      builtin_handler: string;
      rank_id: string;
      model_chain: ModelChainEntry[];
      wake_on_inbox: boolean;
      progressive_discovery: boolean;
      skin_id: string;
      under_revision: boolean;
      /**
       * Engine for this agent: the kernel's own tool loop, or the CLI's.
       * Editable here as well as through POST /api/agents/:id/executor-type,
       * so a panel can send it in the same write as the chain it belongs with.
       */
      executor_type: "native" | "claude_code";
      /** Procedural skills (slugs from installed_extensions where type='skill'). */
      skills: string[];
    }>,
  ): Agent | undefined {
    const agent = this.getAgent(id);
    if (!agent) return undefined;

    const { sets, params } = buildPatch(
      // Only a known engine is written; anything else leaves the column alone.
      { ...input, executor_type: input.executor_type === "native" || input.executor_type === "claude_code" ? input.executor_type : undefined },
      AGENT_PATCH,
    );
    // Reactivating clears the breaker: the user un-pausing an agent is
    // telling us the underlying problem is handled, so it gets the full
    // failure budget again instead of tripping on its next stumble.
    if (input.active) {
      sets.push("consecutive_failures = 0", "auto_paused_at = ''", "auto_pause_reason = ''");
    }

    if (sets.length === 0) return agent;

    sets.push("updated_at = ?");
    params.push(isoNow());
    params.push(id);

    this.db.prepare(`UPDATE agents SET ${sets.join(", ")} WHERE id = ?`).run(...params);

    const promptChanged =
      (input.system_prompt !== undefined && input.system_prompt !== agent.system_prompt) ||
      (input.goal_template !== undefined && input.goal_template !== agent.goal_template);
    if (promptChanged) {
      const nextPrompt = input.system_prompt ?? agent.system_prompt;
      const nextGoal = input.goal_template ?? agent.goal_template;
      this.snapshotPrompt(id, {
        system_prompt: nextPrompt,
        goal_template: nextGoal,
        source: "manual",
        note: "updateAgent",
      });
    }

    this.events.emit("data.changed", { module: "agents", action: "agent_updated" });
    return this.getAgent(id);
  }

  deleteAgent(id: string): boolean {
    const agent = this.getAgent(id);
    if (!agent) return false;

    this.db.prepare("UPDATE agents SET active = 0, updated_at = ? WHERE id = ?").run(isoNow(), id);
    this.events.emit("data.changed", { module: "agents", action: "agent_deleted" });
    return true;
  }

  // ── Circuit breaker (auto-pause + top-agent alert) ───

  /**
   * Consecutive failures tolerated before auto-pausing. 0 disables the breaker.
   * Falls back to the default when no live config was injected (tests, demos).
   */
  private autoPauseThreshold(): number {
    const raw = this.config?.agents?.autoPauseThreshold;
    return typeof raw === "number" && Number.isFinite(raw) ? raw : DEFAULT_AUTO_PAUSE_THRESHOLD;
  }

  /**
   * Record how a run ended and trip the breaker when an agent keeps failing.
   *
   * Single entry point for every execution path — the scheduler's cron loop
   * (builtin and LLM) and the executor's builtin short-circuit — so a manual
   * "Run now" counts exactly like a scheduled one, and the counter survives
   * restarts (it lives in `agents`, not in memory).
   *
   * On the Nth consecutive failure the agent is paused (`active = 0`, which
   * `AgentScheduler.tick()` already skips), tagged with the reason, and the top
   * agent gets a message in its thread. Alerting happens ONLY on the transition
   * into the paused state — a dead upstream must not mail the commander every
   * 15 minutes forever.
   */
  recordRunOutcome(
    agentId: string,
    outcome: { ok: boolean; error?: string; run_id?: string },
  ): { paused: boolean; consecutive_failures: number } {
    const agent = this.getAgent(agentId);
    if (!agent) return { paused: false, consecutive_failures: 0 };

    if (outcome.ok) {
      // Only write when there is something to clear — a healthy agent should
      // not emit a data.changed on every single tick.
      const dirty = (agent.consecutive_failures ?? 0) > 0 || (agent.auto_paused_at ?? "") !== "";
      if (dirty) this.clearAutoPause(agentId);
      return { paused: false, consecutive_failures: 0 };
    }

    const fails = (agent.consecutive_failures ?? 0) + 1;
    const reason = (outcome.error ?? "").trim().slice(0, 500) || "run failed without an error message";
    const threshold = this.autoPauseThreshold();
    const shouldPause = threshold > 0 && fails >= threshold && agent.active === 1;

    if (!shouldPause) {
      this.db
        .prepare("UPDATE agents SET consecutive_failures = ?, updated_at = ? WHERE id = ?")
        .run(fails, isoNow(), agentId);
      log.warn(
        `Agent "${agent.name}": failure ${fails}/${threshold > 0 ? threshold : "∞"} — ${reason.slice(0, 120)}`,
      );
      return { paused: false, consecutive_failures: fails };
    }

    const now = isoNow();
    this.db
      .prepare(
        `UPDATE agents
            SET consecutive_failures = ?, active = 0, auto_paused_at = ?,
                auto_pause_reason = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(fails, now, reason, now, agentId);

    log.error(`Agent "${agent.name}" auto-paused after ${fails} consecutive failures: ${reason.slice(0, 200)}`);

    this.events.emit("agent:auto_paused", {
      agent_id: agent.id,
      agent_name: agent.name,
      builtin_handler: agent.builtin_handler,
      consecutive_failures: fails,
      reason,
      run_id: outcome.run_id ?? "",
      paused_at: now,
    });
    this.events.emit("data.changed", { module: "agents", action: "agent_auto_paused" });

    this.alertTopAgentAutoPaused(agent, { fails, reason, run_id: outcome.run_id ?? "" });

    return { paused: true, consecutive_failures: fails };
  }

  /**
   * Clear the breaker state. Called on any successful run and whenever the
   * agent is reactivated, so an agent the user un-pauses starts from a clean
   * slate instead of tripping again on its very next failure.
   */
  clearAutoPause(agentId: string): void {
    this.db
      .prepare(
        `UPDATE agents
            SET consecutive_failures = 0, auto_paused_at = '', auto_pause_reason = '', updated_at = ?
          WHERE id = ?`,
      )
      .run(isoNow(), agentId);
    this.events.emit("data.changed", { module: "agents", action: "agent_auto_pause_cleared" });
  }

  /**
   * Drop a message in the top agent's thread about an auto-pause.
   *
   * Best-effort by construction: a missing commander, a broken conversation
   * row, anything — is logged and swallowed. Failing to deliver an alert must
   * never turn into a second failure on top of the one being reported.
   */
  private alertTopAgentAutoPaused(
    agent: Agent,
    ctx: { fails: number; reason: string; run_id: string },
  ): void {
    try {
      const chief = this.getTopAgent();
      if (!chief) {
        log.warn(`Auto-pause of "${agent.name}" not reported: no top agent (no ranked active agent found)`);
        return;
      }
      if (chief.id === agent.id) return; // the commander doesn't mail himself

      const convo = this.findOrCreateChatConversation({
        topic: AUTO_PAUSE_ALERT_TOPIC,
        participants: [agent.id, chief.id],
        initiator_agent_id: agent.id,
      });

      const handlerLine = agent.builtin_handler
        ? `Handler: \`${agent.builtin_handler}\``
        : `Executor: ${agent.executor_type ?? "native"}`;
      const body = [
        `**Auto-paused** — "${agent.name}" stopped after ${ctx.fails} consecutive failures.`,
        "",
        handlerLine,
        `Last error: ${ctx.reason}`,
        "",
        "The schedule is untouched: reactivate the agent and it resumes on its next cron slot.",
      ].join("\n");

      this.postMessage({
        conversation_id: convo.id,
        from_agent_id: agent.id,
        to_agent_id: chief.id,
        role: "stmt",
        body,
        run_id: ctx.run_id,
        meta: {
          kind: "auto_pause",
          agent_id: agent.id,
          builtin_handler: agent.builtin_handler,
          consecutive_failures: ctx.fails,
          reason: ctx.reason,
        },
      });
    } catch (err) {
      log.warn(
        `Auto-pause alert for "${agent.name}" could not be delivered: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── Runs & steps → AgentRunsService ─────────────────

  updateRun(
    id: string,
    updates: Partial<{
      status: AgentRun["status"];
      result: string;
      error: string;
      steps_count: number;
      tokens_used: number;
      started_at: string;
      completed_at: string;
    }>,
  ): void {
    this.runs.updateRun(id, updates);
  }

  // ── Steps → AgentRunsService ────────────────────────

  getAdHocConnections(agentId: string): {
    invokedBy: Array<{ agent_id: string; agent_name: string; count: number; last_at: string }>;
    invoked: Array<{ agent_id: string; agent_name: string; count: number; last_at: string }>;
  } {
    return this.runs.getAdHocConnections(agentId);
  }


  // ── Event triggers → AgentTriggersService ───────────

  // ── Schedules → AgentSchedulesService ───────────────

  // NOTE: `deactivateSchedule()` lived here for the old in-memory circuit
  // breaker, its only caller. The breaker now pauses the AGENT
  // (`recordRunOutcome`) and deliberately leaves the schedule row alone, so
  // reactivating an agent resumes it without having to repair its cron too.

  // ── Feedback & stats → AgentFeedbackService ───────

  getAgentStats(agentId: string): {
    total_runs: number;
    completed: number;
    failed: number;
    avg_rating: number | null;
    avg_tokens: number;
    avg_steps: number;
    success_rate: number;
    top_tools: Array<{ tool: string; count: number }>;
    common_errors: string[];
  } {
    return this.feedback.getAgentStats(agentId);
  }


  // ── Learnings → AgentMemoryService ────────────────

  // ── Conversational memory → AgentMemoryService ────


  // ── Office inbox (async colleague-to-colleague mail within a flow) ────

  /**
   * Post a message to a colleague's office inbox. Cross-office is allowed —
   * every agent in the fleet can message every other agent. The delivery
   * mechanism (PENDING REQUESTS block injected into the recipient's next run)
   * is identical in both cases.
   *
   * Side effects: also records the message as a turn in an agent_conversations
   * thread (kind='chat') so the debate orchestrator and dashboard can observe
   * a unified conversation stream. The inbox row is kept for the legacy
   * "mark read on delivery" flow used by the executor.
   */
  /** One office message, whole — the 3D's coordination card shows it. */
  getInboxMessage(id: string): AgentOfficeInboxMessage | null {
    return (this.db.prepare("SELECT * FROM agent_office_inbox WHERE id = ?").get(id) as AgentOfficeInboxMessage | undefined) ?? null;
  }

  postToColleague(input: {
    from_agent_id: string;
    to_agent_id: string;
    subject: string;
    body: string;
    related_run_id?: string;
    role?: AgentMessageRole;
    in_reply_to_message_id?: string;
    conversation_id?: string;
    /** Project the letter is about (src/modules/projects). null = none. */
    project_id?: string | null;
  }): { message: AgentOfficeInboxMessage | null; conversation_message?: AgentMessage; conversation?: AgentConversation; error?: string } {
    const from = this.getAgent(input.from_agent_id);
    const to = this.getAgent(input.to_agent_id);
    if (!from) return { message: null, error: `Sender agent not found: ${input.from_agent_id}` };
    if (!to) return { message: null, error: `Recipient agent not found: ${input.to_agent_id}` };
    if (from.id === to.id) return { message: null, error: "Cannot post a message to yourself" };

    // flow_id on the inbox row is kept for legacy indexing. For cross-office
    // messages we store the sender's flow so the sender's office dashboard
    // can still list its outbound traffic; the recipient's delivery does not
    // depend on this column (getUnreadInbox filters by to_agent_id only).
    const inboxFlowId = from.flow_id || to.flow_id || "";

    const msg: AgentOfficeInboxMessage = {
      id: newId(),
      flow_id: inboxFlowId,
      from_agent_id: from.id,
      to_agent_id: to.id,
      subject: input.subject.slice(0, 300),
      body: input.body,
      status: "unread",
      related_run_id: input.related_run_id ?? "",
      created_at: isoNow(),
      read_at: null,
      project_id: input.project_id ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO agent_office_inbox
          (id, flow_id, from_agent_id, to_agent_id, subject, body, status, related_run_id, created_at, read_at, project_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        msg.id, msg.flow_id, msg.from_agent_id, msg.to_agent_id,
        msg.subject, msg.body, msg.status, msg.related_run_id,
        msg.created_at, msg.read_at, msg.project_id,
      );

    // Mirror the message into a chat conversation. If the caller supplied a
    // conversation_id or an in_reply_to_message_id, reuse/derive; otherwise
    // find-or-create a chat by (participants, topic_hash).
    let conversation: AgentConversation | undefined;
    let convoMsg: AgentMessage | undefined;
    try {
      if (input.conversation_id) {
        conversation = this.getConversation(input.conversation_id);
      } else if (input.in_reply_to_message_id) {
        const parent = this.getMessage(input.in_reply_to_message_id);
        if (parent) conversation = this.getConversation(parent.conversation_id);
      }
      if (!conversation) {
        conversation = this.findOrCreateChatConversation({
          topic: input.subject,
          participants: [from.id, to.id],
          initiator_agent_id: from.id,
        });
      } else if (!this.parseParticipants(conversation).includes(to.id)) {
        this.addParticipant(conversation.id, to.id);
        conversation = this.getConversation(conversation.id) ?? conversation;
      }

      convoMsg = this.postMessage({
        conversation_id: conversation.id,
        from_agent_id: from.id,
        to_agent_id: to.id,
        role: input.role ?? "stmt",
        in_reply_to: input.in_reply_to_message_id ?? "",
        body: input.body,
        run_id: input.related_run_id ?? "",
        meta: { inbox_message_id: msg.id, subject: input.subject.slice(0, 300) },
      });
    } catch (err) {
      log.warn(`postToColleague: conversation mirror failed: ${String(err)}`);
    }

    this.events.emit("data.changed", { module: "agents", action: "inbox_posted" });
    this.events.emit("agent:inbox:posted", {
      message_id: msg.id,
      flow_id: msg.flow_id,
      from_agent_id: msg.from_agent_id,
      to_agent_id: msg.to_agent_id,
      subject: msg.subject,
      conversation_id: conversation?.id,
      conversation_message_id: convoMsg?.id,
      cross_office: !!(from.flow_id && to.flow_id && from.flow_id !== to.flow_id),
      project_id: msg.project_id,
    });
    return { message: msg, conversation_message: convoMsg, conversation };
  }

  /** Return unread inbox messages for an agent, oldest first; with `sinceIso`,
   *  only letters created at or after that instant. `projectId`: undefined →
   *  every letter (UI, waker); null → only letters without a project; a
   *  project → letters without one plus that project's. */
  getUnreadInbox(agentId: string, limit = 20, sinceIso = "", projectId?: string | null): AgentOfficeInboxMessage[] {
    const scope = projectId === undefined ? ""
      : projectId === null ? " AND project_id IS NULL"
      : " AND (project_id IS NULL OR project_id = ?)";
    const params: unknown[] = [agentId, sinceIso, ...(typeof projectId === "string" ? [projectId] : []), limit];
    return this.db
      .prepare(
        `SELECT * FROM agent_office_inbox
         WHERE to_agent_id = ? AND status = 'unread' AND created_at >= ?${scope}
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(...params) as AgentOfficeInboxMessage[];
  }

  /** Mark inbox messages as read. No-op if the list is empty. */
  markInboxRead(messageIds: string[]): void {
    if (messageIds.length === 0) return;
    const placeholders = messageIds.map(() => "?").join(",");
    this.db
      .prepare(
        `UPDATE agent_office_inbox
         SET status = 'read', read_at = ?
         WHERE id IN (${placeholders}) AND status = 'unread'`,
      )
      .run(isoNow(), ...messageIds);
  }

  /** Mark read exactly those of `messageIds` that are unread letters addressed
   *  to `agentId`. Returns how many were acknowledged. */
  ackInboxFor(agentId: string, messageIds: string[]): number {
    if (!agentId || messageIds.length === 0) return 0;
    const placeholders = messageIds.map(() => "?").join(",");
    const res = this.db
      .prepare(
        `UPDATE agent_office_inbox
         SET status = 'read', read_at = ?
         WHERE id IN (${placeholders}) AND to_agent_id = ? AND status = 'unread'`,
      )
      .run(isoNow(), ...messageIds, agentId);
    return Number(res.changes ?? 0);
  }

  /** Agents (active, wake_on_inbox, no builtin handler) holding unread letters
   *  created before `olderThanIso` and — when given — at or after `newerThanIso`.
   *  Builtin-handler agents never run an LLM, so they can never ack a letter. */
  listAgentsWithUnackedInbox(olderThanIso: string, newerThanIso = ""): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT i.to_agent_id AS id
         FROM agent_office_inbox i JOIN agents a ON a.id = i.to_agent_id
         WHERE i.status = 'unread' AND i.created_at < ? AND i.created_at >= ?
           AND a.active = 1 AND COALESCE(a.wake_on_inbox, 1) = 1
           AND COALESCE(a.builtin_handler, '') = ''`,
      )
      .all(olderThanIso, newerThanIso) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  /** Count one more wake attempt on exactly these unread letters (the ones actually
   *  surfaced in the wake goal — not every unread letter the agent holds). */
  bumpInboxWakeAttempts(messageIds: string[]): void {
    if (messageIds.length === 0) return;
    const ph = messageIds.map(() => "?").join(",");
    this.db
      .prepare(
        `UPDATE agent_office_inbox SET wake_attempts = wake_attempts + 1
         WHERE id IN (${ph}) AND status = 'unread'`,
      )
      .run(...messageIds);
  }

  /** Archive (unread → archived, read_at stays NULL) letters that exhausted their wakes.
   *  Skips letters whose recipient agent has a run still 'running' or 'pending' — that
   *  run is the one processing the exhausting wake, so its letters must survive until
   *  it finishes (or fails) rather than being archived out from under it mid-run. */
  archiveExhaustedInbox(maxAttempts: number): AgentOfficeInboxMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_office_inbox
         WHERE status = 'unread' AND wake_attempts >= ?
           AND to_agent_id NOT IN (
             SELECT agent_id FROM agent_runs WHERE status IN ('running', 'pending')
           )`,
      )
      .all(maxAttempts) as AgentOfficeInboxMessage[];
    if (rows.length === 0) return rows;
    const ph = rows.map(() => "?").join(",");
    this.db
      .prepare(`UPDATE agent_office_inbox SET status = 'archived' WHERE id IN (${ph})`)
      .run(...rows.map((r) => r.id));
    return rows;
  }

  /** Full inbox listing for dashboard/debug views. */
  // ── Escalated questions (human-in-the-loop, via the chief's triage) ────
  // An agent stuck on an open question escalates via kernel_agents_ask_supervisor.
  // The chief triages everyone else's questions first (status 'triage') and
  // either answers them itself or escalates to the human (status 'pending'),
  // who picks an option from the My Office panel. The chief's own questions —
  // and anyone's when there is no active chief — go straight to 'pending'.
  createQuestion(input: {
    from_agent_id: string;
    flow_id?: string;
    meeting_id?: string;
    run_id?: string;
    question: string;
    context?: string;
    options: Array<{ label: string; value?: string; url?: string }>;
    /** Skip the chief: the question goes straight to the human. */
    direct_to_human?: boolean;
  }): { id: string; status: "triage" | "pending" } {
    const id = newId();
    const askedAt = isoNow();
    // The chief triages everyone else's questions; its own (or any question
    // when there is no active chief, or one the caller addresses to the human
    // explicitly) goes straight to the human.
    const chief = input.direct_to_human ? undefined : this.getTopAgent();
    const status: "triage" | "pending" = chief && chief.id !== input.from_agent_id ? "triage" : "pending";
    this.db
      .prepare(
        `INSERT INTO agent_questions
          (id, from_agent_id, flow_id, meeting_id, run_id, question, context, options, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, input.from_agent_id, input.flow_id ?? "", input.meeting_id ?? "", input.run_id ?? "",
        input.question, input.context ?? "", JSON.stringify(input.options), status, askedAt,
      );
    this.events.emit("data.changed", { module: "agents", action: "question_asked" });
    if (status === "pending") this.emitQuestionForHuman(id);
    else this.events.emit("agent:question_triage", { question_id: id, agent_id: input.from_agent_id });
    return { id, status };
  }

  /** Ring the operator's bell and send the asker's walker to My Office. Only
   *  for questions addressed to the human (status 'pending'): agent-to-chief
   *  traffic would drown both. */
  private emitQuestionForHuman(id: string): void {
    const q = this.getQuestion(id);
    if (!q) return;
    const agentName = this.getAgent(q.from_agent_id)?.name ?? "An agent";
    const options = q.options.map((o) => o.label);
    this.events.emit("agent:question_asked", {
      question_id: q.id,
      agent_id: q.from_agent_id,
      agent_name: agentName,
      question: q.question,
      context: q.context,
      options,
      run_id: q.run_id,
      asked_at: q.created_at,
    });
    this.events.emit("agent:flow:question_asked", {
      question_id: q.id,
      from_agent_id: q.from_agent_id,
      from_agent_name: agentName,
      flow_id: q.flow_id,
      question: q.question,
      options,
      ts: isoNow(),
    });
  }

  private mapQuestionRow(r: Record<string, unknown>): AgentQuestion {
    return {
      id: String(r.id),
      from_agent_id: String(r.from_agent_id),
      flow_id: String(r.flow_id ?? ""),
      meeting_id: String(r.meeting_id ?? ""),
      run_id: String(r.run_id ?? ""),
      question: String(r.question ?? ""),
      context: String(r.context ?? ""),
      options: (() => {
        try { return JSON.parse(String(r.options || "[]")); } catch { return []; }
      })(),
      status: String(r.status ?? "pending") as QuestionStatus,
      selected_option: String(r.selected_option ?? ""),
      selected_index: Number(r.selected_index ?? -1),
      answered_note: String(r.answered_note ?? ""),
      answered_at: r.answered_at == null ? null : String(r.answered_at),
      answered_by: String(r.answered_by ?? "") as AgentQuestion["answered_by"],
      chief_note: String(r.chief_note ?? ""),
      triage_started_at: r.triage_started_at == null ? null : String(r.triage_started_at),
      created_at: String(r.created_at ?? ""),
    };
  }

  getQuestion(id: string): AgentQuestion | undefined {
    const r = this.db.prepare("SELECT * FROM agent_questions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? this.mapQuestionRow(r) : undefined;
  }

  // ── Chief's office: dismissed reports ─────────────────────────────
  /** Record runs the operator dismissed from the office. Returns how many were new. */
  dismissOfficeRuns(runIds: string[]): number {
    const now = new Date().toISOString();
    const ins = this.db.prepare("INSERT OR IGNORE INTO agent_office_dismissed (run_id, dismissed_at) VALUES (?, ?)");
    let added = 0;
    this.db.transaction(() => {
      for (const id of runIds) if (id) added += ins.run(id, now).changes;
    })();
    return added;
  }

  /** Bring dismissed runs back into the office. Returns how many were removed. */
  restoreOfficeRuns(runIds: string[]): number {
    const del = this.db.prepare("DELETE FROM agent_office_dismissed WHERE run_id = ?");
    let removed = 0;
    this.db.transaction(() => {
      for (const id of runIds) if (id) removed += del.run(id).changes;
    })();
    return removed;
  }

  listOfficeDismissed(): string[] {
    return (this.db.prepare("SELECT run_id FROM agent_office_dismissed ORDER BY dismissed_at").all() as Array<{ run_id: string }>)
      .map((r) => r.run_id);
  }

  listQuestions(opts?: { status?: QuestionStatus; answered_by?: "chief" | "human"; limit?: number }): AgentQuestion[] {
    let sql = "SELECT * FROM agent_questions WHERE 1=1";
    const params: unknown[] = [];
    if (opts?.status) { sql += " AND status = ?"; params.push(opts.status); }
    if (opts?.answered_by) { sql += " AND answered_by = ?"; params.push(opts.answered_by); }
    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(opts?.limit ?? 50);
    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapQuestionRow(r));
  }

  /** Record an answer. The chief answers questions in triage, the human the
   *  pending ones. Getting the answer to the asker is `answerAndDeliver`'s job. */
  answerQuestion(
    id: string,
    input: { selected_index: number; selected_option: string; note?: string; answered_by: "chief" | "human" },
  ): { from_agent_id: string; question: string } | null {
    const expected = input.answered_by === "chief" ? "triage" : "pending";
    const q = this.getQuestion(id);
    if (!q || q.status !== expected) return null;
    this.db
      .prepare(
        `UPDATE agent_questions
         SET status='answered', selected_option=?, selected_index=?, answered_note=?, answered_at=?, answered_by=?
         WHERE id=? AND status=?`,
      )
      .run(input.selected_option, input.selected_index, input.note ?? "", isoNow(), input.answered_by, id, expected);
    this.events.emit("data.changed", { module: "agents", action: "question_answered" });
    return { from_agent_id: q.from_agent_id, question: q.question };
  }

  /** Leave an answered question's answer in the asker's inbox, for when it
   *  cannot be relaunched right away. The sender is the headquarters. */
  postAnswerToInbox(id: string): boolean {
    const q = this.getQuestion(id);
    if (!q || q.status !== "answered") return false;
    const asker = this.getAgent(q.from_agent_id);
    if (!asker) return false;
    const who = q.answered_by === "chief" ? "The chief" : "Your supervisor";
    this.db
      .prepare(
        `INSERT INTO agent_office_inbox
          (id, flow_id, from_agent_id, to_agent_id, subject, body, status, related_run_id, created_at, read_at)
         VALUES (?, ?, '__top_agent__', ?, ?, ?, 'unread', '', ?, NULL)`,
      )
      .run(
        newId(),
        asker.flow_id ?? "",
        q.from_agent_id,
        `ANSWER: ${q.question.slice(0, 160)}`,
        `${who} answered your question.\n\n**Question:** ${q.question}\n\n**Answer:** ${q.selected_option}` +
          (q.answered_note && q.answered_note !== q.selected_option ? `\n\n**Note:** ${q.answered_note}` : ""),
        isoNow(),
      );
    return true;
  }

  /** Chief hands a question to the human. */
  escalateQuestion(id: string, reason: string): boolean {
    const r = this.db
      .prepare("UPDATE agent_questions SET status='pending', chief_note=? WHERE id=? AND status='triage'")
      .run(reason, id);
    if (r.changes === 0) return false;
    this.events.emit("data.changed", { module: "agents", action: "question_escalated" });
    this.emitQuestionForHuman(id);
    return true;
  }

  markTriageStarted(ids: string[]): void {
    if (ids.length === 0) return;
    const ph = ids.map(() => "?").join(",");
    this.db.prepare(`UPDATE agent_questions SET triage_started_at=? WHERE status='triage' AND id IN (${ph})`).run(isoNow(), ...ids);
  }

  /** Questions stuck in triage since before `olderThanIso` go to the human. */
  expireTriage(olderThanIso: string): number {
    const rows = this.db
      .prepare("SELECT id FROM agent_questions WHERE status='triage' AND created_at < ?")
      .all(olderThanIso) as Array<{ id: string }>;
    let n = 0;
    for (const { id } of rows) {
      if (this.escalateQuestion(id, "auto-escalated: the chief did not triage this question in time")) n++;
    }
    return n;
  }

  hasRunningRun(agentId: string): boolean {
    return this.listRuns({ agent_id: agentId, status: "running", limit: 1 }).length > 0;
  }

  dismissQuestion(id: string): boolean {
    const r = this.db.prepare("UPDATE agent_questions SET status='dismissed' WHERE id=? AND status='pending'").run(id);
    if (r.changes > 0) this.events.emit("data.changed", { module: "agents", action: "question_dismissed" });
    return r.changes > 0;
  }

  listInbox(
    agentId: string,
    opts?: {
      status?: "unread" | "read" | "archived";
      limit?: number;
      /** Same scoping as getUnreadInbox: undefined = all, null = no project, id = none + that project. */
      projectId?: string | null;
    },
  ): AgentOfficeInboxMessage[] {
    let sql = "SELECT * FROM agent_office_inbox WHERE to_agent_id = ?";
    const params: unknown[] = [agentId];
    if (opts?.status) {
      sql += " AND status = ?";
      params.push(opts.status);
    }
    if (opts?.projectId === null) {
      sql += " AND project_id IS NULL";
    } else if (typeof opts?.projectId === "string") {
      sql += " AND (project_id IS NULL OR project_id = ?)";
      params.push(opts.projectId);
    }
    sql += " ORDER BY created_at DESC";
    if (opts?.limit) {
      sql += " LIMIT ?";
      params.push(opts.limit);
    }
    return this.db.prepare(sql).all(...params) as AgentOfficeInboxMessage[];
  }

  /** Find an agent by exact name within a specific flow. Used to resolve
   *  `to_agent_name` into a UUID when posting to the office inbox. */
  findAgentByNameInFlow(flowId: string, name: string): Agent | undefined {
    return this.db
      .prepare("SELECT * FROM agents WHERE flow_id = ? AND name = ? LIMIT 1")
      .get(flowId, name) as Agent | undefined;
  }

  // ── Relevance ranking → AgentMemoryService ────────


  // ── Conversations & messages → AgentConversationsService ────────────

  /** @see AgentConversationsService.computeTopicHash */
  static computeTopicHash(topic: string): string {
    return AgentConversationsService.computeTopicHash(topic);
  }

  getCounterStats(conversationId: string): {
    distinct_senders: string[];
    counters: AgentMessage[];
  } {
    return this.conversations.getCounterStats(conversationId);
  }

  // ── Debate cooldown register → AgentConversationsService ──


  // ── Chains → AgentChainsService ─────────────────

  // ── Event log → AgentEventLogService ──────────────

  // ── Dashboard Widgets ────────────────────────────

  /** Get agents flagged for dashboard display + their last completed run result */
  getFlowWidgets(): Array<{
    agent_id: string;
    agent_name: string;
    description: string;
    flow_id: string;
    result: string;
    completed_at: string | null;
    status: string;
    tokens_used: number;
  }> {
    return this.db
      .prepare(
        `SELECT a.id AS agent_id, a.name AS agent_name, a.description, a.flow_id,
                COALESCE(r.result, '') AS result,
                r.completed_at, COALESCE(r.status, '') AS status,
                COALESCE(r.tokens_used, 0) AS tokens_used
         FROM agents a
         LEFT JOIN agent_runs r ON r.id = (
           SELECT id FROM agent_runs
           WHERE agent_id = a.id AND status = 'completed'
           ORDER BY completed_at DESC LIMIT 1
         )
         WHERE a.show_on_dashboard = 1 AND a.active = 1
         ORDER BY a.name`,
      )
      .all() as Array<{
      agent_id: string;
      agent_name: string;
      description: string;
      flow_id: string;
      result: string;
      completed_at: string | null;
      status: string;
      tokens_used: number;
    }>;
  }

  /** Full graph data for visualization */
  getAgentGraph(flowId?: string): {
    agents: Agent[];
    chains: AgentChain[];
    triggers: EventTrigger[];
    schedules: AgentSchedule[];
    recentRuns: AgentRun[];
    stats: Record<string, { total_runs: number; completed: number; failed: number; success_rate: number }>;
    flows: AgentFlow[];
    ranks: AgentRank[];
  } {
    // Include inactive agents so the 3D can render pending-approval ones
    // dimmed instead of hiding them entirely. The frontend differentiates
    // by reading `a.active` per agent.
    let agents = this.listAgents();
    if (flowId) {
      agents = agents.filter(a => a.flow_id === flowId);
    }
    const knownIds = new Set(agents.map(a => a.id));
    const chains = this.listChains().filter(
      c => knownIds.has(c.source_agent_id) && knownIds.has(c.target_agent_id),
    );
    const triggers = this.db
      .prepare("SELECT * FROM agent_event_triggers WHERE active = 1 ORDER BY created_at DESC")
      .all() as EventTrigger[];
    const schedules = this.db
      .prepare("SELECT * FROM agent_schedules WHERE active = 1 ORDER BY created_at DESC")
      .all() as AgentSchedule[];
    const recentRuns = this.db
      .prepare("SELECT * FROM agent_runs ORDER BY created_at DESC LIMIT 50")
      .all() as AgentRun[];

    const stats: Record<string, { total_runs: number; completed: number; failed: number; success_rate: number }> = {};
    for (const agent of agents) {
      const rows = this.db
        .prepare("SELECT status FROM agent_runs WHERE agent_id = ?")
        .all(agent.id) as Array<{ status: string }>;
      const completed = rows.filter(r => r.status === "completed").length;
      const failed = rows.filter(r => r.status === "failed").length;
      stats[agent.id] = {
        total_runs: rows.length,
        completed,
        failed,
        success_rate: rows.length > 0 ? Math.round((completed / rows.length) * 100) : 0,
      };
    }

    const flows = this.listFlows();
    const ranks = this.listRanks();
    return { agents, chains, triggers, schedules, recentRuns, stats, flows, ranks };
  }

  // ── Prompt version lineage (Autogenesis RSPL) ──────────

  /** Agent creation writes the first lineage row directly. */
  private writePromptVersion(v: Omit<AgentPromptVersion, "id"> & { id?: string }): AgentPromptVersion {
    return this.promptVersions.writePromptVersion(v);
  }

  snapshotPrompt(
    agentId: string,
    input: {
      system_prompt: string;
      goal_template: string;
      source: AgentPromptVersion["source"];
      note?: string;
      parent_version?: number;
      activate?: boolean;
    },
  ): AgentPromptVersion | null {
    return this.promptVersions.snapshotPrompt(agentId, input);
  }

  // ── Evolution runs (Autogenesis SEPL) → AgentEvolutionService ──

  // ── Conversation subscriptions → AgentSubscriptionsService ───────────────

}
