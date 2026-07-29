/**
 * Centralized type definitions for all kernel events.
 *
 * This file serves as the single source of truth for event names and payloads.
 * Modules should import event types from here for type-safe event handling.
 *
 * @example
 * ```typescript
 * // In a listener
 * events.on("events:confirmed", (payload) => {
 *   // payload is automatically typed as KernelEvents["events:confirmed"]
 *   console.log(payload.event.title, payload.attendeeCount);
 * });
 *
 * // In an emitter
 * events.emit("events:confirmed", {
 *   event: eventRecord,
 *   attendeeCount: 5,
 * });
 * ```
 */

// ── Generic Data Change Event ─────────────────────────────────

export interface DataChangedPayload {
  module: string;
  tool?: string;
  action?: string;
  reason?: string;
  count?: number;
}

// ── Events Module ─────────────────────────────────────────────
// Event lifecycle types (`events:created` / `events:opened` / etc.) now live
// in the `events` extension's own module map and the kernel-facing
// `KernelEventsModuleEvents` contract under
// `src/core/types/extensions/events.ts`. The kernel no longer enumerates
// them here — listeners use the structural `KernelEventsModuleEvents` shape
// and the EventBus' string overload.

// ── Reminders Module ──────────────────────────────────────────

export interface ReminderRecord {
  id: string;
  title: string;
  body: string;
  trigger_at: string;
}

// ── Agents Module ─────────────────────────────────────────────

export interface AgentRunPayload {
  agentId: string;
  agentName: string;
  runId: string;
  trigger: string;
}

export interface AgentAlertPayload {
  agentId: string;
  agentName: string;
  type: "offline" | "error" | "warning";
  message: string;
}

// ── Agent Flow Events (real-time execution tracking) ─────────

export interface AgentFlowRunStartedPayload {
  agent_id: string;
  agent_name: string;
  run_id: string;
  goal: string;
  trigger_type: string;
}

export interface AgentFlowStepPayload {
  agent_id: string;
  agent_name: string;
  run_id: string;
  step_number: number;
  type: "thought" | "tool_call" | "tool_result" | "error" | "final";
  tool_name?: string;
  content_preview: string;
}

export interface AgentFlowChainTriggeredPayload {
  source_agent_id: string;
  source_agent_name: string;
  target_agent_id: string;
  target_agent_name: string;
  chain_id: string;
  chain_label: string;
  run_id: string;
}

export interface AgentFlowRunCompletedPayload {
  agent_id: string;
  agent_name: string;
  run_id: string;
  status: "completed" | "failed";
  steps_count: number;
  tokens_used: number;
  result_preview: string;
  error?: string;
}

export interface AgentFlowResultPayload {
  agent_id: string;
  agent_name: string;
  run_id: string;
  flow_id: string;
  result: string;
  trigger_type: string;
}

// ── Chat Module ───────────────────────────────────────────────

export interface ChatMessagePayload {
  episodeId: string;
  role: "user" | "assistant";
  content: string;
}

export interface ChatExtractionPayload {
  episodeId: string;
  type: "task" | "reminder" | "contact" | "event";
  data: Record<string, unknown>;
}

/** Lifecycle hook payloads (aiden-inspired pre_compact / session_stop / after_tool_call). */

export interface ChatToolCallCompletePayload {
  episodeId: string;
  /** Message id this tool call was attached to. May be empty when fired from llm-loop. */
  messageId: string;
  toolName: string;
  /** True when the tool returned an error (`is_error: true`). */
  isError: boolean;
  /** First ~200 chars of the tool result, for graph-intel ingestion. */
  resultPreview: string;
  /** Wall-clock duration of the tool call in ms. */
  durationMs: number;
}

export interface ChatPreCompactPayload {
  episodeId: string;
  /** Number of messages currently in conversation history before compaction. */
  messageCount: number;
  /** Approx. token count of the conversation about to be compacted. */
  approxTokens: number;
}

export interface ChatSessionStopPayload {
  episodeId: string;
  /** Total messages exchanged in this session. */
  messageCount: number;
  /** Concatenated user+assistant text from the session, capped at ~10KB. */
  transcript: string;
  /** Reason the session ended. `idle` = autocompact-only event, not a real close. */
  reason: "idle" | "explicit-close" | "shutdown";
}

// ── Config Module ─────────────────────────────────────────────

export interface ConfigChangedPayload {
  key: string;
  value: unknown;
  updatedBy: string;
}

// ── Contact Module ────────────────────────────────────────────

export interface ContactInteractionPayload {
  contactId: string;
  contactName: string;
  type: string;
  summary?: string;
}

// ── Email Module ──────────────────────────────────────────────

export interface EmailSuggestionsPayload {
  count: number;
  suggestions: Array<{ subject: string; from: string }>;
}

// ── Skills Module ─────────────────────────────────────────────

export interface SkillEventPayload {
  type: "skill:installed" | "skill:enabled" | "skill:disabled" | "skill:uninstalled";
  skillId: string;
  skillName: string;
}

// ── Memory Nudge Module ───────────────────────────────────────

export interface MemoryNudgePayload {
  nudge: {
    id: string;
    type: string;
    message: string;
  };
  userId: string;
}

export interface MemoryNudgeAckPayload {
  nudgeId: string;
}

// ── Architecture 3D beams ────────────────────────────────────

/**
 * Generic "cross-module" beam payload emitted by any module that wants
 * the ARCH 3D visor to render a beam between two modules. Bootstrap
 * forwards every `arch.cross_module` event to the publisher's
 * "agents.flow" channel as an `archEvent` with the same shape.
 *
 * Source modules emit this themselves instead of bootstrap translating
 * domain-specific events — keeps the kernel decoupled from any one
 * module's vocabulary.
 */
export interface ArchCrossModulePayload {
  source: string;
  target: string;
  label?: string;
  [extra: string]: unknown;
}

// ── Kernel Events Map ─────────────────────────────────────────

/**
 * Complete map of all kernel events and their payload types.
 *
 * Use this interface with TypedEventBus for compile-time safety.
 */
export interface KernelEvents {
  // Generic
  "data.changed": DataChangedPayload;

  // Events module: see `src/core/types/extensions/events.ts` for the
  // kernel-facing payload contract. Concrete typings live in the
  // `events` extension.

  // Reminders module
  "reminder.fired": { reminder: ReminderRecord };

  // Agents module
  "agent.run.started": AgentRunPayload;
  "agent.run.completed": AgentRunPayload & { durationMs: number; success: boolean };
  "agent.run.failed": AgentRunPayload & { error: string };
  "agent.alert": AgentAlertPayload;

  // Agent flow (real-time execution)
  "agent:flow:run_started": AgentFlowRunStartedPayload;
  "agent:flow:step": AgentFlowStepPayload;
  "agent:flow:chain_triggered": AgentFlowChainTriggeredPayload;
  "agent:flow:run_completed": AgentFlowRunCompletedPayload;

  // Agent flow result (consumable by other modules/extensions)
  "agent:flow:result": AgentFlowResultPayload;

  // Agent autonomy loop — self-grading & learning hygiene (payloads typed loosely)
  "agent:flow:auto_eval_started": { agent_id: string; agent_name: string; run_id: string };
  "agent:flow:auto_eval": {
    agent_id: string; agent_name: string; run_id: string;
    score: number; outcome: string; confidence: number; issues: string;
  };
  "agent:flow:auto_eval_skipped": { agent_id: string; agent_name: string; run_id: string };
  "agent:flow:learning_created": {
    agent_id: string; agent_name: string; run_id: string;
    learning_id: string; learning_type: string; content: string; confidence: number;
  };
  "agent:flow:learning_deactivated": { agent_id: string; agent_name: string; run_id: string; count: number };

  // Chat module
  "chat.message": ChatMessagePayload;
  "chat.extraction": ChatExtractionPayload;
  "chat.tool_call_complete": ChatToolCallCompletePayload;
  "chat.pre_compact": ChatPreCompactPayload;
  "chat.session_stop": ChatSessionStopPayload;

  // Config module
  "config:changed": ConfigChangedPayload;

  // Contact module
  "contact.interaction": ContactInteractionPayload;

  // Email module
  "email.suggestions.new": EmailSuggestionsPayload;

  // Skills module
  "skill:installed": SkillEventPayload;
  "skill:enabled": SkillEventPayload;
  "skill:disabled": SkillEventPayload;
  "skill:uninstalled": SkillEventPayload;

  // Memory nudge module
  "memory:nudge": MemoryNudgePayload;
  "memory:nudge:ack": MemoryNudgeAckPayload;

  // Architecture 3D beams (generic, emitted by any module)
  "arch.cross_module": ArchCrossModulePayload;
}

/**
 * Union type of all event names
 */
export type KernelEventName = keyof KernelEvents;

/**
 * Helper type to get payload type for a specific event
 */
export type KernelEventPayload<K extends KernelEventName> = KernelEvents[K];
