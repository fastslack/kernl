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
