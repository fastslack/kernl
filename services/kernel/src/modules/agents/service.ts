import type { SqliteDb } from "../../core/db/sqlite.js";
import type { EventBus } from "../../core/event-bus.js";
import type { EmbeddingsClient } from "../../core/embeddings/client.js";
import type { KernelConfig } from "../../core/config.js";
import { newId, isoNow } from "../../core/helpers.js";
import { log } from "../../core/logger.js";
import type {
  Agent,
  AgentFlow,
  AgentRank,
  AgentRun,
  AgentStep,
  EventTrigger,
  AgentSchedule,
  AgentFeedback,
  AgentLearning,
  AgentChain,
  AgentOfficeInboxMessage,
  AgentPromptVersion,
  AgentEvolutionRun,
  ModelChainEntry,
  AgentConversation,
  AgentConversationSubscription,
  AgentMessage,
  AgentMessageRole,
  AgentDebateCooldown,
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

/** Fallback for `config.agents.autoPauseThreshold` when no config is injected. */
const DEFAULT_AUTO_PAUSE_THRESHOLD = 3;

/** Stable topic so every auto-pause alert for the same pair lands in one thread. */
const AUTO_PAUSE_ALERT_TOPIC = "Agent auto-pause alerts";

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
    );
    this.feedback = new AgentFeedbackService(
      db,
      events,
      (id) => this.getRun(id),
      (agentId, runCreatedAt, outcome) =>
        this.reinforceLearningsForRun(agentId, runCreatedAt, outcome),
    );
  }

  /** Inject the embeddings client. Idempotent — last writer wins. */
  setEmbeddingsClient(client: EmbeddingsClient | null): void {
    this.memory.setEmbeddingsClient(client);
  }

  getEmbeddingsClient(): EmbeddingsClient | null {
    return this.memory.getEmbeddingsClient();
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

  createFlow(input: { name: string; description?: string; color?: string }): AgentFlow {
    return this.flows.createFlow(input);
  }

  /** Public entrypoint for the backfill script. Returns the workspace id or null. */
  ensureOfficeHome(flowId: string): string | null {
    return this.flows.ensureOfficeHome(flowId);
  }

  resolveFlowHome(flowId: string): { path: string; kind: "git" | "workspace"; flow: AgentFlow } | null {
    return this.flows.resolveFlowHome(flowId);
  }

  setFlowRepo(flowId: string, repoPath: string): AgentFlow | undefined {
    return this.flows.setFlowRepo(flowId, repoPath);
  }

  listFlows(): AgentFlow[] {
    return this.flows.listFlows();
  }

  getFlow(id: string): AgentFlow | undefined {
    return this.flows.getFlow(id);
  }

  updateFlow(id: string, updates: Partial<Pick<AgentFlow, "name" | "description" | "color">>): AgentFlow | undefined {
    return this.flows.updateFlow(id, updates);
  }

  deleteFlow(id: string): boolean {
    return this.flows.deleteFlow(id);
  }

  assignAgentToFlow(agentId: string, flowId: string): boolean {
    return this.flows.assignAgentToFlow(agentId, flowId);
  }


  // ── Ranks → AgentRanksService ───────────────────────

  createRank(input: {
    name: string;
    level: number;
    insignia?: string;
    color?: string;
    description?: string;
  }): AgentRank {
    return this.ranks.createRank(input);
  }

  listRanks(): AgentRank[] {
    return this.ranks.listRanks();
  }

  getRank(id: string): AgentRank | undefined {
    return this.ranks.getRank(id);
  }

  getTopAgent(): Agent | undefined {
    return this.ranks.getTopAgent();
  }

  updateRank(
    id: string,
    updates: Partial<Pick<AgentRank, "name" | "level" | "insignia" | "color" | "description">>,
  ): AgentRank | undefined {
    return this.ranks.updateRank(id, updates);
  }

  deleteRank(id: string): boolean {
    return this.ranks.deleteRank(id);
  }

  assignRankToAgent(agentId: string, rankId: string): boolean {
    return this.ranks.assignRankToAgent(agentId, rankId);
  }


  // ── Model fallback chain ────────────────────────────

  /**
   * Resolve an agent's effective model chain for LLM invocation.
   * If `model_chain` is populated, returns that list (validated/filtered).
   * Otherwise returns a 1-entry fallback list from `(provider, model)`.
   * Entries with blank provider AND blank model are filtered out.
   */
  resolveModelChain(agent: Agent): ModelChainEntry[] {
    if (agent.model_chain) {
      try {
        const parsed = JSON.parse(agent.model_chain) as unknown;
        if (Array.isArray(parsed)) {
          const chain: ModelChainEntry[] = [];
          for (const raw of parsed) {
            if (!raw || typeof raw !== "object") continue;
            const p = String((raw as Record<string, unknown>).provider ?? "");
            const m = String((raw as Record<string, unknown>).model ?? "");
            if (p || m) chain.push({ provider: p, model: m });
          }
          if (chain.length > 0) return chain;
        }
      } catch { /* fall through to single */ }
    }
    return [{ provider: agent.provider, model: agent.model }];
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
    lines.push("- `kernel_agents_post_to_colleague({ to_agent_id, subject, body })` — async, non-blocking. They read it on their next run and reply through their own outbox. Use for clarifications, escalations, and back-and-forth threads. Works ACROSS offices.");
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

    const sets: string[] = [];
    const params: unknown[] = [];

    if (input.name !== undefined) { sets.push("name = ?"); params.push(input.name); }
    if (input.description !== undefined) { sets.push("description = ?"); params.push(input.description); }
    if (input.system_prompt !== undefined) { sets.push("system_prompt = ?"); params.push(input.system_prompt); }
    if (input.goal_template !== undefined) { sets.push("goal_template = ?"); params.push(input.goal_template); }
    if (input.allowed_tools !== undefined) { sets.push("allowed_tools = ?"); params.push(JSON.stringify(input.allowed_tools)); }
    if (input.denied_tools !== undefined) { sets.push("denied_tools = ?"); params.push(JSON.stringify(input.denied_tools)); }
    if (input.provider !== undefined) { sets.push("provider = ?"); params.push(input.provider); }
    if (input.model !== undefined) { sets.push("model = ?"); params.push(input.model); }
    if (input.max_iterations !== undefined) { sets.push("max_iterations = ?"); params.push(input.max_iterations); }
    if (input.timeout_ms !== undefined) { sets.push("timeout_ms = ?"); params.push(input.timeout_ms); }
    if (input.active !== undefined) {
      sets.push("active = ?");
      params.push(input.active ? 1 : 0);
      // Reactivating clears the breaker: the user un-pausing an agent is
      // telling us the underlying problem is handled, so it gets the full
      // failure budget again instead of tripping on its next stumble.
      if (input.active) {
        sets.push("consecutive_failures = 0", "auto_paused_at = ''", "auto_pause_reason = ''");
      }
    }
    if (input.max_tokens !== undefined) { sets.push("max_tokens = ?"); params.push(input.max_tokens); }
    if (input.max_errors !== undefined) { sets.push("max_errors = ?"); params.push(input.max_errors); }
    if (input.variables !== undefined) { sets.push("variables = ?"); params.push(JSON.stringify(input.variables)); }
    if (input.show_on_dashboard !== undefined) { sets.push("show_on_dashboard = ?"); params.push(input.show_on_dashboard ? 1 : 0); }
    if (input.builtin_handler !== undefined) { sets.push("builtin_handler = ?"); params.push(input.builtin_handler); }
    if (input.rank_id !== undefined) { sets.push("rank_id = ?"); params.push(input.rank_id); }
    if (input.model_chain !== undefined) {
      sets.push("model_chain = ?");
      params.push(input.model_chain.length > 0 ? JSON.stringify(input.model_chain) : "");
    }
    if (input.wake_on_inbox !== undefined) { sets.push("wake_on_inbox = ?"); params.push(input.wake_on_inbox ? 1 : 0); }
    if (input.progressive_discovery !== undefined) { sets.push("progressive_discovery = ?"); params.push(input.progressive_discovery ? 1 : 0); }
    if (input.skin_id !== undefined) { sets.push("skin_id = ?"); params.push(input.skin_id); }
    if (input.under_revision !== undefined) { sets.push("under_revision = ?"); params.push(input.under_revision ? 1 : 0); }
    if (input.executor_type === "native" || input.executor_type === "claude_code") {
      sets.push("executor_type = ?");
      params.push(input.executor_type);
    }
    if (input.skills !== undefined) { sets.push("skills_json = ?"); params.push(JSON.stringify(input.skills)); }

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

  createRun(input: {
    agent_id: string;
    trigger_type?: "manual" | "event" | "schedule" | "chain";
    trigger_payload?: Record<string, unknown>;
    goal: string;
    parent_run_id?: string;
    parent_agent_id?: string;
    depth?: number;
  }): AgentRun {
    return this.runs.createRun(input);
  }

  getRun(id: string): AgentRun | undefined {
    return this.runs.getRun(id);
  }

  listRuns(filters?: {
    agent_id?: string;
    status?: string;
    limit?: number;
  }): AgentRun[] {
    return this.runs.listRuns(filters);
  }

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

  cancelRun(id: string): boolean {
    return this.runs.cancelRun(id);
  }

  /** Mark stale "running"/"pending" runs as failed (e.g. after crash/restart) */
  cleanupStaleRuns(): number {
    return this.runs.cleanupStaleRuns();
  }

  // ── Steps → AgentRunsService ────────────────────────

  addStep(input: {
    run_id: string;
    step_number: number;
    type: AgentStep["type"];
    content?: string;
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    tool_output?: string;
    tokens?: number;
  }): AgentStep {
    return this.runs.addStep(input);
  }

  getSteps(runId: string): AgentStep[] {
    return this.runs.getSteps(runId);
  }

  getRunEvents(runId: string): Array<{ id: string; event_type: string; event_subtype: string; detail: string; raw_data: string; tokens_used: number; duration_ms: number; created_at: string }> {
    return this.runs.getRunEvents(runId);
  }

  getAdHocConnections(agentId: string): {
    invokedBy: Array<{ agent_id: string; agent_name: string; count: number; last_at: string }>;
    invoked: Array<{ agent_id: string; agent_name: string; count: number; last_at: string }>;
  } {
    return this.runs.getAdHocConnections(agentId);
  }


  // ── Event triggers → AgentTriggersService ───────────

  addEventTrigger(input: {
    agent_id: string;
    event_name: string;
    filter?: Record<string, unknown>;
    cooldown_ms?: number;
  }): EventTrigger {
    return this.triggers.addEventTrigger(input);
  }

  listEventTriggers(agentId?: string): EventTrigger[] {
    return this.triggers.listEventTriggers(agentId);
  }

  getActiveEventTriggers(): EventTrigger[] {
    return this.triggers.getActiveEventTriggers();
  }

  removeEventTrigger(id: string): boolean {
    return this.triggers.removeEventTrigger(id);
  }

  updateTriggerLastFired(id: string): void {
    this.triggers.updateTriggerLastFired(id);
  }

  // ── Schedules → AgentSchedulesService ───────────────

  addSchedule(input: {
    agent_id: string;
    interval_ms?: number;
    cron_expression?: string;
    goal_override?: string;
  }): AgentSchedule {
    return this.schedules.addSchedule(input);
  }

  listSchedules(agentId?: string): AgentSchedule[] {
    return this.schedules.listSchedules(agentId);
  }

  getDueSchedules(): Array<AgentSchedule & { agent_name: string }> {
    return this.schedules.getDueSchedules();
  }

  removeSchedule(id: string): boolean {
    return this.schedules.removeSchedule(id);
  }

  updateScheduleNextRun(id: string, nextRunAt: string, lastRunAt: string): void {
    this.schedules.updateScheduleNextRun(id, nextRunAt, lastRunAt);
  }

  // NOTE: `deactivateSchedule()` lived here for the old in-memory circuit
  // breaker, its only caller. The breaker now pauses the AGENT
  // (`recordRunOutcome`) and deliberately leaves the schedule row alone, so
  // reactivating an agent resumes it without having to repair its cron too.

  // ── Feedback & stats → AgentFeedbackService ───────

  addFeedback(input: {
    agent_id: string;
    run_id: string;
    rating: number;
    outcome?: AgentFeedback["outcome"];
    lesson?: string;
  }): AgentFeedback {
    return this.feedback.addFeedback(input);
  }

  getFeedback(agentId: string, limit = 20): AgentFeedback[] {
    return this.feedback.getFeedback(agentId, limit);
  }

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

  addLearning(input: {
    agent_id: string;
    type: AgentLearning["type"];
    content: string;
    confidence?: number;
    source_runs?: string[];
  }): AgentLearning {
    return this.memory.addLearning(input);
  }

  getLearnings(agentId: string): AgentLearning[] {
    return this.memory.getLearnings(agentId);
  }

  // ── Conversational memory → AgentMemoryService ────

  addMemory(agentId: string, role: "user" | "assistant", content: string, runId = ""): void {
    this.memory.addMemory(agentId, role, content, runId);
  }

  getMemory(agentId: string, limit = 20): Array<{ role: string; content: string; created_at: string }> {
    return this.memory.getMemory(agentId, limit);
  }

  clearMemory(agentId: string): void {
    this.memory.clearMemory(agentId);
  }


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
  postToColleague(input: {
    from_agent_id: string;
    to_agent_id: string;
    subject: string;
    body: string;
    related_run_id?: string;
    role?: AgentMessageRole;
    in_reply_to_message_id?: string;
    conversation_id?: string;
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
    };
    this.db
      .prepare(
        `INSERT INTO agent_office_inbox
          (id, flow_id, from_agent_id, to_agent_id, subject, body, status, related_run_id, created_at, read_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        msg.id, msg.flow_id, msg.from_agent_id, msg.to_agent_id,
        msg.subject, msg.body, msg.status, msg.related_run_id,
        msg.created_at, msg.read_at,
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
    });
    return { message: msg, conversation_message: convoMsg, conversation };
  }

  /** Return unread inbox messages for an agent, oldest first. */
  getUnreadInbox(agentId: string, limit = 20): AgentOfficeInboxMessage[] {
    return this.db
      .prepare(
        `SELECT * FROM agent_office_inbox
         WHERE to_agent_id = ? AND status = 'unread'
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(agentId, limit) as AgentOfficeInboxMessage[];
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

  /** Full inbox listing for dashboard/debug views. */
  // ── Escalated questions (human-in-the-loop) ────────────
  // An agent stuck on an open question escalates to the user via
  // kernel_agents_ask_supervisor, supplying canned answer options. The user
  // picks one from the My Office panel; the answer is posted back to the
  // asking agent's inbox so the next run sees it.
  createQuestion(input: {
    from_agent_id: string;
    flow_id?: string;
    meeting_id?: string;
    run_id?: string;
    question: string;
    context?: string;
    options: Array<{ label: string; value?: string }>;
  }): { id: string } {
    const id = newId();
    const askedAt = isoNow();
    this.db
      .prepare(
        `INSERT INTO agent_questions
          (id, from_agent_id, flow_id, meeting_id, run_id, question, context, options, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        id,
        input.from_agent_id,
        input.flow_id ?? "",
        input.meeting_id ?? "",
        input.run_id ?? "",
        input.question,
        input.context ?? "",
        JSON.stringify(input.options),
        askedAt,
      );
    this.events.emit("data.changed", { module: "agents", action: "question_asked" });

    // A question blocks the agent until someone answers it, and the only place
    // it showed up was a panel you had to already be looking at — so an agent
    // could sit waiting on the operator indefinitely with nothing said. Unlike
    // agent-to-agent chatter, a question is addressed to a human by
    // construction, which is what makes it safe to ring the bell for.
    this.events.emit("agent:question_asked", {
      question_id: id,
      agent_id: input.from_agent_id,
      agent_name: this.getAgent(input.from_agent_id)?.name ?? "An agent",
      question: input.question,
      context: input.context ?? "",
      options: input.options.map((o) => o.label),
      run_id: input.run_id ?? "",
      asked_at: askedAt,
    });
    return { id };
  }

  listQuestions(opts?: { status?: "pending" | "answered" | "dismissed"; limit?: number }): Array<{
    id: string; from_agent_id: string; flow_id: string; meeting_id: string; run_id: string;
    question: string; context: string; options: Array<{ label: string; value?: string }>;
    status: string; selected_option: string; selected_index: number;
    answered_note: string; answered_at: string | null; created_at: string;
  }> {
    let sql = "SELECT * FROM agent_questions";
    const params: unknown[] = [];
    if (opts?.status) {
      sql += " WHERE status = ?";
      params.push(opts.status);
    }
    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(opts?.limit ?? 50);
    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
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
      status: String(r.status ?? "pending"),
      selected_option: String(r.selected_option ?? ""),
      selected_index: Number(r.selected_index ?? -1),
      answered_note: String(r.answered_note ?? ""),
      answered_at: r.answered_at == null ? null : String(r.answered_at),
      created_at: String(r.created_at ?? ""),
    }));
  }

  answerQuestion(id: string, input: { selected_index: number; selected_option: string; note?: string }): { from_agent_id: string; question: string } | null {
    const q = this.db.prepare("SELECT from_agent_id, question, options, status FROM agent_questions WHERE id = ?").get(id) as
      | { from_agent_id: string; question: string; options: string; status: string }
      | undefined;
    if (!q || q.status !== "pending") return null;
    this.db
      .prepare(
        `UPDATE agent_questions
         SET status='answered', selected_option=?, selected_index=?, answered_note=?, answered_at=?
         WHERE id=?`,
      )
      .run(input.selected_option, input.selected_index, input.note ?? "", isoNow(), id);

    // Post the answer back to the asking agent so they pick it up on next run.
    // Find the user's identity: the human is represented as "__top_agent__
    // General" in the inbox (sender). We reuse postToColleague only if such
    // an agent exists; otherwise insert directly into the inbox as a note.
    const asker = this.getAgent(q.from_agent_id);
    if (asker) {
      const inboxId = newId();
      this.db
        .prepare(
          `INSERT INTO agent_office_inbox
            (id, flow_id, from_agent_id, to_agent_id, subject, body, status, related_run_id, created_at, read_at)
           VALUES (?, ?, '__top_agent__', ?, ?, ?, 'unread', '', ?, NULL)`,
        )
        .run(
          inboxId,
          asker.flow_id ?? "",
          q.from_agent_id,
          `ANSWER: ${q.question.slice(0, 160)}`,
          `Your supervisor answered your question.\n\n**Question:** ${q.question}\n\n**Answer:** ${input.selected_option}${input.note ? `\n\n**Note:** ${input.note}` : ""}`,
          isoNow(),
        );
    }

    this.events.emit("data.changed", { module: "agents", action: "question_answered" });
    return { from_agent_id: q.from_agent_id, question: q.question };
  }

  dismissQuestion(id: string): boolean {
    const r = this.db.prepare("UPDATE agent_questions SET status='dismissed' WHERE id=? AND status='pending'").run(id);
    if (r.changes > 0) this.events.emit("data.changed", { module: "agents", action: "question_dismissed" });
    return r.changes > 0;
  }

  listInbox(
    agentId: string,
    opts?: { status?: "unread" | "read" | "archived"; limit?: number },
  ): AgentOfficeInboxMessage[] {
    let sql = "SELECT * FROM agent_office_inbox WHERE to_agent_id = ?";
    const params: unknown[] = [agentId];
    if (opts?.status) {
      sql += " AND status = ?";
      params.push(opts.status);
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

  getRelevantMemory(
    agentId: string,
    goal: string,
    limit = 20,
    pool = 100,
  ): Array<{ role: string; content: string; created_at: string }> {
    return this.memory.getRelevantMemory(agentId, goal, limit, pool);
  }

  getRelevantMemoryByEmbedding(
    agentId: string,
    goal: string,
    goalVector: number[],
    limit = 20,
    pool = 100,
    cosineWeight?: number,
    minScore?: number,
  ): Array<{ role: string; content: string; created_at: string }> {
    return this.memory.getRelevantMemoryByEmbedding(agentId, goal, goalVector, limit, pool, cosineWeight, minScore);
  }

  findSimilarPastRuns(
    agentId: string,
    goal: string,
    limit = 3,
    pool = 30,
  ): AgentRun[] {
    return this.memory.findSimilarPastRuns(agentId, goal, limit, pool);
  }

  findSimilarPastRunsByEmbedding(
    agentId: string,
    goal: string,
    goalVector: number[],
    limit = 3,
    pool = 30,
    cosineWeight?: number,
    minScore?: number,
  ): AgentRun[] {
    return this.memory.findSimilarPastRunsByEmbedding(agentId, goal, goalVector, limit, pool, cosineWeight, minScore);
  }

  getRelevantLearnings(
    agentId: string,
    goal: string,
    limit = 15,
  ): AgentLearning[] {
    return this.memory.getRelevantLearnings(agentId, goal, limit);
  }

  getRelevantLearningsByEmbedding(
    agentId: string,
    goal: string,
    goalVector: number[],
    limit = 15,
    cosineWeight?: number,
    minScore?: number,
  ): AgentLearning[] {
    return this.memory.getRelevantLearningsByEmbedding(agentId, goal, goalVector, limit, cosineWeight, minScore);
  }

  updateLearningConfidence(id: string, delta: number): void {
    this.memory.updateLearningConfidence(id, delta);
  }

  deactivateLearning(id: string): void {
    this.memory.deactivateLearning(id);
  }

  getLearningsActiveAt(agentId: string, referenceTime: string): AgentLearning[] {
    return this.memory.getLearningsActiveAt(agentId, referenceTime);
  }

  reinforceLearningsForRun(
    agentId: string,
    runCreatedAt: string,
    outcome: "success" | "partial" | "failure" | "neutral",
  ): { updated: number; deactivated: number } {
    return this.memory.reinforceLearningsForRun(agentId, runCreatedAt, outcome);
  }

  cleanupLowConfidenceLearnings(agentId: string, minConfidence = 0.15): number {
    return this.memory.cleanupLowConfidenceLearnings(agentId, minConfidence);
  }


  // ── Conversations & messages → AgentConversationsService ────────────

  /** @see AgentConversationsService.computeTopicHash */
  static computeTopicHash(topic: string): string {
    return AgentConversationsService.computeTopicHash(topic);
  }

  createConversation(input: {
    kind: "chat" | "meeting" | "debate";
    topic: string;
    participants: string[];
    initiator_agent_id: string;
    parent_conversation_id?: string;
    meta?: Record<string, unknown>;
  }): AgentConversation {
    return this.conversations.createConversation(input);
  }

  getConversation(id: string): AgentConversation | undefined {
    return this.conversations.getConversation(id);
  }

  findOrCreateChatConversation(input: {
    topic: string;
    participants: string[];
    initiator_agent_id: string;
  }): AgentConversation {
    return this.conversations.findOrCreateChatConversation(input);
  }

  listConversations(opts?: {
    agent_id?: string;
    kind?: "chat" | "meeting" | "debate";
    status?: "open" | "closed";
    excludeArchived?: boolean;
    limit?: number;
  }): AgentConversation[] {
    return this.conversations.listConversations(opts);
  }

  closeConversation(id: string): void {
    this.conversations.closeConversation(id);
  }

  archiveConversation(id: string): boolean {
    return this.conversations.archiveConversation(id);
  }

  archiveClosedConversations(opts?: { kind?: "chat" | "meeting" | "debate" }): number {
    return this.conversations.archiveClosedConversations(opts);
  }

  parseParticipants(convo: AgentConversation): string[] {
    return this.conversations.parseParticipants(convo);
  }

  addParticipant(conversationId: string, agentId: string): void {
    this.conversations.addParticipant(conversationId, agentId);
  }

  postMessage(input: {
    conversation_id: string;
    from_agent_id: string;
    to_agent_id?: string;
    role?: AgentMessageRole;
    in_reply_to?: string;
    body: string;
    tokens?: number;
    run_id?: string;
    meta?: Record<string, unknown>;
  }): AgentMessage {
    return this.conversations.postMessage(input);
  }

  getMessage(id: string): AgentMessage | undefined {
    return this.conversations.getMessage(id);
  }

  listMessages(conversationId: string, opts?: {
    limit?: number;
    role?: AgentMessageRole;
  }): AgentMessage[] {
    return this.conversations.listMessages(conversationId, opts);
  }

  getCounterStats(conversationId: string): {
    distinct_senders: string[];
    counters: AgentMessage[];
  } {
    return this.conversations.getCounterStats(conversationId);
  }

  // ── Debate cooldown register → AgentConversationsService ──

  getDebateCooldown(topicHash: string): AgentDebateCooldown | undefined {
    return this.conversations.getDebateCooldown(topicHash);
  }

  recordDebateCooldown(topicHash: string, debateConvId: string): void {
    this.conversations.recordDebateCooldown(topicHash, debateConvId);
  }

  countRecentAutoDebates(sinceIsoTimestamp: string): number {
    return this.conversations.countRecentAutoDebates(sinceIsoTimestamp);
  }


  // ── Chains → AgentChainsService ─────────────────

  addChain(input: {
    source_agent_id: string;
    target_agent_id: string;
    label?: string;
    condition?: Record<string, unknown>;
    pass_result?: boolean;
    delay_ms?: number;
  }): AgentChain {
    return this.chains.addChain(input);
  }

  listChains(agentId?: string): AgentChain[] {
    return this.chains.listChains(agentId);
  }

  getChainsBySource(sourceId: string): AgentChain[] {
    return this.chains.getChainsBySource(sourceId);
  }

  removeChain(id: string): boolean {
    return this.chains.removeChain(id);
  }

  // ── Event log → AgentEventLogService ──────────────

  logEvent(data: {
    run_id?: string;
    agent_id?: string;
    agent_name?: string;
    event_type: string;
    event_subtype?: string;
    detail?: string;
    raw_data?: Record<string, unknown>;
    tokens_used?: number;
    duration_ms?: number;
  }): void {
    this.eventLog.logEvent(data);
  }

  getEventLog(opts?: {
    run_id?: string;
    agent_id?: string;
    event_type?: string;
    limit?: number;
    offset?: number;
    since?: string;
  }): unknown[] {
    return this.eventLog.getEventLog(opts);
  }

  getEventLogCount(opts?: {
    run_id?: string;
    agent_id?: string;
    event_type?: string;
    since?: string;
  }): number {
    return this.eventLog.getEventLogCount(opts);
  }

  clearEventLog(opts?: { before?: string; agent_id?: string }): number {
    return this.eventLog.clearEventLog(opts);
  }

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

  activatePromptVersion(agentId: string, version: number): AgentPromptVersion | null {
    return this.promptVersions.activatePromptVersion(agentId, version);
  }

  listPromptVersions(agentId: string, limit = 50): AgentPromptVersion[] {
    return this.promptVersions.listPromptVersions(agentId, limit);
  }

  getPromptVersion(agentId: string, version: number): AgentPromptVersion | undefined {
    return this.promptVersions.getPromptVersion(agentId, version);
  }

  getActivePromptVersion(agentId: string): AgentPromptVersion | undefined {
    return this.promptVersions.getActivePromptVersion(agentId);
  }

  restorePromptVersion(agentId: string, version: number, note = ""): AgentPromptVersion | null {
    return this.promptVersions.restorePromptVersion(agentId, version, note);
  }

  diffPromptVersions(
    agentId: string,
    fromVersion: number,
    toVersion: number,
  ): { from: AgentPromptVersion; to: AgentPromptVersion; lines: Array<{ kind: "same" | "added" | "removed"; text: string }> } | null {
    return this.promptVersions.diffPromptVersions(agentId, fromVersion, toVersion);
  }

  // ── Evolution runs (Autogenesis SEPL) → AgentEvolutionService ──

  createEvolutionRun(input: {
    agent_id: string;
    base_version: number;
    hypothesis: string;
    proposal: string;
    trigger_run_ids?: string[];
    target?: AgentEvolutionRun["target"];
    workspace_id?: string;
    artifact_ref?: string;
  }): AgentEvolutionRun {
    return this.evolution.createEvolutionRun(input);
  }

  updateEvolutionRun(
    id: string,
    patch: Partial<Pick<AgentEvolutionRun,
      "candidate_version" | "status" | "baseline_score" | "candidate_score" | "evaluation" | "error" | "committed_at" | "artifact_ref">>,
  ): AgentEvolutionRun | undefined {
    return this.evolution.updateEvolutionRun(id, patch);
  }

  listEvolutionRuns(agentId: string, limit = 20): AgentEvolutionRun[] {
    return this.evolution.listEvolutionRuns(agentId, limit);
  }

  listEvolutionRunsByWorkspace(workspaceId: string, limit = 50): AgentEvolutionRun[] {
    return this.evolution.listEvolutionRunsByWorkspace(workspaceId, limit);
  }

  getEvolutionRun(id: string): AgentEvolutionRun | undefined {
    return this.evolution.getEvolutionRun(id);
  }

  // ── Conversation subscriptions → AgentSubscriptionsService ───────────────

  subscribeAgentToConversation(input: {
    agent_id: string;
    conversation_id: string;
    mode?: "responder" | "observer";
    filter_role?: string;
  }): AgentConversationSubscription | null {
    return this.subscriptions.subscribeAgentToConversation(input);
  }

  unsubscribeAgentFromConversation(agentId: string, conversationId: string): boolean {
    return this.subscriptions.unsubscribeAgentFromConversation(agentId, conversationId);
  }

  getSubscription(id: string): AgentConversationSubscription | undefined {
    return this.subscriptions.getSubscription(id);
  }

  listSubscriptionsForConversation(conversationId: string): AgentConversationSubscription[] {
    return this.subscriptions.listSubscriptionsForConversation(conversationId);
  }

  listSubscriptionsForAgent(agentId: string): AgentConversationSubscription[] {
    return this.subscriptions.listSubscriptionsForAgent(agentId);
  }

  markSubscriptionFired(id: string): void {
    this.subscriptions.markSubscriptionFired(id);
  }
}
