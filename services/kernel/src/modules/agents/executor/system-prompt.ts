/**
 * System-prompt assembly for native agent runs.
 *
 * The prompt is an ordered list of steps (`SYSTEM_PROMPT_STEPS`). Each step
 * is one block of the prompt: it returns the text to append (any string,
 * even "", is appended) or null to contribute nothing — so a block that used
 * to be pushed only when truthy returns `x || null`. Steps run strictly in
 * order and may carry side effects that belong to their block (marking the inbox read, emitting the delivery
 * event, …). A step may also only prepare state for later steps — the
 * semantic-ranking gate embeds the goal once for the three rankers after it.
 *
 * Blocks are joined with a blank line ("\n\n"). A step only returns a
 * Promise when it really awaits something, so a run without semantic ranking
 * assembles its prompt fully synchronously, exactly as before the split.
 */

import { log } from "../../../core/logger.js";
import type { KernelConfig, KernelLanguage } from "../../../core/config.js";
import type { Agent } from "../types.js";
import type { AgentService } from "../service.js";
import type { SkillBodyResolver } from "../skill-resolver.js";
import { agentAllowedTools, agentSkills } from "../agent-fields.js";
import type { RunRecorder } from "./run-recorder.js";
import {
  promptTodayDate,
  promptInvokedBy,
  promptDefaultAgent,
  promptInboxBlock,
  promptLearningsBlock,
  promptPerformanceBlock,
  promptSimilarRunsBlock,
  promptMemorySummaryBlock,
  promptMemoryGoalSuffix,
  promptWorkspaceMandate,
  promptProgressiveDiscovery,
  promptStyleDirective,
} from "../../../core/i18n/prompts.js";

export interface SystemPromptContext {
  agent: Agent;
  service: AgentService;
  /** Emits/logs on behalf of the run (inbox delivery). */
  recorder: RunRecorder;
  config: KernelConfig | null;
  skillResolver: SkillBodyResolver | null;
  lang: KernelLanguage;
  depth: number;
  maxChainDepth: number;
  /** Agent system prompt after {{variable}} interpolation ("" when unset). */
  effectiveSystemPrompt: string;
  /** Goal after {{variable}} interpolation. */
  effectiveGoal: string;
  /** YYYY-MM-DD, captured when assembly starts. */
  todayStr: string;

  // ── State filled in by earlier steps for later ones ──
  /** Goal embedding for the semantic rankers; null → lexical ranking. */
  goalVector: number[] | null;
  cosW?: number;
  minS?: number;
  /** Memory block appended to the goal (not the system prompt). */
  memoryGoalSuffix: string;
}

export type SystemPromptStep = (
  ctx: SystemPromptContext,
) => string | null | Promise<string | null>;

// ── Steps (in prompt order) ─────────────────────────────────────────────

const basePrompt: SystemPromptStep = (ctx) =>
  ctx.effectiveSystemPrompt || promptDefaultAgent(ctx.lang);

const todayDate: SystemPromptStep = (ctx) => promptTodayDate(ctx.lang, ctx.todayStr);

// Procedural skills index — for each slug in agent.skills_json, surface a
// one-line entry (slug + frontmatter description) so the model knows the
// skill exists and what triggers it. Full body is loaded on demand via
// `kernel_skill_load`. Cheap on tokens — typically <50 tok per skill.
const skillsIndex: SystemPromptStep = (ctx) => {
  if (!ctx.skillResolver || !ctx.agent.skills_json) return null;
  const attached = agentSkills(ctx.agent);
  if (attached.length === 0) return null;
  return ctx.skillResolver.buildPromptIndex(attached) || null;
};

const invokedBy: SystemPromptStep = (ctx) =>
  ctx.depth > 0 ? promptInvokedBy(ctx.lang, ctx.depth, ctx.maxChainDepth) : null;

// Progressive-discovery hint — the LLM only sees a tiny bootstrap toolset
// (social baseline + workspace publish + meta tools). The full catalog is
// discoverable via the meta tools and reachable two ways: activate-and-call
// for ergonomic single calls, or code_run to compose multiple calls in one
// inference round.
const progressiveDiscovery: SystemPromptStep = (ctx) =>
  ctx.agent.progressive_discovery ? promptProgressiveDiscovery(ctx.lang) : null;

// Inject fleet directory — every agent knows every other agent by default.
// Re-rendered each run so new agents are visible without manual updates.
const fleetDirectory: SystemPromptStep = (ctx) => ctx.service.buildDirectoryBlock(ctx.agent.id) || null;

// Inject global reporting-hierarchy context (rank, superiors, peers, subordinates).
// No-op if the agent has no rank assigned.
const hierarchy: SystemPromptStep = (ctx) => ctx.service.buildHierarchyBlock(ctx.agent.id) || null;

// Inject unread office-inbox messages from colleagues. These are async
// requests/escalations from other agents in the same flow that the linear
// declarative chain cannot carry (e.g. Developer → Manager hand-back).
// We mark them read BEFORE the run starts so a provider retry doesn't
// re-inject them.
const officeInbox: SystemPromptStep = (ctx) => {
  const { service, agent, lang, recorder } = ctx;
  const inbox = service.getUnreadInbox(agent.id);
  if (inbox.length === 0) return null;
  const inboxEntries = inbox.map((m) => ({
    senderName: service.getAgent(m.from_agent_id)?.name ?? m.from_agent_id,
    timestamp: m.created_at.slice(0, 16).replace("T", " "),
    subject: m.subject,
    body: m.body,
  }));
  const block = promptInboxBlock(lang, inboxEntries);
  service.markInboxRead(inbox.map(m => m.id));
  recorder.emit("agent:inbox:delivered", {
    count: inbox.length, message_ids: inbox.map(m => m.id),
  });
  recorder.logEvent({
    event_type: "run", event_subtype: "inbox_delivered",
    detail: `${inbox.length} pending inbox message(s) from colleagues`,
    raw_data: { count: inbox.length, message_ids: inbox.map(m => m.id) },
  });
  return block;
};

// Semantic ranking gate — ONE embed of the goal serves all three rankers
// (learnings, similar runs, memory). Falls back to lexical when the flag
// is off, the embeddings client isn't wired, or the embed call fails.
// Costs ~50-100ms (local MiniLM) / <30ms (LMStudio) per run when enabled.
// Contributes no text; only awaits when there is an embed call to make.
const semanticRankingGate: SystemPromptStep = (ctx) => {
  const useSemantic = !!ctx.config?.agents?.useSemanticRanking;
  const embedClient = useSemantic ? ctx.service.getEmbeddingsClient() : null;
  const finish = () => {
    ctx.cosW = ctx.config?.agents?.semanticRankingCosineWeight;
    ctx.minS = ctx.config?.agents?.semanticRankingMinScore;
    return null;
  };
  if (!embedClient) return finish();
  return (async () => {
    try {
      const [vec] = await embedClient.embed([ctx.effectiveGoal]);
      ctx.goalVector = vec ?? null;
    } catch (err) {
      log.debug(`Goal embed failed, falling back to lexical: ${err instanceof Error ? err.message : String(err)}`);
    }
    return finish();
  })();
};

// Inject learnings — ranked by relevance to current goal, not blind top-confidence
const learnings: SystemPromptStep = (ctx) => {
  const { service, agent, effectiveGoal, goalVector, cosW, minS } = ctx;
  const items = goalVector
    ? service.getRelevantLearningsByEmbedding(agent.id, effectiveGoal, goalVector, 15, cosW, minS)
    : service.getRelevantLearnings(agent.id, effectiveGoal, 15);
  return promptLearningsBlock(ctx.lang, items) || null;
};

// Inject performance stats summary
const performanceStats: SystemPromptStep = (ctx) =>
  promptPerformanceBlock(ctx.lang, ctx.service.getAgentStats(ctx.agent.id)) || null;

// Inject similar past runs — "when you were asked X, you produced Y"
// This is the core of semantic recall: recognize situations you've been in before.
const similarRuns: SystemPromptStep = (ctx) => {
  const { service, agent, effectiveGoal, goalVector, cosW, minS } = ctx;
  const runs = goalVector
    ? service.findSimilarPastRunsByEmbedding(agent.id, effectiveGoal, goalVector, 3, 30, cosW, minS)
    : service.findSimilarPastRuns(agent.id, effectiveGoal, 3);
  if (runs.length === 0) return null;
  return promptSimilarRunsBlock(
    ctx.lang,
    runs.map((r) => ({
      ok: r.status === "completed",
      goal: r.goal.slice(0, 200).replace(/\s+/g, " "),
      result: (r.result || r.error || "(empty)").slice(0, 300).replace(/\s+/g, " "),
    })),
  );
};

// Inject conversational memory — ranked by goal relevance, not pure recency
const conversationalMemory: SystemPromptStep = (ctx) => {
  const { service, agent, effectiveGoal, goalVector, cosW, minS, lang } = ctx;
  const memory = goalVector
    ? service.getRelevantMemoryByEmbedding(agent.id, effectiveGoal, goalVector, 50, 100, cosW, minS)
    : service.getRelevantMemory(agent.id, effectiveGoal, 50);
  if (memory.length === 0) return null;
  // System prompt: compact summary of relevance-ranked memory (chronological).
  const summaryEntries = [...memory].reverse().map((m) => ({
    role: m.role,
    timestamp: m.created_at.slice(5, 16).replace("T", " "),
    content: m.content.slice(0, 200),
  }));

  // Short memory block injected directly into the goal (top 10 most relevant)
  const suffixEntries = memory.slice(0, 10).map((m) => ({
    role: m.role,
    timestamp: m.created_at.slice(5, 16).replace("T", " "),
    content: m.content.slice(0, 300),
  }));
  ctx.memoryGoalSuffix = promptMemoryGoalSuffix(lang, suffixEntries);
  return promptMemorySummaryBlock(lang, summaryEntries);
};

// Auto-inject a workspace/analysis hint so agents with access use the
// shared workspace proactively. No restriction → fleet-wide; explicit
// allow_list → whenever any kernel_workspace_* tool is granted (the
// upgrade pass in agents/index.ts ensures analysis tools are present too).
const workspaceMandate: SystemPromptStep = (ctx) => {
  const allowedForHint = agentAllowedTools(ctx.agent);
  const hasWorkspaceAccess =
    allowedForHint.length === 0 ||
    allowedForHint.some(t => t.startsWith("kernel_workspace_"));
  return hasWorkspaceAccess ? promptWorkspaceMandate(ctx.lang) : null;
};

// Final language reinforcement — fights drift in weak local models that
// get pulled toward English by tool descriptions and code samples.
const styleDirective: SystemPromptStep = (ctx) => promptStyleDirective(ctx.lang);

/** The system prompt, top to bottom. Order is part of the contract. */
export const SYSTEM_PROMPT_STEPS: ReadonlyArray<SystemPromptStep> = [
  basePrompt,
  todayDate,
  skillsIndex,
  invokedBy,
  progressiveDiscovery,
  fleetDirectory,
  hierarchy,
  officeInbox,
  semanticRankingGate,
  learnings,
  performanceStats,
  similarRuns,
  conversationalMemory,
  workspaceMandate,
  styleDirective,
];

/**
 * Run the steps in order and join their blocks. Returns the system text and
 * the memory suffix the memory step prepared for the goal. Only awaits a step
 * that actually returned a Promise.
 */
export function assembleSystemPrompt(
  ctx: SystemPromptContext,
  steps: ReadonlyArray<SystemPromptStep> = SYSTEM_PROMPT_STEPS,
): { systemText: string; memoryGoalSuffix: string } | Promise<{ systemText: string; memoryGoalSuffix: string }> {
  const systemParts: string[] = [];
  const done = () => ({ systemText: systemParts.join("\n\n"), memoryGoalSuffix: ctx.memoryGoalSuffix });
  const runFrom = (i: number): ReturnType<typeof assembleSystemPrompt> => {
    for (; i < steps.length; i++) {
      const out = steps[i](ctx);
      if (out instanceof Promise) {
        const next = i + 1;
        return out.then((text) => {
          if (text !== null) systemParts.push(text);
          return runFrom(next);
        });
      }
      if (out !== null) systemParts.push(out);
    }
    return done();
  };
  return runFrom(0);
}
