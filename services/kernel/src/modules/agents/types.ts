/** What an office is, for the room it gets in 3D and the buttons its agents show. */
export const FLOW_KINDS = ["general", "devops", "communications", "creative"] as const;
/** A core kind, or one an installed extension declares (manifest `frontend.worlds[].kinds`). */
export type FlowKind = (typeof FLOW_KINDS)[number] | (string & {});

/** Kinds declared by installed extensions, e.g. an extension that draws its own building. */
const extensionKinds = new Set<string>();
/** The ones that stand in a building of their own: they take no lot on the office grid. */
const offGridKinds = new Set<string>();

/** Accept extension-declared office kinds (called when an extension loads or installs). */
export function registerExtensionFlowKinds(kinds: ReadonlyArray<{ id: string; offGrid?: boolean }>): void {
  for (const k of kinds) {
    if (typeof k?.id !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(k.id)) continue;
    extensionKinds.add(k.id);
    if (k.offGrid) offGridKinds.add(k.id);
  }
}

/** Offices an extension stands in its own building (no lot on the grid). */
export function isOffGridKind(kind: string | null | undefined): boolean {
  return !!kind && offGridKinds.has(kind);
}

export function isFlowKind(v: unknown): v is FlowKind {
  return typeof v === "string" && ((FLOW_KINDS as readonly string[]).includes(v) || extensionKinds.has(v));
}

/** How agents of an office that works on a repo are run. */
export type RepoIsolation = "sandbox" | "host";

/** Named flow — a logical group of agents and chains */
export interface AgentFlow {
  id: string;
  name: string;
  description: string;
  color: string;            // hex color for UI
  active: number;           // 0/1
  // Office "home" (migration v36). Agents in this flow inherit it as cwd unless
  // they declare their own __cwd_path__ / __workspace__ override.
  //   home_workspace_id → id of the auto-created workspace row (data/workspaces/{id}/).
  //   home_repo_path    → absolute host path when promoted to a git repo; '' = use workspace.
  home_workspace_id?: string; // '' = none yet
  home_repo_path?: string;    // '' = use the kernel workspace
  kind?: FlowKind;                        // 'general' when absent
  repo_isolation?: RepoIsolation | "";    // '' = the office has no repo
  source_extension_id?: string;           // '' = created by the operator
  auto_debate?: number;                   // 0/1
  lot_id?: string;                        // "col,row" plot in the 3D world; '' = none yet
  paused?: number;                        // 0/1 — office switched off: its agents never run (v53)
  created_at: string;
  updated_at: string;
}

/** Agent definition — a reusable autonomous agent template */
export interface Agent {
  id: string;
  name: string;
  description: string;
  system_prompt: string;
  goal_template: string;
  allowed_tools: string;    // JSON array of tool names, "[]" = all
  denied_tools: string;     // JSON array of excluded tool names
  provider: string;         // LLM provider (claude/openai/lmstudio), '' = default
  model: string;            // specific model, '' = provider default
  max_iterations: number;
  timeout_ms: number;
  active: number;           // 0/1
  flow_id: string;          // FK to agent_flows, '' = unassigned
  max_tokens: number;       // token budget per run (default 50000)
  max_errors: number;       // consecutive error limit (default 3)
  variables: string;        // JSON key-value pairs for template interpolation
  show_on_dashboard: number; // 0/1 — show last flow result as a widget on dashboard home
  builtin_handler: string;   // if set, scheduler runs builtin function instead of LLM
  rank_id: string;           // FK to agent_ranks, '' = unranked
  model_chain: string;       // JSON array of ModelChainEntry, '' = use (provider, model) single
  role?: string;             // 'manager' | 'worker' (default 'worker'). Added via ALTER TABLE.
  executor_type?: "native" | "claude_code"; // 'native' = runToolLoop multi-provider; 'claude_code' = Claude Agent SDK.
  wake_on_inbox?: number;    // 0/1 (default 1). When 1, idle agent auto-runs on post_to_colleague.
  progressive_discovery?: number; // 0/1 (default 0). When 1, native executor only exposes kernel_tool_search + social baseline; the model activates more tools on demand.
  // Visual skin id consumed by the dashboard's skin-registry ('office-worker',
  // 'ra-soldier', …). Empty string = use the registry default. Read-only on
  // the kernel side — purely a render hint.
  skin_id?: string;
  // Flagged for human review (consolidation, deprecation, etc.). Renders an
  // orange REVISION pill in the dashboard, orthogonal to the active flag.
  under_revision?: number;  // 0/1, default 0
  // i18n: JSON { "es": "...", "en": "..." }. Empty = use the original field as fallback.
  system_prompt_i18n?: string;
  goal_template_i18n?: string;
  description_i18n?: string;
  // Per-agent language override. "" = inherit from KernelConfig.language.
  // Valid values: "es" | "en" (anything else is silently ignored).
  language_override?: string;
  /**
   * Procedural skills attached to this agent — JSON array of slugs from
   * installed_extensions WHERE type='skill'. At run-time the executor injects
   * a one-line index of each skill (slug + description from the YAML
   * frontmatter) into the system_prompt so the model knows what's available
   * without paying full-body cost; the model loads any specific skill body
   * on demand via `kernel_skill_load(slug)`.
   */
  skills_json?: string;
  /**
   * Circuit breaker (migration v41). `consecutive_failures` advances on every
   * failed run and resets on the first successful one; at
   * `config.agents.autoPauseThreshold` the agent is auto-paused (`active = 0`)
   * and the top agent is alerted. `auto_paused_at` is '' unless the breaker is
   * what paused it — that's how the UI tells an automatic pause from the user
   * pressing Pause. All three are cleared when the agent is reactivated.
   */
  consecutive_failures?: number;
  auto_paused_at?: string;
  auto_pause_reason?: string;
  created_at: string;
  updated_at: string;
}

/** One link in an agent's model fallback chain. Up to 3 used today (primary + 2 fallbacks). */
export interface ModelChainEntry {
  provider: string;   // "claude" | "openai" | "grok" | "lmstudio"
  model: string;      // provider-specific model name, e.g. "grok-4-1-fast-reasoning"
}

/** Hierarchical rank assignable to agents. Global — one ladder for the fleet. */
export interface AgentRank {
  id: string;
  name: string;         // "Team Lead", "Senior Manager", ... — editable
  level: number;        // 1 = lowest. Used for precedence comparisons.
  insignia: string;     // short glyph/emoji rendered as 3D badge
  color: string;        // hex — badge color
  description: string;
  active: number;       // 0/1
  created_at: string;
  updated_at: string;
}

/** Chain link between two agents (declarative post-completion chaining) */
export interface AgentChain {
  id: string;
  source_agent_id: string;
  target_agent_id: string;
  label: string;
  condition: string;      // JSON condition on source result
  pass_result: number;    // 0/1 — pass source result as context
  delay_ms: number;       // delay before triggering target
  active: number;         // 0/1
  created_at: string;
}

/** Execution run of an agent */
export interface AgentRun {
  id: string;
  agent_id: string;
  trigger_type: "manual" | "event" | "schedule" | "chain";
  trigger_payload: string;  // JSON context
  goal: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  result: string;
  error: string;
  steps_count: number;
  tokens_used: number;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  /** Run that spawned this one (chain/invoke). "" for top-level runs. */
  parent_run_id: string;
  /** Agent that spawned this one. "" for top-level runs. Used for self-recursion guard. */
  parent_agent_id: string;
  /** 0 for top-level, parent.depth + 1 for chained runs. Capped by KERNEL_AGENT_MAX_DEPTH. */
  depth: number;
  /** JSON array of RunCondition — what happened to the run, beyond its status. */
  conditions: string;
  /** Project this run works for (src/modules/projects). null = none. */
  project_id: string | null;
}

/**
 * One fact about a run, in the shape Kubernetes uses for conditions: a type,
 * whether it holds, a machine-readable reason, a human message, and when it
 * last flipped. Upserted by type — a run holds at most one of each.
 */
export interface RunCondition {
  type: "ModelReady" | "Interrupted" | "Resumed" | "Aborted" | "WorkspaceReady";
  status: "True" | "False";
  reason: string;
  message: string;
  last_transition_time: string;
}

/** Individual step within an agent run */
export interface AgentStep {
  id: string;
  run_id: string;
  step_number: number;
  type: "thought" | "tool_call" | "tool_result" | "error" | "final";
  content: string;
  tool_name: string;
  tool_input: string;     // JSON
  tool_output: string;
  tokens: number;
  created_at: string;
}

/** Mapping between an event and an agent trigger */
export interface EventTrigger {
  id: string;
  agent_id: string;
  event_name: string;
  filter: string;          // JSON condition
  cooldown_ms: number;
  last_fired: string | null;
  active: number;          // 0/1
  created_at: string;
}

/** Periodic schedule for automatic agent execution */
export interface AgentSchedule {
  id: string;
  agent_id: string;
  interval_ms: number;
  cron_expression: string;  // cron syntax e.g. "0 7 * * *" — takes precedence over interval_ms
  goal_override: string;
  next_run_at: string;
  last_run_at: string | null;
  active: number;          // 0/1
  created_at: string;
  /** Project this schedule runs for. null = none (or a per_project template). */
  project_id: string | null;
  /** 1 = template cloned once per project assigned to the office. */
  per_project: number;
}

/** User feedback on a completed agent run */
export interface AgentFeedback {
  id: string;
  agent_id: string;
  run_id: string;
  rating: number;          // 1-5
  outcome: "success" | "partial" | "failure" | "neutral";
  lesson: string;
  created_at: string;
}

/** Learned pattern from agent execution history */
export interface AgentLearning {
  id: string;
  agent_id: string;
  type: "pattern" | "avoid" | "prefer" | "insight";
  content: string;
  confidence: number;      // 0.0-1.0
  source_runs: string;     // JSON array of run IDs
  active: number;          // 0/1
  created_at: string;
  updated_at: string;
  /** null = craft learning (all projects); set = only for that project. */
  project_id: string | null;
}

/** Immutable snapshot of an agent's system_prompt + goal_template at a point in time. */
export interface AgentPromptVersion {
  id: string;
  agent_id: string;
  version: number;           // monotonic per agent, starts at 1
  system_prompt: string;
  goal_template: string;
  parent_version: number;    // 0 = root / initial
  source: "manual" | "reflection" | "restore" | "initial";
  note: string;              // why this version was created
  active: number;            // 0/1 — which snapshot matches the live agent row
  created_at: string;
}

/**
 * One closed-loop self-evolution attempt (Autogenesis SEPL cycle).
 *
 * `target` selects which "genome" the cycle mutates:
 *   - 'prompt'   → system_prompt (ReflectionOptimizer)
 *   - 'workspace'→ files in data/workspaces/{workspace_id} (git-versioned)
 *   - 'compose'  → docker-compose stack of the workspace
 *   - 'mixed'    → multiple targets at once
 * `artifact_ref` is the opaque pointer to the candidate artifact (git sha,
 * image tag, …). For target='prompt' the lineage is captured by
 * candidate_version, so artifact_ref stays empty.
 */
export type AgentEvolutionTarget = "prompt" | "workspace" | "compose" | "mixed";

export interface AgentEvolutionRun {
  id: string;
  agent_id: string;
  target: AgentEvolutionTarget;
  workspace_id: string;         // empty for target='prompt'
  artifact_ref: string;         // git sha for workspace/compose, "" for prompt
  base_version: number;         // prompt version we started from (target='prompt')
  candidate_version: number;    // 0 until Improve writes a candidate
  hypothesis: string;           // Reflect (ρ) output
  proposal: string;             // Select (σ) output — proposed new prompt text
  status: "proposed" | "accepted" | "rejected" | "rolled_back" | "failed";
  baseline_score: number;       // Evaluate (ε) on base_version
  candidate_score: number;      // Evaluate (ε) on candidate_version
  trigger_run_ids: string;      // JSON array of run IDs that motivated this cycle
  evaluation: string;           // free-form LLM judge output OR eval command output
  error: string;
  created_at: string;
  committed_at: string | null;
}

export interface AgentOfficeInboxMessage {
  id: string;
  flow_id: string;
  from_agent_id: string;
  to_agent_id: string;
  subject: string;
  body: string;
  status: "unread" | "read" | "archived";
  related_run_id: string;
  created_at: string;
  read_at: string | null;
  /** Project the letter belongs to. null = none. */
  project_id: string | null;
}

/** Generic fleet-wide conversation. Subsumes 1-to-1 chats, meetings, debates. */
export interface AgentConversation {
  id: string;
  kind: "chat" | "meeting" | "debate";
  topic: string;
  topic_hash: string;
  participants: string;       // JSON array of agent IDs
  initiator_agent_id: string;
  parent_conversation_id: string;
  status: "open" | "closed";
  meta: string;               // JSON freeform (e.g. debate reason, trigger_msg_id)
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export type AgentMessageRole =
  | "stmt"
  | "question"
  | "answer"
  | "counter"
  | "vote"
  | "summary";

/** One turn in a conversation. The role marker drives debate detection. */
export interface AgentMessage {
  id: string;
  conversation_id: string;
  from_agent_id: string;
  to_agent_id: string;         // '' = broadcast to all participants
  role: AgentMessageRole;
  in_reply_to: string;         // '' = top-level
  body: string;
  tokens: number;
  run_id: string;
  meta: string;                // JSON freeform
  created_at: string;
}

/**
 * Subscription that wires an agent to a conversation. New turns in the
 * conversation trigger the agent automatically. mode='responder' spawns a
 * run; mode='observer' is reserved for future read-only awareness.
 */
export interface AgentConversationSubscription {
  id: string;
  agent_id: string;
  conversation_id: string;
  mode: "responder" | "observer";
  filter_role: string;          // '' = any role
  active: number;               // 0/1
  last_fired_at: string | null;
  created_at: string;
}

/** Cooldown record — auto-debate opened at this time for this topic_hash. */
export interface AgentDebateCooldown {
  topic_hash: string;
  debate_conv_id: string;
  opened_at: string;
  closed_at: string | null;
}
