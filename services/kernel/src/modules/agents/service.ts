import type { SqliteDb } from "../../core/db/sqlite.js";
import type { EventBus } from "../../core/event-bus.js";
import type { EmbeddingsClient } from "../../core/embeddings/client.js";
import type { KernelConfig } from "../../core/config.js";
import { resolve } from "node:path";
import { newId, isoNow } from "../../core/helpers.js";
import { log } from "../../core/logger.js";
import { writeAgentEvent } from "../../core/agent-logger.js";
import { WORKSPACE_ROOT } from "./workspace-constants.js";
import { OFFICE_HOME_WORKSPACE_NAME } from "./office-home.js";
import { computeNextCronRun } from "./cron-utils.js";
import {
  rankByRelevance,
  rankByEmbedding,
  vectorToBlob,
  blobToVector,
} from "../../core/ranking/relevance.js";
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

const TOPIC_STOPWORDS = new Set<string>([
  "the", "and", "for", "are", "but", "not", "you", "with", "this", "that",
  "from", "have", "has", "was", "were", "been", "being", "will", "shall",
  "should", "could", "would", "can", "may", "our", "your", "their", "they",
  "them", "there", "here", "into", "onto", "upon", "than", "then", "these",
  "those", "some", "any", "all", "who", "what", "when", "where", "why", "how",
  "para", "por", "con", "sin", "del", "los", "las", "una", "uno", "que", "como",
  "pero", "este", "esta", "esto", "esos", "esas", "cuando", "donde", "quien",
  "sobre", "entre", "desde", "hasta", "muy", "más", "menos",
]);

/** Fallback for `config.agents.autoPauseThreshold` when no config is injected. */
const DEFAULT_AUTO_PAUSE_THRESHOLD = 3;

/** Stable topic so every auto-pause alert for the same pair lands in one thread. */
const AUTO_PAUSE_ALERT_TOPIC = "Agent auto-pause alerts";

export class AgentService {
  /**
   * Embeddings client — set lazily by bootstrap once createEmbeddingsClient
   * resolves (the agents module initialises before that happens). Stays
   * null on hosts where embeddings are disabled or LMStudio + local both
   * failed; in that case write-time embedding silently no-ops and the
   * reader degrades to lexical ranking. Best-effort everywhere.
   */
  private embeddings: EmbeddingsClient | null = null;

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
  ) {}

  /** Inject the embeddings client. Idempotent — last writer wins. */
  setEmbeddingsClient(client: EmbeddingsClient | null): void {
    this.embeddings = client;
    if (client) {
      log.info(`AgentService: semantic ranking enabled (${client.provider} ${client.model} dim=${client.dim})`);
    }
  }

  getEmbeddingsClient(): EmbeddingsClient | null {
    return this.embeddings;
  }

  /**
   * Embed a single text — best-effort. Returns null on any failure or when
   * no client is wired. Callers MUST treat null as "store no embedding,
   * reader will fall back to lexical for this row".
   */
  private async embedOne(text: string): Promise<number[] | null> {
    if (!this.embeddings || !text || text.length === 0) return null;
    try {
      const [vec] = await this.embeddings.embed([text]);
      return vec ?? null;
    } catch (err) {
      log.debug(`AgentService.embedOne failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * Fire-and-forget background embed: keeps the public addMemory/addLearning/
   * createRun signatures sync (existing callers untouched) while still landing
   * a vector on the row a moment later. Reader degrades to lexical for rows
   * whose embedding hasn't arrived yet — safe to call even when embeddings
   * are disabled (no-op on null client).
   *
   * `column` and `modelColumn` are interpolated into the SQL but only ever
   * supplied from this file's three call sites — never from user input.
   */
  private scheduleEmbed(
    table: "agent_memory" | "agent_learnings" | "agent_runs",
    column: "embedding" | "goal_embedding",
    modelColumn: "embedding_model" | "goal_embedding_model",
    rowId: string,
    text: string,
  ): void {
    if (!this.embeddings || !text || text.length === 0) return;
    const client = this.embeddings;
    queueMicrotask(() => {
      void (async () => {
        try {
          const vec = await this.embedOne(text);
          if (!vec) return;
          this.db
            .prepare(`UPDATE ${table} SET ${column} = ?, ${modelColumn} = ? WHERE id = ?`)
            .run(vectorToBlob(vec), client.model, rowId);
        } catch (err) {
          log.debug(`scheduleEmbed(${table}/${rowId}) failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    });
  }

  // ── Flow CRUD ──────────────────────────────────────

  createFlow(input: { name: string; description?: string; color?: string }): AgentFlow {
    const now = isoNow();
    const flow: AgentFlow = {
      id: newId(),
      name: input.name,
      description: input.description ?? "",
      color: input.color ?? "#6366f1",
      active: 1,
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO agent_flows (id, name, description, color, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(flow.id, flow.name, flow.description, flow.color, flow.active, flow.created_at, flow.updated_at);
    // Every office gets a kernel-workspace home automatically (DB-only — the
    // on-disk folder convention is seeded lazily by the executor / set_repo so
    // flow creation stays test-safe). Best-effort: a failure here must not
    // block office creation.
    try {
      this.ensureOfficeHomeWorkspace(flow);
    } catch (err) {
      log.warn(`createFlow: could not create office home for "${flow.name}": ${err instanceof Error ? err.message : String(err)}`);
    }
    this.events.emit("data.changed", { module: "agents", action: "flow_created" });
    return flow;
  }

  // ── Office home (workspace / repo) ─────────────────
  //
  // See src/modules/agents/office-home.ts and migration v36. The home is the
  // directory every agent in the office inherits as cwd (unless it has its own
  // __cwd_path__ / __workspace__ override). It's a kernel workspace by default;
  // promoting to a host git repo just fills home_repo_path.

  /**
   * Make sure `flow` has a backing office-home workspace row and that
   * `home_workspace_id` points at it. Idempotent + DB-only. Returns the
   * workspace id. Mutates the passed `flow` object's home_workspace_id.
   */
  private ensureOfficeHomeWorkspace(flow: AgentFlow): string {
    if (flow.home_workspace_id) {
      const live = this.db
        .prepare("SELECT 1 FROM workspaces WHERE id = ? AND deleted_at IS NULL")
        .get(flow.home_workspace_id);
      if (live) return flow.home_workspace_id;
    }
    // Re-link to an existing 'office-home' row if one is already there (e.g.
    // partial backfill, or the link column was cleared).
    const existing = this.db
      .prepare("SELECT id FROM workspaces WHERE owner_flow_id = ? AND name = ? AND deleted_at IS NULL")
      .get(flow.id, OFFICE_HOME_WORKSPACE_NAME) as { id: string } | undefined;
    let wsId = existing?.id;
    if (!wsId) {
      const now = isoNow();
      wsId = newId();
      this.db
        .prepare(
          `INSERT INTO workspaces (id, owner_flow_id, name, description, shared, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(wsId, flow.id, OFFICE_HOME_WORKSPACE_NAME, `Home of the ${flow.name} office`, now, now);
    }
    this.db
      .prepare("UPDATE agent_flows SET home_workspace_id = ?, updated_at = ? WHERE id = ?")
      .run(wsId, isoNow(), flow.id);
    flow.home_workspace_id = wsId;
    return wsId;
  }

  /** Public entrypoint for the backfill script. Returns the workspace id or null. */
  ensureOfficeHome(flowId: string): string | null {
    const flow = this.getFlow(flowId);
    if (!flow) return null;
    return this.ensureOfficeHomeWorkspace(flow);
  }

  /**
   * Resolve the working directory an agent in `flowId` should inherit.
   * Self-healing: if the office has no home yet, creates the workspace row.
   *   - home_repo_path set (absolute) → the host git repo.
   *   - otherwise → data/workspaces/{home_workspace_id}/.
   * Returns null if the flow doesn't exist.
   */
  resolveFlowHome(flowId: string): { path: string; kind: "git" | "workspace"; flow: AgentFlow } | null {
    if (!flowId) return null;
    const flow = this.getFlow(flowId);
    if (!flow) return null;
    if (flow.home_repo_path && flow.home_repo_path.startsWith("/")) {
      return { path: flow.home_repo_path, kind: "git", flow };
    }
    let wsId = flow.home_workspace_id;
    if (!wsId) {
      try {
        wsId = this.ensureOfficeHomeWorkspace(flow);
      } catch {
        return null;
      }
    }
    if (!wsId) return null;
    return { path: resolve(WORKSPACE_ROOT, wsId), kind: "workspace", flow };
  }

  /**
   * Promote (or revert) an office to a host git repo. Empty `repoPath` reverts
   * the office to its kernel workspace. Disk side (mkdir / git init / seed) is
   * the caller's job (the set_repo tool) — this only persists the column.
   */
  setFlowRepo(flowId: string, repoPath: string): AgentFlow | undefined {
    const flow = this.getFlow(flowId);
    if (!flow) return undefined;
    this.db
      .prepare("UPDATE agent_flows SET home_repo_path = ?, updated_at = ? WHERE id = ?")
      .run(repoPath, isoNow(), flowId);
    this.events.emit("data.changed", { module: "agents", action: "flow_repo_set" });
    return this.getFlow(flowId);
  }

  listFlows(): AgentFlow[] {
    return this.db
      .prepare("SELECT * FROM agent_flows WHERE active = 1 ORDER BY created_at DESC")
      .all() as AgentFlow[];
  }

  getFlow(id: string): AgentFlow | undefined {
    return this.db.prepare("SELECT * FROM agent_flows WHERE id = ?").get(id) as AgentFlow | undefined;
  }

  updateFlow(id: string, updates: Partial<Pick<AgentFlow, "name" | "description" | "color">>): AgentFlow | undefined {
    const flow = this.getFlow(id);
    if (!flow) return undefined;
    const name = updates.name ?? flow.name;
    const description = updates.description ?? flow.description;
    const color = updates.color ?? flow.color;
    const now = isoNow();
    this.db
      .prepare("UPDATE agent_flows SET name = ?, description = ?, color = ?, updated_at = ? WHERE id = ?")
      .run(name, description, color, now, id);
    this.events.emit("data.changed", { module: "agents", action: "flow_updated" });
    return this.getFlow(id);
  }

  deleteFlow(id: string): boolean {
    const flow = this.getFlow(id);
    if (!flow) return false;
    // Unassign agents from this flow
    this.db.prepare("UPDATE agents SET flow_id = '' WHERE flow_id = ?").run(id);
    this.db.prepare("UPDATE agent_flows SET active = 0 WHERE id = ?").run(id);
    this.events.emit("data.changed", { module: "agents", action: "flow_deleted" });
    return true;
  }

  assignAgentToFlow(agentId: string, flowId: string): boolean {
    const agent = this.getAgent(agentId);
    if (!agent) return false;
    if (flowId && !this.getFlow(flowId)) return false;
    this.db.prepare("UPDATE agents SET flow_id = ?, updated_at = ? WHERE id = ?").run(flowId, isoNow(), agentId);
    this.events.emit("data.changed", { module: "agents", action: "agent_flow_changed" });
    return true;
  }

  // ── Rank CRUD ───────────────────────────────────────

  createRank(input: {
    name: string;
    level: number;
    insignia?: string;
    color?: string;
    description?: string;
  }): AgentRank {
    const now = isoNow();
    const rank: AgentRank = {
      id: newId(),
      name: input.name,
      level: input.level,
      insignia: input.insignia ?? "",
      color: input.color ?? "#888888",
      description: input.description ?? "",
      active: 1,
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO agent_ranks (id, name, level, insignia, color, description, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(rank.id, rank.name, rank.level, rank.insignia, rank.color, rank.description, rank.active, rank.created_at, rank.updated_at);
    this.events.emit("data.changed", { module: "agents", action: "rank_created" });
    return rank;
  }

  listRanks(): AgentRank[] {
    return this.db
      .prepare("SELECT * FROM agent_ranks WHERE active = 1 ORDER BY level ASC")
      .all() as AgentRank[];
  }

  getRank(id: string): AgentRank | undefined {
    if (!id) return undefined;
    return this.db.prepare("SELECT * FROM agent_ranks WHERE id = ?").get(id) as AgentRank | undefined;
  }

  /**
   * Resolve the top agent (holder of the highest rank): the active
   * agent holding the highest-level rank. Mirrors the selection logic in
   * `top-agent-seeder.ts` so callers (e.g. Telegram routing) reach the same
   * commander the seeder created. Returns undefined if no ranks/agent exist.
   */
  getTopAgent(): Agent | undefined {
    const ranks = this.listRanks();
    if (ranks.length === 0) return undefined;
    const top = [...ranks].sort((a, b) => b.level - a.level)[0];
    if (!top) return undefined;
    return this.listAgents({ active: true }).find((a) => a.rank_id === top.id);
  }

  updateRank(
    id: string,
    updates: Partial<Pick<AgentRank, "name" | "level" | "insignia" | "color" | "description">>,
  ): AgentRank | undefined {
    const rank = this.getRank(id);
    if (!rank) return undefined;
    const name = updates.name ?? rank.name;
    const level = updates.level ?? rank.level;
    const insignia = updates.insignia ?? rank.insignia;
    const color = updates.color ?? rank.color;
    const description = updates.description ?? rank.description;
    const now = isoNow();
    this.db
      .prepare(
        "UPDATE agent_ranks SET name = ?, level = ?, insignia = ?, color = ?, description = ?, updated_at = ? WHERE id = ?",
      )
      .run(name, level, insignia, color, description, now, id);
    this.events.emit("data.changed", { module: "agents", action: "rank_updated" });
    return this.getRank(id);
  }

  deleteRank(id: string): boolean {
    const rank = this.getRank(id);
    if (!rank) return false;
    this.db.prepare("UPDATE agents SET rank_id = '' WHERE rank_id = ?").run(id);
    this.db.prepare("UPDATE agent_ranks SET active = 0 WHERE id = ?").run(id);
    this.events.emit("data.changed", { module: "agents", action: "rank_deleted" });
    return true;
  }

  assignRankToAgent(agentId: string, rankId: string): boolean {
    const agent = this.getAgent(agentId);
    if (!agent) return false;
    if (rankId && !this.getRank(rankId)) return false;
    this.db.prepare("UPDATE agents SET rank_id = ?, updated_at = ? WHERE id = ?").run(rankId, isoNow(), agentId);
    this.events.emit("data.changed", { module: "agents", action: "agent_rank_changed" });
    return true;
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

  // ── Run management ──────────────────────────────────

  createRun(input: {
    agent_id: string;
    trigger_type?: "manual" | "event" | "schedule" | "chain";
    trigger_payload?: Record<string, unknown>;
    goal: string;
    /** Run that spawned this one (chain/invoke). Empty string for top-level. */
    parent_run_id?: string;
    /** Agent that spawned this one. Empty string for top-level. */
    parent_agent_id?: string;
    /** 0 for top-level, parent.depth + 1 otherwise. */
    depth?: number;
  }): AgentRun {
    const now = isoNow();

    // ── Defense-in-depth gates ───────────────────────────
    // 1. Refuse to create runs for inactive agents. The handler in tools.ts
    //    already checks `agent.active`, but the agent could be deactivated
    //    between that check and here, OR another path could call createRun
    //    directly without the check (e.g. extension-facade, chain-runner).
    const agentRow = this.db
      .prepare("SELECT active FROM agents WHERE id = ?")
      .get(input.agent_id) as { active: number } | undefined;
    if (!agentRow) {
      throw new Error(`createRun: agent ${input.agent_id} not found`);
    }
    if (agentRow.active === 0) {
      throw new Error(`createRun: agent ${input.agent_id} is inactive (active=0)`);
    }

    // 2. Self-invocation guard. If a parent context is supplied and the parent
    //    agent_id matches the target, refuse — this is the classic runaway-loop
    //    failure mode: an agent invoking `kernel_agents_run(self)` ad infinitum.
    //    Top-level runs (no parent) bypass this check.
    const parentAgentId = (input.parent_agent_id ?? "").trim();
    const parentRunId = (input.parent_run_id ?? "").trim();
    if (parentAgentId && parentAgentId === input.agent_id) {
      throw new Error(
        `createRun: agent ${input.agent_id} cannot invoke itself (self-recursion). ` +
        `Parent run was ${parentRunId || "(unknown)"}.`,
      );
    }

    // 3. Recursion depth cap. Even without direct self-invocation a chain
    //    A→B→A→B→... can spiral. Hard ceiling ends the descent.
    const depth = Math.max(0, Number(input.depth ?? 0));
    const maxDepth = Math.max(1, Number(process.env.KERNEL_AGENT_MAX_DEPTH ?? 5));
    if (depth > maxDepth) {
      throw new Error(
        `createRun: agent ${input.agent_id} depth=${depth} exceeds KERNEL_AGENT_MAX_DEPTH=${maxDepth}. ` +
        `Parent chain rooted at run ${parentRunId || "(unknown)"}.`,
      );
    }

    // 4. Per-agent runaway guard. Count CONCURRENT in-flight runs, not the
    //    rolling-60s total — high-frequency legit agents (Email Triage,
    //    Trading Auto-Execute) can complete dozens of fast runs per minute
    //    without that being a loop. A loop, by contrast, leaves runs piling
    //    up in pending/running because the executor can't keep pace.
    //    Tunable via env so a legit burst can crank it.
    const maxConcurrent = Math.max(1, Number(process.env.KERNEL_AGENT_MAX_CONCURRENT ?? 25));
    const concurrent = this.db
      .prepare(
        "SELECT COUNT(*) AS c FROM agent_runs WHERE agent_id = ? AND status IN ('pending', 'running')",
      )
      .get(input.agent_id) as { c: number };
    if (concurrent.c >= maxConcurrent) {
      throw new Error(
        `createRun: agent ${input.agent_id} runaway guard tripped — ${concurrent.c} concurrent in-flight runs (max ${maxConcurrent}). ` +
        `Likely a self-invocation loop or a stuck executor. Raise KERNEL_AGENT_MAX_CONCURRENT to lift.`,
      );
    }

    // For chain-triggered runs, enrich payload with chain metadata and use
    // 'event' as the SQL trigger_type (CHECK constraint compatibility).
    // The TypeScript type preserves 'chain' for application-level logic.
    const isChain = input.trigger_type === "chain";
    const sqlTriggerType = isChain ? "event" : (input.trigger_type ?? "manual");
    const payload = isChain
      ? { chain: true, ...(input.trigger_payload ?? {}) }
      : (input.trigger_payload ?? {});

    const run: AgentRun = {
      id: newId(),
      agent_id: input.agent_id,
      trigger_type: input.trigger_type ?? "manual",
      trigger_payload: JSON.stringify(payload),
      goal: input.goal,
      status: "pending",
      result: "",
      error: "",
      steps_count: 0,
      tokens_used: 0,
      started_at: null,
      completed_at: null,
      created_at: now,
      parent_run_id: parentRunId,
      parent_agent_id: parentAgentId,
      depth,
    };

    this.db
      .prepare(
        `INSERT INTO agent_runs (id, agent_id, trigger_type, trigger_payload, goal,
         status, result, error, steps_count, tokens_used, started_at, completed_at, created_at,
         parent_run_id, parent_agent_id, depth)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id, run.agent_id, sqlTriggerType, run.trigger_payload,
        run.goal, run.status, run.result, run.error, run.steps_count,
        run.tokens_used, run.started_at, run.completed_at, run.created_at,
        run.parent_run_id, run.parent_agent_id, run.depth,
      );

    if (run.goal && run.goal.length >= 5) {
      this.scheduleEmbed("agent_runs", "goal_embedding", "goal_embedding_model", run.id, run.goal);
    }
    return run;
  }

  getRun(id: string): AgentRun | undefined {
    return this.db
      .prepare("SELECT * FROM agent_runs WHERE id = ?")
      .get(id) as AgentRun | undefined;
  }

  listRuns(filters?: {
    agent_id?: string;
    status?: string;
    limit?: number;
  }): AgentRun[] {
    let sql = "SELECT * FROM agent_runs WHERE 1=1";
    const params: unknown[] = [];

    if (filters?.agent_id) {
      sql += " AND agent_id = ?";
      params.push(filters.agent_id);
    }
    if (filters?.status) {
      sql += " AND status = ?";
      params.push(filters.status);
    }

    sql += " ORDER BY created_at DESC";

    if (filters?.limit) {
      sql += " LIMIT ?";
      params.push(filters.limit);
    }

    return this.db.prepare(sql).all(...params) as AgentRun[];
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
    const sets: string[] = [];
    const params: unknown[] = [];

    if (updates.status !== undefined) { sets.push("status = ?"); params.push(updates.status); }
    if (updates.result !== undefined) { sets.push("result = ?"); params.push(updates.result); }
    if (updates.error !== undefined) { sets.push("error = ?"); params.push(updates.error); }
    if (updates.steps_count !== undefined) { sets.push("steps_count = ?"); params.push(updates.steps_count); }
    if (updates.tokens_used !== undefined) { sets.push("tokens_used = ?"); params.push(updates.tokens_used); }
    if (updates.started_at !== undefined) { sets.push("started_at = ?"); params.push(updates.started_at); }
    if (updates.completed_at !== undefined) { sets.push("completed_at = ?"); params.push(updates.completed_at); }

    if (sets.length === 0) return;
    params.push(id);

    this.db.prepare(`UPDATE agent_runs SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }

  cancelRun(id: string): boolean {
    const run = this.getRun(id);
    if (!run || run.status === "completed" || run.status === "failed") return false;

    this.updateRun(id, { status: "cancelled", completed_at: isoNow() });
    this.events.emit("data.changed", { module: "agents", action: "run_cancelled" });
    return true;
  }

  /** Mark stale "running"/"pending" runs as failed (e.g. after crash/restart) */
  cleanupStaleRuns(): number {
    const now = isoNow();
    const result = this.db
      .prepare(
        `UPDATE agent_runs SET status = 'failed', error = 'Stale run cleaned up on startup', completed_at = ?
         WHERE status IN ('running', 'pending')`,
      )
      .run(now);
    const changes = result?.changes ?? 0;
    if (changes > 0) {
      log.info(`AgentService: cleaned up ${changes} stale runs`);
    }
    // …and the meetings those runs were driving.
    //
    // A meeting or debate only exists inside a live process: MeetingExecutor
    // loops in memory and closes the conversation when it finishes. Kill the
    // process mid-meeting — a crash, or an operator redeploying — and the run
    // was marked failed here while the conversation stayed `open` forever.
    // Nothing ever closed it, and the dashboard hydrates open meetings on
    // load, so the 3D office kept showing a phantom meeting in session, halo,
    // banner, wall display and all, for a discussion that died days ago.
    // A process that has just started cannot have a meeting in flight, so any
    // open one is by definition abandoned.
    const stranded = this.db
      .prepare(
        `UPDATE agent_conversations SET status = 'closed', closed_at = ?
          WHERE status = 'open' AND kind IN ('meeting', 'debate')`,
      )
      .run(now);
    const closed = stranded?.changes ?? 0;
    if (closed > 0) {
      log.info(`AgentService: closed ${closed} meeting(s) stranded by the last shutdown`);
    }
    return changes;
  }

  // ── Steps ───────────────────────────────────────────

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
    const now = isoNow();
    const step: AgentStep = {
      id: newId(),
      run_id: input.run_id,
      step_number: input.step_number,
      type: input.type,
      content: input.content ?? "",
      tool_name: input.tool_name ?? "",
      tool_input: JSON.stringify(input.tool_input ?? {}),
      tool_output: input.tool_output ?? "",
      tokens: input.tokens ?? 0,
      created_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO agent_run_steps (id, run_id, step_number, type, content,
         tool_name, tool_input, tool_output, tokens, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        step.id, step.run_id, step.step_number, step.type,
        step.content, step.tool_name, step.tool_input, step.tool_output,
        step.tokens, step.created_at,
      );

    return step;
  }

  getSteps(runId: string): AgentStep[] {
    return this.db
      .prepare("SELECT * FROM agent_run_steps WHERE run_id = ? ORDER BY step_number ASC")
      .all(runId) as AgentStep[];
  }

  getRunEvents(runId: string): Array<{ id: string; event_type: string; event_subtype: string; detail: string; raw_data: string; tokens_used: number; duration_ms: number; created_at: string }> {
    return this.db
      .prepare("SELECT id, event_type, event_subtype, detail, raw_data, tokens_used, duration_ms, created_at FROM agent_event_log WHERE run_id = ? ORDER BY created_at ASC")
      .all(runId) as Array<{ id: string; event_type: string; event_subtype: string; detail: string; raw_data: string; tokens_used: number; duration_ms: number; created_at: string }>;
  }

  getAdHocConnections(agentId: string): {
    invokedBy: Array<{ agent_id: string; agent_name: string; count: number; last_at: string }>;
    invoked: Array<{ agent_id: string; agent_name: string; count: number; last_at: string }>;
  } {
    // Who invoked ME (runs where I'm the target and trigger_payload has source_agent_id)
    const invokedByRows = this.db.prepare(
      `SELECT json_extract(trigger_payload, '$.source_agent_id') AS src_id,
              COUNT(*) AS cnt,
              MAX(created_at) AS last_at
       FROM agent_runs
       WHERE agent_id = ? AND trigger_type = 'chain'
         AND json_extract(trigger_payload, '$.source_agent_id') IS NOT NULL
         AND json_extract(trigger_payload, '$.source_agent_id') <> ''
       GROUP BY src_id
       ORDER BY last_at DESC
       LIMIT 20`,
    ).all(agentId) as Array<{ src_id: string; cnt: number; last_at: string }>;

    const invokedBy = invokedByRows.map((r) => {
      const a = this.getAgent(r.src_id);
      return { agent_id: r.src_id, agent_name: a?.name ?? "Unknown", count: r.cnt, last_at: r.last_at };
    });

    // Who did I invoke (tool_call steps with tool_name = kernel_agents_invoke from my runs)
    const invokedRows = this.db.prepare(
      `SELECT json_extract(s.tool_input, '$.agent_id') AS tgt_id,
              COUNT(*) AS cnt,
              MAX(r.created_at) AS last_at
       FROM agent_run_steps s
       JOIN agent_runs r ON r.id = s.run_id
       WHERE r.agent_id = ? AND s.tool_name = 'kernel_agents_invoke'
         AND s.type = 'tool_call'
         AND json_extract(s.tool_input, '$.agent_id') IS NOT NULL
       GROUP BY tgt_id
       ORDER BY last_at DESC
       LIMIT 20`,
    ).all(agentId) as Array<{ tgt_id: string; cnt: number; last_at: string }>;

    const invoked = invokedRows.map((r) => {
      const a = this.getAgent(r.tgt_id);
      return { agent_id: r.tgt_id, agent_name: a?.name ?? "Unknown", count: r.cnt, last_at: r.last_at };
    });

    return { invokedBy, invoked };
  }

  // ── Event Triggers ──────────────────────────────────

  addEventTrigger(input: {
    agent_id: string;
    event_name: string;
    filter?: Record<string, unknown>;
    cooldown_ms?: number;
  }): EventTrigger {
    const now = isoNow();
    const trigger: EventTrigger = {
      id: newId(),
      agent_id: input.agent_id,
      event_name: input.event_name,
      filter: JSON.stringify(input.filter ?? {}),
      cooldown_ms: input.cooldown_ms ?? 60_000,
      last_fired: null,
      active: 1,
      created_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO agent_event_triggers (id, agent_id, event_name, filter,
         cooldown_ms, last_fired, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        trigger.id, trigger.agent_id, trigger.event_name, trigger.filter,
        trigger.cooldown_ms, trigger.last_fired, trigger.active, trigger.created_at,
      );

    this.events.emit("data.changed", { module: "agents", action: "trigger_added" });
    return trigger;
  }

  listEventTriggers(agentId?: string): EventTrigger[] {
    if (agentId) {
      return this.db
        .prepare("SELECT * FROM agent_event_triggers WHERE agent_id = ? ORDER BY created_at DESC")
        .all(agentId) as EventTrigger[];
    }
    return this.db
      .prepare("SELECT * FROM agent_event_triggers ORDER BY created_at DESC")
      .all() as EventTrigger[];
  }

  getActiveEventTriggers(): EventTrigger[] {
    return this.db
      .prepare(
        `SELECT t.* FROM agent_event_triggers t
         JOIN agents a ON t.agent_id = a.id
         WHERE t.active = 1 AND a.active = 1`,
      )
      .all() as EventTrigger[];
  }

  removeEventTrigger(id: string): boolean {
    const result = this.db.prepare("DELETE FROM agent_event_triggers WHERE id = ?").run(id);
    if (result.changes > 0) {
      this.events.emit("data.changed", { module: "agents", action: "trigger_removed" });
      return true;
    }
    return false;
  }

  updateTriggerLastFired(id: string): void {
    this.db
      .prepare("UPDATE agent_event_triggers SET last_fired = ? WHERE id = ?")
      .run(isoNow(), id);
  }

  // ── Schedules ───────────────────────────────────────

  addSchedule(input: {
    agent_id: string;
    interval_ms?: number;
    cron_expression?: string;
    goal_override?: string;
  }): AgentSchedule {
    const now = isoNow();
    const cronExpr = input.cron_expression ?? "";
    const intervalMs = input.interval_ms ?? 0;

    // Rate-limit floor: a schedule firing more often than every 5 minutes is
    // almost always a footgun — it's the cheapest exfil channel an attacker
    // gets if they ever land an agent_create. 5 min is more than enough for
    // human-perceived "near-real-time" workflows. Operators who really need
    // sub-5-min cadence can opt in with KERNEL_AGENT_MIN_SCHEDULE_SECONDS.
    // Prefer live config.agents.minScheduleSeconds (single source of truth,
    // reflects hot-reloaded settings) — fall back to a direct env read only
    // when this instance wasn't constructed with a KernelConfig (demo
    // scripts, older tests).
    const minSeconds = this.config
      ? this.config.agents.minScheduleSeconds
      : Math.max(1, Number(process.env.KERNEL_AGENT_MIN_SCHEDULE_SECONDS ?? 300));
    if (intervalMs > 0 && intervalMs < minSeconds * 1000) {
      throw new Error(
        `agent schedule interval_ms=${intervalMs} is below minimum ${minSeconds * 1000}ms. ` +
        `Raise KERNEL_AGENT_MIN_SCHEDULE_SECONDS to lower the floor (default 300s).`,
      );
    }
    if (cronExpr) {
      // Estimate cadence from two consecutive cron fires.
      try {
        const first = new Date(computeNextCronRun(cronExpr, "UTC"));
        const second = new Date(computeNextCronRun(cronExpr, "UTC", first));
        const deltaMs = second.getTime() - first.getTime();
        if (deltaMs > 0 && deltaMs < minSeconds * 1000) {
          throw new Error(
            `agent schedule cron "${cronExpr}" fires every ${Math.round(deltaMs / 1000)}s, below minimum ${minSeconds}s. ` +
            `Raise KERNEL_AGENT_MIN_SCHEDULE_SECONDS to lower the floor.`,
          );
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("agent schedule cron")) throw e;
        // computeNextCronRun threw because the expression is malformed; let
        // the original code path reject below.
      }
    }

    // Compute initial next_run_at
    let nextRun: string;
    if (cronExpr) {
      nextRun = computeNextCronRun(cronExpr, "UTC");
    } else {
      nextRun = new Date(Date.now() + intervalMs).toISOString();
    }

    const schedule: AgentSchedule = {
      id: newId(),
      agent_id: input.agent_id,
      interval_ms: intervalMs,
      cron_expression: cronExpr,
      goal_override: input.goal_override ?? "",
      next_run_at: nextRun,
      last_run_at: null,
      active: 1,
      created_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO agent_schedules (id, agent_id, interval_ms, cron_expression, goal_override,
         next_run_at, last_run_at, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        schedule.id, schedule.agent_id, schedule.interval_ms, schedule.cron_expression,
        schedule.goal_override, schedule.next_run_at, schedule.last_run_at,
        schedule.active, schedule.created_at,
      );

    this.events.emit("data.changed", { module: "agents", action: "schedule_added" });
    return schedule;
  }

  listSchedules(agentId?: string): AgentSchedule[] {
    if (agentId) {
      return this.db
        .prepare("SELECT * FROM agent_schedules WHERE agent_id = ? ORDER BY created_at DESC")
        .all(agentId) as AgentSchedule[];
    }
    return this.db
      .prepare("SELECT * FROM agent_schedules ORDER BY created_at DESC")
      .all() as AgentSchedule[];
  }

  getDueSchedules(): Array<AgentSchedule & { agent_name: string }> {
    const now = isoNow();
    return this.db
      .prepare(
        `SELECT s.*, a.name as agent_name
         FROM agent_schedules s
         JOIN agents a ON s.agent_id = a.id
         WHERE s.next_run_at <= ? AND s.active = 1 AND a.active = 1`,
      )
      .all(now) as Array<AgentSchedule & { agent_name: string }>;
  }

  removeSchedule(id: string): boolean {
    const result = this.db.prepare("DELETE FROM agent_schedules WHERE id = ?").run(id);
    if (result.changes > 0) {
      this.events.emit("data.changed", { module: "agents", action: "schedule_removed" });
      return true;
    }
    return false;
  }

  updateScheduleNextRun(id: string, nextRunAt: string, lastRunAt: string): void {
    this.db
      .prepare("UPDATE agent_schedules SET next_run_at = ?, last_run_at = ? WHERE id = ?")
      .run(nextRunAt, lastRunAt, id);
  }

  // NOTE: `deactivateSchedule()` lived here for the old in-memory circuit
  // breaker, its only caller. The breaker now pauses the AGENT
  // (`recordRunOutcome`) and deliberately leaves the schedule row alone, so
  // reactivating an agent resumes it without having to repair its cron too.

  // ── Feedback ──────────────────────────────────────

  addFeedback(input: {
    agent_id: string;
    run_id: string;
    rating: number;
    outcome?: AgentFeedback["outcome"];
    lesson?: string;
  }): AgentFeedback {
    const now = isoNow();
    const feedback: AgentFeedback = {
      id: newId(),
      agent_id: input.agent_id,
      run_id: input.run_id,
      rating: input.rating,
      outcome: input.outcome ?? "neutral",
      lesson: input.lesson ?? "",
      created_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO agent_feedback (id, agent_id, run_id, rating, outcome, lesson, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        feedback.id, feedback.agent_id, feedback.run_id,
        feedback.rating, feedback.outcome, feedback.lesson, feedback.created_at,
      );

    // Reinforce or penalize learnings that were active during the run.
    // This closes the feedback loop: repeated-success learnings gain confidence,
    // learnings that guided failures get downweighted and eventually deactivated.
    const run = this.getRun(input.run_id);
    if (run) {
      this.reinforceLearningsForRun(input.agent_id, run.created_at, feedback.outcome);
    }

    this.events.emit("data.changed", { module: "agents", action: "feedback_added" });
    return feedback;
  }

  getFeedback(agentId: string, limit = 20): AgentFeedback[] {
    return this.db
      .prepare("SELECT * FROM agent_feedback WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(agentId, limit) as AgentFeedback[];
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
    // Aggregate in SQL — loading every run row into memory grew unbounded with
    // an agent's history (called on every invocation).
    const agg = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
                COALESCE(SUM(tokens_used), 0) AS sum_tokens,
                COALESCE(SUM(steps_count), 0) AS sum_steps
         FROM agent_runs WHERE agent_id = ?`,
      )
      .get(agentId) as { total: number; completed: number; failed: number; sum_tokens: number; sum_steps: number };

    const completed = agg.completed ?? 0;
    const failed = agg.failed ?? 0;
    const total = agg.total ?? 0;

    const avgRatingRow = this.db
      .prepare("SELECT AVG(rating) as avg FROM agent_feedback WHERE agent_id = ?")
      .get(agentId) as { avg: number | null } | undefined;

    const avgTokens = total > 0 ? agg.sum_tokens / total : 0;
    const avgSteps = total > 0 ? agg.sum_steps / total : 0;

    // Top tools used across all runs
    const toolRows = this.db
      .prepare(
        `SELECT s.tool_name, COUNT(*) as cnt
         FROM agent_run_steps s
         JOIN agent_runs r ON s.run_id = r.id
         WHERE r.agent_id = ? AND s.type = 'tool_call' AND s.tool_name <> ''
         GROUP BY s.tool_name ORDER BY cnt DESC LIMIT 10`,
      )
      .all(agentId) as Array<{ tool_name: string; cnt: number }>;

    // Common errors from failed runs
    const errorRows = this.db
      .prepare(
        `SELECT error FROM agent_runs WHERE agent_id = ? AND status = 'failed' AND error <> ''
         ORDER BY created_at DESC LIMIT 5`,
      )
      .all(agentId) as Array<{ error: string }>;

    return {
      total_runs: total,
      completed,
      failed,
      avg_rating: avgRatingRow?.avg ?? null,
      avg_tokens: Math.round(avgTokens),
      avg_steps: Math.round(avgSteps * 10) / 10,
      success_rate: total > 0 ? Math.round((completed / total) * 100) : 0,
      top_tools: toolRows.map(r => ({ tool: r.tool_name, count: r.cnt })),
      common_errors: errorRows.map(r => r.error.slice(0, 200)),
    };
  }

  // ── Learnings ─────────────────────────────────────

  addLearning(input: {
    agent_id: string;
    type: AgentLearning["type"];
    content: string;
    confidence?: number;
    source_runs?: string[];
  }): AgentLearning {
    const now = isoNow();
    const learning: AgentLearning = {
      id: newId(),
      agent_id: input.agent_id,
      type: input.type,
      content: input.content,
      confidence: input.confidence ?? 0.5,
      source_runs: JSON.stringify(input.source_runs ?? []),
      active: 1,
      created_at: now,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO agent_learnings (id, agent_id, type, content, confidence, source_runs, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        learning.id, learning.agent_id, learning.type, learning.content,
        learning.confidence, learning.source_runs, learning.active,
        learning.created_at, learning.updated_at,
      );

    this.scheduleEmbed("agent_learnings", "embedding", "embedding_model", learning.id, learning.content);
    return learning;
  }

  getLearnings(agentId: string): AgentLearning[] {
    return this.db
      .prepare("SELECT * FROM agent_learnings WHERE agent_id = ? AND active = 1 ORDER BY confidence DESC")
      .all(agentId) as AgentLearning[];
  }

  // ── Conversational Memory ─────────────────────────

  /** Save a message to agent's conversational memory */
  addMemory(agentId: string, role: "user" | "assistant", content: string, runId = ""): void {
    const id = newId();
    this.db.prepare(
      "INSERT INTO agent_memory (id, agent_id, role, content, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(id, agentId, role, content, runId, isoNow());
    this.scheduleEmbed("agent_memory", "embedding", "embedding_model", id, content);
  }

  /** Get recent conversational memory for an agent (last N exchanges) */
  getMemory(agentId: string, limit = 20): Array<{ role: string; content: string; created_at: string }> {
    return this.db
      .prepare("SELECT role, content, created_at FROM agent_memory WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(agentId, limit) as Array<{ role: string; content: string; created_at: string }>;
  }

  /** Clear all memory for an agent */
  clearMemory(agentId: string): void {
    this.db.prepare("DELETE FROM agent_memory WHERE agent_id = ?").run(agentId);
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

  /**
   * Get memory items ranked by relevance to a goal. When the agent has >limit
   * items, prefers those with keyword overlap to the current goal; falls back
   * to recency. Replaces blind last-N slicing with purposeful recall.
   */
  getRelevantMemory(
    agentId: string,
    goal: string,
    limit = 20,
    pool = 100,
  ): Array<{ role: string; content: string; created_at: string }> {
    const recent = this.getMemory(agentId, pool);
    return rankByRelevance(recent, goal, m => m.content, limit);
  }

  /**
   * Embedding-aware variant of getRelevantMemory. Reads pre-computed
   * vectors written by scheduleEmbed(); rows whose embedding hasn't landed
   * yet (or failed) participate via lexical-only score, so the ranker is
   * always usable regardless of backfill state.
   */
  getRelevantMemoryByEmbedding(
    agentId: string,
    goal: string,
    goalVector: number[],
    limit = 20,
    pool = 100,
    cosineWeight?: number,
    minScore?: number,
  ): Array<{ role: string; content: string; created_at: string }> {
    const rows = this.db
      .prepare(
        `SELECT role, content, created_at, embedding
         FROM agent_memory WHERE agent_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(agentId, pool) as Array<{
        role: string;
        content: string;
        created_at: string;
        embedding: Buffer | Uint8Array | null;
      }>;
    const items = rows.map(r => ({
      role: r.role,
      content: r.content,
      created_at: r.created_at,
      embedding: blobToVector(r.embedding),
    }));
    return rankByEmbedding(items, goalVector, goal, m => m.content, limit, cosineWeight, minScore)
      .map(({ role, content, created_at }) => ({ role, content, created_at }));
  }

  /**
   * Find past runs of this agent whose goals are similar to the current one.
   * Used to inject "when you did X you got Y" context into the prompt.
   */
  findSimilarPastRuns(
    agentId: string,
    goal: string,
    limit = 3,
    pool = 30,
  ): AgentRun[] {
    const recent = this.db
      .prepare(
        `SELECT * FROM agent_runs
         WHERE agent_id = ? AND status IN ('completed', 'failed')
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(agentId, pool) as AgentRun[];
    // Match against goal text; skip runs with empty goals.
    const filtered = recent.filter(r => r.goal && r.goal.length > 0);
    return rankByRelevance(filtered, goal, r => r.goal, limit, 0.1);
  }

  /** Embedding-aware variant of findSimilarPastRuns. */
  findSimilarPastRunsByEmbedding(
    agentId: string,
    goal: string,
    goalVector: number[],
    limit = 3,
    pool = 30,
    cosineWeight?: number,
    minScore?: number,
  ): AgentRun[] {
    const rows = this.db
      .prepare(
        `SELECT *, goal_embedding FROM agent_runs
         WHERE agent_id = ? AND status IN ('completed', 'failed')
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(agentId, pool) as Array<AgentRun & { goal_embedding: Buffer | Uint8Array | null }>;
    const filtered = rows
      .filter(r => r.goal && r.goal.length > 0)
      .map(r => ({ ...r, embedding: blobToVector(r.goal_embedding) }));
    const ranked = rankByEmbedding(filtered, goalVector, goal, r => r.goal, limit, cosineWeight, minScore);
    // Strip the helper columns we attached for ranking — restore the AgentRun shape.
    return ranked.map(r => {
      const { embedding: _e, goal_embedding: _ge, ...rest } = r;
      return rest as AgentRun;
    });
  }

  /**
   * Get learnings ranked by relevance to the current goal. Within each
   * relevance tier, prefers higher confidence. Prevents irrelevant learnings
   * (e.g. "avoid X" when agent isn't doing X) from hogging the prompt.
   */
  getRelevantLearnings(
    agentId: string,
    goal: string,
    limit = 15,
  ): AgentLearning[] {
    const all = this.getLearnings(agentId);
    if (all.length <= limit) return all;
    // Rank by relevance; ties broken by confidence (already sorted desc by getLearnings)
    return rankByRelevance(all, goal, l => l.content, limit);
  }

  /**
   * Embedding-aware variant of getRelevantLearnings. minScore defaults are
   * higher than for memory because learnings are more structured (auto-eval
   * lessons), so cosine scores cluster higher.
   */
  getRelevantLearningsByEmbedding(
    agentId: string,
    goal: string,
    goalVector: number[],
    limit = 15,
    cosineWeight?: number,
    minScore?: number,
  ): AgentLearning[] {
    const rows = this.db
      .prepare(
        `SELECT *, embedding FROM agent_learnings
         WHERE agent_id = ? AND active = 1
         ORDER BY confidence DESC`,
      )
      .all(agentId) as Array<AgentLearning & { embedding: Buffer | Uint8Array | null }>;
    if (rows.length <= limit) return rows.map(({ embedding: _, ...rest }) => rest as AgentLearning);
    const items = rows.map(r => ({ ...r, embedding: blobToVector(r.embedding) }));
    return rankByEmbedding(items, goalVector, goal, l => l.content, limit, cosineWeight, minScore ?? 0.45)
      .map(({ embedding: _, ...rest }) => rest as AgentLearning);
  }

  updateLearningConfidence(id: string, delta: number): void {
    const learning = this.db
      .prepare("SELECT confidence FROM agent_learnings WHERE id = ?")
      .get(id) as { confidence: number } | undefined;
    if (!learning) return;

    const newConf = Math.max(0, Math.min(1, learning.confidence + delta));
    this.db
      .prepare("UPDATE agent_learnings SET confidence = ?, updated_at = ? WHERE id = ?")
      .run(newConf, isoNow(), id);
  }

  deactivateLearning(id: string): void {
    this.db
      .prepare("UPDATE agent_learnings SET active = 0, updated_at = ? WHERE id = ?")
      .run(isoNow(), id);
  }

  /**
   * Get learnings that were active (and would have been injected into prompt)
   * at the time a given run started. Used to attribute run outcomes back to learnings.
   */
  getLearningsActiveAt(agentId: string, referenceTime: string): AgentLearning[] {
    return this.db
      .prepare(
        `SELECT * FROM agent_learnings
         WHERE agent_id = ? AND active = 1 AND created_at < ?
         ORDER BY confidence DESC LIMIT 15`,
      )
      .all(agentId, referenceTime) as AgentLearning[];
  }

  /**
   * Given a run outcome, adjust confidence of learnings that were active during it.
   * Success boosts confidence, failure penalizes it. Learnings below 0.15 get deactivated.
   * Returns count of learnings updated / deactivated.
   */
  reinforceLearningsForRun(
    agentId: string,
    runCreatedAt: string,
    outcome: "success" | "partial" | "failure" | "neutral",
  ): { updated: number; deactivated: number } {
    const delta =
      outcome === "success" ? 0.08
      : outcome === "partial" ? 0.02
      : outcome === "failure" ? -0.15
      : 0;
    if (delta === 0) return { updated: 0, deactivated: 0 };

    const learnings = this.getLearningsActiveAt(agentId, runCreatedAt);
    let updated = 0;
    let deactivated = 0;
    for (const l of learnings) {
      this.updateLearningConfidence(l.id, delta);
      updated++;
      // Re-fetch to check new confidence
      const fresh = this.db
        .prepare("SELECT confidence FROM agent_learnings WHERE id = ?")
        .get(l.id) as { confidence: number } | undefined;
      if (fresh && fresh.confidence < 0.15) {
        this.deactivateLearning(l.id);
        deactivated++;
      }
    }
    return { updated, deactivated };
  }

  /**
   * Periodic cleanup: deactivate learnings below minConfidence threshold.
   * Returns count deactivated.
   */
  cleanupLowConfidenceLearnings(agentId: string, minConfidence = 0.15): number {
    const result = this.db
      .prepare(
        `UPDATE agent_learnings SET active = 0, updated_at = ?
         WHERE agent_id = ? AND active = 1 AND confidence < ?`,
      )
      .run(isoNow(), agentId, minConfidence);
    return result.changes as number;
  }

  // ── Conversations & messages (generic inter-agent thread) ────────────

  /**
   * Normalise a free-form topic into a stable hash used to dedup conversations
   * and lock debate cooldowns. Keep it simple (lowercase + strip punctuation +
   * collapse whitespace + clip). Good enough until we bolt on embeddings.
   */
  static computeTopicHash(topic: string): string {
    const normalised = (topic || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length >= 3 && !TOPIC_STOPWORDS.has(w))
      .slice(0, 16)
      .sort()
      .join("-");
    return normalised.slice(0, 200);
  }

  createConversation(input: {
    kind: "chat" | "meeting" | "debate";
    topic: string;
    participants: string[];
    initiator_agent_id: string;
    parent_conversation_id?: string;
    meta?: Record<string, unknown>;
  }): AgentConversation {
    const now = isoNow();
    const convo: AgentConversation = {
      id: newId(),
      kind: input.kind,
      topic: input.topic.slice(0, 500),
      topic_hash: AgentService.computeTopicHash(input.topic),
      participants: JSON.stringify([...new Set(input.participants)]),
      initiator_agent_id: input.initiator_agent_id,
      parent_conversation_id: input.parent_conversation_id ?? "",
      status: "open",
      meta: JSON.stringify(input.meta ?? {}),
      created_at: now,
      updated_at: now,
      closed_at: null,
    };
    this.db
      .prepare(
        `INSERT INTO agent_conversations
          (id, kind, topic, topic_hash, participants, initiator_agent_id,
           parent_conversation_id, status, meta, created_at, updated_at, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        convo.id, convo.kind, convo.topic, convo.topic_hash, convo.participants,
        convo.initiator_agent_id, convo.parent_conversation_id, convo.status,
        convo.meta, convo.created_at, convo.updated_at, convo.closed_at,
      );
    this.events.emit("agent:conversation:opened", {
      conversation_id: convo.id, kind: convo.kind, topic: convo.topic,
      participants: JSON.parse(convo.participants), initiator: convo.initiator_agent_id,
    });
    return convo;
  }

  getConversation(id: string): AgentConversation | undefined {
    if (!id) return undefined;
    return this.db
      .prepare("SELECT * FROM agent_conversations WHERE id = ?")
      .get(id) as AgentConversation | undefined;
  }

  /**
   * Find an open chat with the given participant set (order-insensitive) and
   * matching topic_hash. If none, create one. Used by postToColleague to keep
   * related back-and-forth mail in a single thread.
   */
  findOrCreateChatConversation(input: {
    topic: string;
    participants: string[];
    initiator_agent_id: string;
  }): AgentConversation {
    const hash = AgentService.computeTopicHash(input.topic);
    const participantsSorted = [...new Set(input.participants)].sort();
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_conversations
          WHERE kind = 'chat' AND status = 'open' AND topic_hash = ?
          ORDER BY created_at DESC
          LIMIT 20`,
      )
      .all(hash) as AgentConversation[];
    for (const row of rows) {
      const current = this.parseParticipants(row).slice().sort();
      if (current.length === participantsSorted.length &&
          current.every((id, i) => id === participantsSorted[i])) {
        return row;
      }
    }
    return this.createConversation({
      kind: "chat",
      topic: input.topic,
      participants: input.participants,
      initiator_agent_id: input.initiator_agent_id,
    });
  }

  listConversations(opts?: {
    agent_id?: string;
    kind?: "chat" | "meeting" | "debate";
    status?: "open" | "closed";
    /** Hide rows whose meta.archived is truthy. Default true so the dashboard
     *  doesn't keep re-surfacing meetings the user already dismissed. */
    excludeArchived?: boolean;
    limit?: number;
  }): AgentConversation[] {
    let sql = "SELECT * FROM agent_conversations WHERE 1=1";
    const params: unknown[] = [];
    if (opts?.kind) { sql += " AND kind = ?"; params.push(opts.kind); }
    if (opts?.status) { sql += " AND status = ?"; params.push(opts.status); }
    if (opts?.agent_id) {
      // participants is a JSON array of IDs — LIKE match is safe because IDs
      // are UUIDs and never appear as substrings of one another.
      sql += " AND participants LIKE ?";
      params.push(`%"${opts.agent_id}"%`);
    }
    // Default to excluding archived. The dashboard can opt back in by
    // passing excludeArchived=false explicitly.
    const excludeArchived = opts?.excludeArchived !== false;
    if (excludeArchived) {
      // SQLite has no native JSON ops at this version, so a substring filter
      // on the serialized meta column is good enough for a flag.
      sql += " AND meta NOT LIKE ?";
      params.push('%"archived":true%');
    }
    sql += " ORDER BY updated_at DESC";
    sql += ` LIMIT ${Math.max(1, Math.min(opts?.limit ?? 50, 500))}`;
    return this.db.prepare(sql).all(...params) as AgentConversation[];
  }

  closeConversation(id: string): void {
    const now = isoNow();
    this.db
      .prepare("UPDATE agent_conversations SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?")
      .run(now, now, id);
    this.events.emit("agent:conversation:closed", { conversation_id: id });
  }

  /**
   * Mark a conversation as archived (soft hide). Re-merges into the existing
   * meta JSON so other meta keys aren't blown away. Idempotent. Returns true
   * if the row existed and was updated.
   */
  archiveConversation(id: string): boolean {
    const convo = this.getConversation(id);
    if (!convo) return false;
    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(convo.meta || "{}"); } catch { meta = {}; }
    meta.archived = true;
    meta.archived_at = isoNow();
    this.db
      .prepare("UPDATE agent_conversations SET meta = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(meta), isoNow(), id);
    this.events.emit("agent:conversation:archived", { conversation_id: id });
    return true;
  }

  /**
   * Bulk-archive every closed conversation matching the filters. Used by the
   * dashboard's "clear all read" button to clean out the meeting history in
   * one shot.
   */
  archiveClosedConversations(opts?: { kind?: "chat" | "meeting" | "debate" }): number {
    let sql = "SELECT id, meta FROM agent_conversations WHERE status = 'closed' AND meta NOT LIKE ?";
    const params: unknown[] = ['%"archived":true%'];
    if (opts?.kind) { sql += " AND kind = ?"; params.push(opts.kind); }
    const rows = this.db.prepare(sql).all(...params) as Array<{ id: string; meta: string }>;
    let count = 0;
    for (const r of rows) {
      if (this.archiveConversation(r.id)) count++;
    }
    return count;
  }

  parseParticipants(convo: AgentConversation): string[] {
    try {
      const raw = JSON.parse(convo.participants || "[]");
      return Array.isArray(raw) ? raw.filter((x: unknown): x is string => typeof x === "string") : [];
    } catch { return []; }
  }

  addParticipant(conversationId: string, agentId: string): void {
    const convo = this.getConversation(conversationId);
    if (!convo) return;
    const current = this.parseParticipants(convo);
    if (current.includes(agentId)) return;
    current.push(agentId);
    this.db
      .prepare("UPDATE agent_conversations SET participants = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(current), isoNow(), conversationId);
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
    const msg: AgentMessage = {
      id: newId(),
      conversation_id: input.conversation_id,
      from_agent_id: input.from_agent_id,
      to_agent_id: input.to_agent_id ?? "",
      role: input.role ?? "stmt",
      in_reply_to: input.in_reply_to ?? "",
      body: input.body,
      tokens: input.tokens ?? 0,
      run_id: input.run_id ?? "",
      meta: JSON.stringify(input.meta ?? {}),
      created_at: isoNow(),
    };
    this.db
      .prepare(
        `INSERT INTO agent_messages
          (id, conversation_id, from_agent_id, to_agent_id, role, in_reply_to,
           body, tokens, run_id, meta, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        msg.id, msg.conversation_id, msg.from_agent_id, msg.to_agent_id, msg.role,
        msg.in_reply_to, msg.body, msg.tokens, msg.run_id, msg.meta, msg.created_at,
      );
    this.db
      .prepare("UPDATE agent_conversations SET updated_at = ? WHERE id = ?")
      .run(msg.created_at, msg.conversation_id);
    this.events.emit("agent:conversation:message_posted", {
      conversation_id: msg.conversation_id,
      message_id: msg.id,
      from_agent_id: msg.from_agent_id,
      to_agent_id: msg.to_agent_id,
      role: msg.role,
      in_reply_to: msg.in_reply_to,
    });
    return msg;
  }

  getMessage(id: string): AgentMessage | undefined {
    if (!id) return undefined;
    return this.db
      .prepare("SELECT * FROM agent_messages WHERE id = ?")
      .get(id) as AgentMessage | undefined;
  }

  listMessages(conversationId: string, opts?: {
    limit?: number;
    role?: AgentMessageRole;
  }): AgentMessage[] {
    let sql = "SELECT * FROM agent_messages WHERE conversation_id = ?";
    const params: unknown[] = [conversationId];
    if (opts?.role) { sql += " AND role = ?"; params.push(opts.role); }
    sql += " ORDER BY created_at ASC";
    sql += ` LIMIT ${Math.max(1, Math.min(opts?.limit ?? 200, 1000))}`;
    return this.db.prepare(sql).all(...params) as AgentMessage[];
  }

  /**
   * Return {distinctCounterSenders, counterMessages} for a conversation.
   * Used by the debate orchestrator to decide whether to auto-open a debate.
   */
  getCounterStats(conversationId: string): {
    distinct_senders: string[];
    counters: AgentMessage[];
  } {
    const counters = this.db
      .prepare(
        `SELECT * FROM agent_messages
          WHERE conversation_id = ? AND role = 'counter'
          ORDER BY created_at ASC`,
      )
      .all(conversationId) as AgentMessage[];
    const distinct = Array.from(new Set(counters.map(m => m.from_agent_id)));
    return { distinct_senders: distinct, counters };
  }

  // ── Debate cooldown register ─────────────────────────

  getDebateCooldown(topicHash: string): AgentDebateCooldown | undefined {
    if (!topicHash) return undefined;
    return this.db
      .prepare("SELECT * FROM agent_debate_cooldowns WHERE topic_hash = ?")
      .get(topicHash) as AgentDebateCooldown | undefined;
  }

  recordDebateCooldown(topicHash: string, debateConvId: string): void {
    const now = isoNow();
    this.db
      .prepare(
        `INSERT INTO agent_debate_cooldowns (topic_hash, debate_conv_id, opened_at, closed_at)
         VALUES (?, ?, ?, NULL)
         ON CONFLICT(topic_hash) DO UPDATE SET
           debate_conv_id = excluded.debate_conv_id,
           opened_at = excluded.opened_at,
           closed_at = NULL`,
      )
      .run(topicHash, debateConvId, now);
  }

  countRecentAutoDebates(sinceIsoTimestamp: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM agent_debate_cooldowns WHERE opened_at >= ?")
      .get(sinceIsoTimestamp) as { c: number } | undefined;
    return row?.c ?? 0;
  }

  // ── Chains ──────────────────────────────────────

  addChain(input: {
    source_agent_id: string;
    target_agent_id: string;
    label?: string;
    condition?: Record<string, unknown>;
    pass_result?: boolean;
    delay_ms?: number;
  }): AgentChain {
    if (input.source_agent_id === input.target_agent_id) {
      throw new Error("Cannot chain an agent to itself");
    }

    const now = isoNow();
    const chain: AgentChain = {
      id: newId(),
      source_agent_id: input.source_agent_id,
      target_agent_id: input.target_agent_id,
      label: input.label ?? "",
      condition: JSON.stringify(input.condition ?? {}),
      pass_result: input.pass_result !== false ? 1 : 0,
      delay_ms: input.delay_ms ?? 0,
      active: 1,
      created_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO agent_chains (id, source_agent_id, target_agent_id, label,
         condition, pass_result, delay_ms, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        chain.id, chain.source_agent_id, chain.target_agent_id,
        chain.label, chain.condition, chain.pass_result,
        chain.delay_ms, chain.active, chain.created_at,
      );

    this.events.emit("data.changed", { module: "agents", action: "chain_added" });
    return chain;
  }

  listChains(agentId?: string): AgentChain[] {
    if (agentId) {
      return this.db
        .prepare(
          `SELECT * FROM agent_chains
           WHERE (source_agent_id = ? OR target_agent_id = ?) AND active = 1
           ORDER BY created_at DESC`,
        )
        .all(agentId, agentId) as AgentChain[];
    }
    return this.db
      .prepare("SELECT * FROM agent_chains WHERE active = 1 ORDER BY created_at DESC")
      .all() as AgentChain[];
  }

  getChainsBySource(sourceId: string): AgentChain[] {
    return this.db
      .prepare("SELECT * FROM agent_chains WHERE source_agent_id = ? AND active = 1")
      .all(sourceId) as AgentChain[];
  }

  removeChain(id: string): boolean {
    const exists = this.db.prepare("SELECT id FROM agent_chains WHERE id = ?").get(id);
    if (!exists) return false;
    this.db.prepare("DELETE FROM agent_chains WHERE id = ?").run(id);
    this.events.emit("data.changed", { module: "agents", action: "chain_removed" });
    return true;
  }

  // ── Event Log ─────────────────────────────────────

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
    const id = newId();
    const now = isoNow();
    this.db
      .prepare(
        `INSERT INTO agent_event_log (id, run_id, agent_id, agent_name, event_type, event_subtype, detail, raw_data, tokens_used, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        data.run_id ?? "",
        data.agent_id ?? "",
        data.agent_name ?? "",
        data.event_type,
        data.event_subtype ?? "",
        data.detail ?? "",
        JSON.stringify(data.raw_data ?? {}),
        data.tokens_used ?? 0,
        data.duration_ms ?? 0,
        now,
      );

    // Mirror every structured event to stdout in pretty colored form.
    writeAgentEvent(data);
  }

  getEventLog(opts?: {
    run_id?: string;
    agent_id?: string;
    event_type?: string;
    limit?: number;
    offset?: number;
    since?: string;
  }): unknown[] {
    let sql = "SELECT * FROM agent_event_log WHERE 1=1";
    const params: unknown[] = [];

    if (opts?.run_id) { sql += " AND run_id = ?"; params.push(opts.run_id); }
    if (opts?.agent_id) { sql += " AND agent_id = ?"; params.push(opts.agent_id); }
    if (opts?.event_type) { sql += " AND event_type = ?"; params.push(opts.event_type); }
    if (opts?.since) { sql += " AND created_at >= ?"; params.push(opts.since); }

    sql += " ORDER BY created_at DESC";

    const limit = opts?.limit ?? 200;
    const offset = opts?.offset ?? 0;
    sql += " LIMIT ? OFFSET ?";
    params.push(limit, offset);

    return this.db.prepare(sql).all(...params);
  }

  getEventLogCount(opts?: {
    run_id?: string;
    agent_id?: string;
    event_type?: string;
    since?: string;
  }): number {
    let sql = "SELECT COUNT(*) as cnt FROM agent_event_log WHERE 1=1";
    const params: unknown[] = [];

    if (opts?.run_id) { sql += " AND run_id = ?"; params.push(opts.run_id); }
    if (opts?.agent_id) { sql += " AND agent_id = ?"; params.push(opts.agent_id); }
    if (opts?.event_type) { sql += " AND event_type = ?"; params.push(opts.event_type); }
    if (opts?.since) { sql += " AND created_at >= ?"; params.push(opts.since); }

    const row = this.db.prepare(sql).get(...params) as { cnt: number };
    return row.cnt;
  }

  clearEventLog(opts?: { before?: string; agent_id?: string }): number {
    let sql = "DELETE FROM agent_event_log WHERE 1=1";
    const params: unknown[] = [];

    if (opts?.before) { sql += " AND created_at < ?"; params.push(opts.before); }
    if (opts?.agent_id) { sql += " AND agent_id = ?"; params.push(opts.agent_id); }

    const result = this.db.prepare(sql).run(...params);
    return result.changes;
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

  private writePromptVersion(v: Omit<AgentPromptVersion, "id"> & { id?: string }): AgentPromptVersion {
    const row: AgentPromptVersion = {
      id: v.id ?? newId(),
      agent_id: v.agent_id,
      version: v.version,
      system_prompt: v.system_prompt,
      goal_template: v.goal_template,
      parent_version: v.parent_version,
      source: v.source,
      note: v.note,
      active: v.active,
      created_at: v.created_at,
    };
    this.db
      .prepare(
        `INSERT INTO agent_prompt_versions
          (id, agent_id, version, system_prompt, goal_template, parent_version, source, note, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.agent_id, row.version, row.system_prompt, row.goal_template,
        row.parent_version, row.source, row.note, row.active, row.created_at,
      );
    return row;
  }

  /** Next free version number for an agent (always monotonically increasing). */
  private nextPromptVersion(agentId: string): number {
    const row = this.db
      .prepare("SELECT MAX(version) AS v FROM agent_prompt_versions WHERE agent_id = ?")
      .get(agentId) as { v: number | null } | undefined;
    return (row?.v ?? 0) + 1;
  }

  /**
   * Append a new prompt version. When `activate: true` (default), any prior
   * version is deactivated and this one becomes the live snapshot. When
   * `activate: false`, the new row is saved as a candidate — useful for the
   * reflection optimizer while a candidate is being evaluated.
   */
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
    const agent = this.getAgent(agentId);
    if (!agent) return null;
    const parent = input.parent_version ?? (this.getActivePromptVersion(agentId)?.version ?? 0);
    const version = this.nextPromptVersion(agentId);
    const activate = input.activate !== false;
    if (activate) {
      this.db.prepare("UPDATE agent_prompt_versions SET active = 0 WHERE agent_id = ?").run(agentId);
    }
    return this.writePromptVersion({
      agent_id: agentId,
      version,
      system_prompt: input.system_prompt,
      goal_template: input.goal_template,
      parent_version: parent,
      source: input.source,
      note: input.note ?? "",
      active: activate ? 1 : 0,
      created_at: isoNow(),
    });
  }

  /**
   * Flip an existing version (by number) into the active slot without
   * creating new lineage rows. Used by the reflection optimizer's Commit
   * step to activate a previously-written candidate.
   */
  activatePromptVersion(agentId: string, version: number): AgentPromptVersion | null {
    const target = this.getPromptVersion(agentId, version);
    if (!target) return null;
    this.db.prepare("UPDATE agent_prompt_versions SET active = 0 WHERE agent_id = ?").run(agentId);
    this.db
      .prepare("UPDATE agent_prompt_versions SET active = 1 WHERE agent_id = ? AND version = ?")
      .run(agentId, version);
    this.db
      .prepare("UPDATE agents SET system_prompt = ?, goal_template = ?, updated_at = ? WHERE id = ?")
      .run(target.system_prompt, target.goal_template, isoNow(), agentId);
    this.events.emit("data.changed", { module: "agents", action: "prompt_activated" });
    return this.getPromptVersion(agentId, version) ?? null;
  }

  listPromptVersions(agentId: string, limit = 50): AgentPromptVersion[] {
    return this.db
      .prepare(
        `SELECT * FROM agent_prompt_versions
         WHERE agent_id = ? ORDER BY version DESC LIMIT ?`,
      )
      .all(agentId, limit) as AgentPromptVersion[];
  }

  getPromptVersion(agentId: string, version: number): AgentPromptVersion | undefined {
    return this.db
      .prepare("SELECT * FROM agent_prompt_versions WHERE agent_id = ? AND version = ?")
      .get(agentId, version) as AgentPromptVersion | undefined;
  }

  getActivePromptVersion(agentId: string): AgentPromptVersion | undefined {
    return this.db
      .prepare("SELECT * FROM agent_prompt_versions WHERE agent_id = ? AND active = 1")
      .get(agentId) as AgentPromptVersion | undefined;
  }

  /**
   * Restore a historical version into the live agent row. Creates a new
   * version entry (source='restore') pointing at the restored one as parent,
   * so the lineage never loses information.
   */
  restorePromptVersion(agentId: string, version: number, note = ""): AgentPromptVersion | null {
    const target = this.getPromptVersion(agentId, version);
    if (!target) return null;
    const agent = this.getAgent(agentId);
    if (!agent) return null;
    // Apply to live agent, then record as a new version.
    this.db
      .prepare("UPDATE agents SET system_prompt = ?, goal_template = ?, updated_at = ? WHERE id = ?")
      .run(target.system_prompt, target.goal_template, isoNow(), agentId);
    const snapshot = this.snapshotPrompt(agentId, {
      system_prompt: target.system_prompt,
      goal_template: target.goal_template,
      source: "restore",
      note: note || `restored from v${version}`,
      parent_version: version,
    });
    this.events.emit("data.changed", { module: "agents", action: "prompt_restored" });
    return snapshot;
  }

  /**
   * Extremely small line-level diff for UI — not a full LCS, just a marker
   * of which lines are common/removed/added. Good enough to render a side-by-side.
   */
  diffPromptVersions(
    agentId: string,
    fromVersion: number,
    toVersion: number,
  ): { from: AgentPromptVersion; to: AgentPromptVersion; lines: Array<{ kind: "same" | "added" | "removed"; text: string }> } | null {
    const from = this.getPromptVersion(agentId, fromVersion);
    const to = this.getPromptVersion(agentId, toVersion);
    if (!from || !to) return null;
    const a = from.system_prompt.split("\n");
    const b = to.system_prompt.split("\n");
    const aSet = new Set(a);
    const bSet = new Set(b);
    const lines: Array<{ kind: "same" | "added" | "removed"; text: string }> = [];
    for (const line of a) {
      if (bSet.has(line)) lines.push({ kind: "same", text: line });
      else lines.push({ kind: "removed", text: line });
    }
    for (const line of b) {
      if (!aSet.has(line)) lines.push({ kind: "added", text: line });
    }
    return { from, to, lines };
  }

  // ── Evolution runs (Autogenesis SEPL) ───────────────────

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
    const row: AgentEvolutionRun = {
      id: newId(),
      agent_id: input.agent_id,
      target: input.target ?? "prompt",
      workspace_id: input.workspace_id ?? "",
      artifact_ref: input.artifact_ref ?? "",
      base_version: input.base_version,
      candidate_version: 0,
      hypothesis: input.hypothesis,
      proposal: input.proposal,
      status: "proposed",
      baseline_score: 0,
      candidate_score: 0,
      trigger_run_ids: JSON.stringify(input.trigger_run_ids ?? []),
      evaluation: "",
      error: "",
      created_at: isoNow(),
      committed_at: null,
    };
    this.db
      .prepare(
        `INSERT INTO agent_evolution_runs
          (id, agent_id, target, workspace_id, artifact_ref,
           base_version, candidate_version, hypothesis, proposal, status,
           baseline_score, candidate_score, trigger_run_ids, evaluation, error,
           created_at, committed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.agent_id, row.target, row.workspace_id, row.artifact_ref,
        row.base_version, row.candidate_version,
        row.hypothesis, row.proposal, row.status, row.baseline_score, row.candidate_score,
        row.trigger_run_ids, row.evaluation, row.error, row.created_at, row.committed_at,
      );
    this.events.emit("data.changed", { module: "agents", action: "evolution_proposed" });
    return row;
  }

  updateEvolutionRun(
    id: string,
    patch: Partial<Pick<AgentEvolutionRun,
      "candidate_version" | "status" | "baseline_score" | "candidate_score" | "evaluation" | "error" | "committed_at" | "artifact_ref">>,
  ): AgentEvolutionRun | undefined {
    const current = this.db
      .prepare("SELECT * FROM agent_evolution_runs WHERE id = ?")
      .get(id) as AgentEvolutionRun | undefined;
    if (!current) return undefined;
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${k} = ?`);
      params.push(v as unknown);
    }
    if (sets.length === 0) return current;
    params.push(id);
    this.db.prepare(`UPDATE agent_evolution_runs SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    this.events.emit("data.changed", { module: "agents", action: "evolution_updated" });
    return this.db
      .prepare("SELECT * FROM agent_evolution_runs WHERE id = ?")
      .get(id) as AgentEvolutionRun | undefined;
  }

  listEvolutionRuns(agentId: string, limit = 20): AgentEvolutionRun[] {
    return this.db
      .prepare(
        `SELECT * FROM agent_evolution_runs
         WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(agentId, limit) as AgentEvolutionRun[];
  }

  listEvolutionRunsByWorkspace(workspaceId: string, limit = 50): AgentEvolutionRun[] {
    return this.db
      .prepare(
        `SELECT * FROM agent_evolution_runs
         WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(workspaceId, limit) as AgentEvolutionRun[];
  }

  getEvolutionRun(id: string): AgentEvolutionRun | undefined {
    return this.db
      .prepare("SELECT * FROM agent_evolution_runs WHERE id = ?")
      .get(id) as AgentEvolutionRun | undefined;
  }

  // ── Conversation subscriptions ───────────────────────────────────────────

  /**
   * Subscribe an agent to a conversation. Idempotent — re-subscribing
   * updates mode/filter_role and reactivates if previously cancelled.
   */
  subscribeAgentToConversation(input: {
    agent_id: string;
    conversation_id: string;
    mode?: "responder" | "observer";
    filter_role?: string;
  }): AgentConversationSubscription | null {
    const agent = this.getAgent(input.agent_id);
    if (!agent) return null;
    const convo = this.getConversation(input.conversation_id);
    if (!convo) return null;

    const mode = input.mode ?? "responder";
    const filterRole = input.filter_role ?? "";

    const existing = this.db
      .prepare(
        `SELECT * FROM agent_conversation_subscriptions
         WHERE agent_id = ? AND conversation_id = ?`,
      )
      .get(input.agent_id, input.conversation_id) as AgentConversationSubscription | undefined;

    if (existing) {
      this.db
        .prepare(
          `UPDATE agent_conversation_subscriptions
           SET mode = ?, filter_role = ?, active = 1
           WHERE id = ?`,
        )
        .run(mode, filterRole, existing.id);
      return this.getSubscription(existing.id) ?? null;
    }

    const sub: AgentConversationSubscription = {
      id: newId(),
      agent_id: input.agent_id,
      conversation_id: input.conversation_id,
      mode,
      filter_role: filterRole,
      active: 1,
      last_fired_at: null,
      created_at: isoNow(),
    };
    this.db
      .prepare(
        `INSERT INTO agent_conversation_subscriptions
          (id, agent_id, conversation_id, mode, filter_role, active, last_fired_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(sub.id, sub.agent_id, sub.conversation_id, sub.mode, sub.filter_role, sub.active, sub.last_fired_at, sub.created_at);
    return sub;
  }

  unsubscribeAgentFromConversation(agentId: string, conversationId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE agent_conversation_subscriptions SET active = 0
         WHERE agent_id = ? AND conversation_id = ?`,
      )
      .run(agentId, conversationId) as { changes: number };
    return result.changes > 0;
  }

  getSubscription(id: string): AgentConversationSubscription | undefined {
    return this.db
      .prepare("SELECT * FROM agent_conversation_subscriptions WHERE id = ?")
      .get(id) as AgentConversationSubscription | undefined;
  }

  listSubscriptionsForConversation(conversationId: string): AgentConversationSubscription[] {
    return this.db
      .prepare(
        `SELECT * FROM agent_conversation_subscriptions
         WHERE conversation_id = ? AND active = 1`,
      )
      .all(conversationId) as AgentConversationSubscription[];
  }

  listSubscriptionsForAgent(agentId: string): AgentConversationSubscription[] {
    return this.db
      .prepare(
        `SELECT * FROM agent_conversation_subscriptions
         WHERE agent_id = ? AND active = 1
         ORDER BY created_at DESC`,
      )
      .all(agentId) as AgentConversationSubscription[];
  }

  markSubscriptionFired(id: string): void {
    this.db
      .prepare("UPDATE agent_conversation_subscriptions SET last_fired_at = ? WHERE id = ?")
      .run(isoNow(), id);
  }
}
