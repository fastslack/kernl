/**
 * Seam interfaces between `agents` (core) and the `agent-advanced` extension
 * (or any future replacement). The core never imports concrete classes from
 * the extension — it only knows about these structural shapes and registers
 * implementations via `AgentsModule.register*()`.
 *
 * Each interface enumerates only the methods agents-core actually calls. The
 * underlying class can have a wider surface (it usually does) without
 * leaking into the kernel.
 *
 * Where return shapes are complex (evolver / reflection cycles), we type the
 * return as `unknown` and let the HTTP layer forward the JSON verbatim. The
 * payload stays the contract of the extension, not of the core.
 */
import type { Agent, AgentRun } from "./types.js";
import type { AgentService } from "./service.js";
import type { ExecutionResult } from "./executor.js";
import type { EventBus } from "../../core/event-bus.js";

// ── Alternative executor (e.g. claude_code SDK) ──────────────
export interface AltExecuteParams {
  agent: Agent;
  goal: string;
  run: AgentRun;
  service: AgentService;
  events?: EventBus;
  depth?: number;
}

export interface AltExecutorLike {
  execute(params: AltExecuteParams): Promise<ExecutionResult>;
  cancelRun(runId: string): boolean;
}

// ── Self-evaluation service ──────────────────────────────────
export interface EvalOutcome {
  score: number;
  outcome: "success" | "partial" | "failure" | "neutral";
  lesson: string;
  issues: string;
  confidence: number;
  tokens_used: number;
}

export interface EvalServiceLike {
  isEnabled(): boolean;
  evaluate(input: {
    goal: string;
    result: string;
    error: string;
    steps_count: number;
    tools_used: string[];
    status: "completed" | "failed";
    agent: Agent;
    service: AgentService;
  }): Promise<EvalOutcome | null>;
}

// ── Meeting executor (structured multi-agent discussion) ─────
export interface MeetingRequestLike {
  topic: string;
  moderator_id: string;
  attendee_ids: string[];
  context?: string;
  rounds?: number;
  urgency?: string;
}

export interface MeetingResultLike {
  meeting_id: string;
  summary: string;
  decisions: string[];
  action_items: string[];
  transcript: string;
  total_tokens: number;
  rounds_completed: number;
}

export interface MeetingExecutorLike {
  run(
    request: MeetingRequestLike,
    service: AgentService,
    events: EventBus,
  ): Promise<MeetingResultLike>;
}

// ── Workspaces ───────────────────────────────────────────────
export interface WorkspaceLike {
  id: string;
  owner_flow_id: string;
  name: string;
  description: string;
  shared: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface WorkspaceServiceLike {
  get(id: string): WorkspaceLike | undefined;
  getByOwnerName(ownerFlowId: string, name: string): WorkspaceLike | undefined;
  listAll(): WorkspaceLike[];
  create(input: {
    owner_flow_id: string;
    name: string;
    description?: string;
    shared?: boolean;
    id?: string;
  }): WorkspaceLike;
}

// ── Reflection optimizer (prompt evolution cycles) ───────────
export interface ReflectionOptimizerLike {
  runCycle(agentId: string, opts: Record<string, unknown>): Promise<unknown>;
}

// ── Workspace evolver (filesystem / compose evolution) ───────
export interface WorkspaceEvolverLike {
  describe(workspaceId: string): Promise<Record<string, unknown>>;
  init(workspaceId: string): Promise<unknown>;
  snapshotBaseline(opts: { workspace_id: string; agent_id?: string; label?: string }): Promise<unknown>;
  evaluate(opts: { workspace_id: string }): Promise<unknown>;
  acceptCandidate(opts: Record<string, unknown>): Promise<unknown>;
  rejectCandidate(opts: Record<string, unknown>): Promise<unknown>;
  runCycle(opts: Record<string, unknown>): Promise<unknown>;
  revertTo(workspaceId: string, ref: string): Promise<unknown>;
}
