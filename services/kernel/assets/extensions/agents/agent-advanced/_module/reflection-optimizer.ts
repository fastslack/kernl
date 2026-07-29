/**
 * Reflection optimizer — Autogenesis SEPL loop applied to an agent's system_prompt.
 *
 * Closed-loop over a single agent:
 *   1. Reflect (ρ): read recent failed/partial runs + their traces + feedback
 *   2. Select  (σ): ask meta-LLM to propose an improved system_prompt
 *   3. Improve (ι): write candidate as a new prompt version (NOT yet active)
 *   4. Evaluate (ε): LLM-judge baseline vs candidate on the same failed goals
 *   5. Commit  (κ): if candidate wins by margin → activate; else mark rejected
 *
 * Evaluation is intentionally lightweight: we don't re-execute the agent (too
 * expensive and potentially destructive). Instead we replay the existing trace
 * under each prompt via an LLM judge that scores which prompt would likely have
 * produced a better result. This is the "shadow evaluation" pragmatic choice.
 */

import { log } from "../../../../../src/core/logger.js";
import { sanitizePromptText } from "../../../../../src/core/prompt-sanitizer.js";
import { stripReasoning } from "../../../../../src/core/llm/strip-reasoning.js";
import type { ChatLlmProvider } from "../../../../../src/modules/chat/llm-adapter.js";
import type { ChatMessage } from "../../../../../src/modules/chat/types.js";
import type { KernelConfig, KernelLanguage } from "../../../../../src/core/config.js";
import type { AgentService } from "../../../../../src/modules/agents/service.js";
import type { Agent, AgentEvolutionRun, AgentFeedback, AgentRun } from "../../../../../src/modules/agents/types.js";
import { buildAgentChain, runWithChain, type ChainCandidate } from "./chain-runner.js";

const PROPOSAL_SYSTEM_PROMPT_EN = `You are an agent prompt engineer. You rewrite an autonomous agent's system_prompt based on concrete failures.

Output STRICT JSON only (no markdown fences, no preamble):

{
  "hypothesis": "<1-2 sentences naming the root cause observed in failures>",
  "new_system_prompt": "<complete replacement system_prompt, ready to use verbatim>",
  "changes_summary": "<1-2 sentences describing what you changed and why>"
}

Rules:
- Preserve the agent's identity and role. You are patching instructions, not reinventing the agent.
- Be minimal and surgical. Small, targeted edits beat full rewrites.
- If failures suggest the agent is missing a constraint, add a concrete rule ("When X happens, do Y").
- If failures suggest prompt bloat is confusing the agent, prune redundant lines instead of adding more.
- The new_system_prompt MUST be the full prompt text, not a diff or delta.
- Do NOT inline example tool calls or JSON schemas — those come from the framework.
- Write hypothesis, changes_summary and new_system_prompt in ENGLISH.`;

const PROPOSAL_SYSTEM_PROMPT_ES = `Sos un ingeniero de prompts de agentes. Reescribís el system_prompt de un agente autónomo a partir de fallos concretos.

Salida en JSON ESTRICTO (sin fences de markdown, sin preámbulo):

{
  "hypothesis": "<1-2 oraciones nombrando la causa raíz observada en los fallos>",
  "new_system_prompt": "<reemplazo completo del system_prompt, listo para usar literalmente>",
  "changes_summary": "<1-2 oraciones describiendo qué cambiaste y por qué>"
}

Reglas:
- Preservá la identidad y el rol del agente. Estás parcheando instrucciones, no reinventando el agente.
- Sé mínimo y quirúrgico. Ediciones chicas y dirigidas le ganan a reescrituras completas.
- Si los fallos sugieren que al agente le falta una restricción, agregá una regla concreta ("Cuando pase X, hacé Y").
- Si los fallos sugieren que el prompt está sobrecargado y confunde al agente, podá líneas redundantes en vez de agregar más.
- El new_system_prompt DEBE ser el texto completo del prompt, no un diff ni un delta.
- NO incluyas ejemplos inline de tool calls ni JSON schemas — eso lo provee el framework.
- Escribí hypothesis, changes_summary y new_system_prompt en ESPAÑOL.`;

const JUDGE_SYSTEM_PROMPT_EN = `You are comparing two candidate system prompts for the same autonomous agent against the same failing execution.

Output STRICT JSON only:

{
  "baseline_score": <0-10>,
  "candidate_score": <0-10>,
  "reasoning": "<1-3 sentences>",
  "winner": "baseline" | "candidate" | "tie"
}

Scoring rubric:
- 10 = would have solved the task cleanly on first try
- 7  = would have solved it after self-correction
- 4  = would have hit the same class of failure
- 0  = clearly worse than what actually happened

Be strict. If the candidate only differs cosmetically, declare a tie. Small wording tweaks do not earn a higher score unless they plausibly prevent the observed failure.
Write reasoning in ENGLISH.`;

const JUDGE_SYSTEM_PROMPT_ES = `Estás comparando dos candidatos de system_prompt para el mismo agente autónomo contra la misma ejecución fallida.

Salida en JSON ESTRICTO únicamente:

{
  "baseline_score": <0-10>,
  "candidate_score": <0-10>,
  "reasoning": "<1-3 oraciones>",
  "winner": "baseline" | "candidate" | "tie"
}

Rúbrica de puntaje:
- 10 = habría resuelto la tarea limpiamente al primer intento
- 7  = la habría resuelto tras autocorrección
- 4  = habría pegado contra el mismo tipo de falla
- 0  = claramente peor que lo que realmente pasó

Sé estricto. Si el candidato solo difiere cosméticamente, declará empate. Tweaks de redacción no se llevan puntaje más alto salvo que plausiblemente eviten la falla observada.
Escribí reasoning en ESPAÑOL.`;

function pickProposalSystemPrompt(lang: KernelLanguage): string {
  return lang === "en" ? PROPOSAL_SYSTEM_PROMPT_EN : PROPOSAL_SYSTEM_PROMPT_ES;
}
function pickJudgeSystemPrompt(lang: KernelLanguage): string {
  return lang === "en" ? JUDGE_SYSTEM_PROMPT_EN : JUDGE_SYSTEM_PROMPT_ES;
}

export interface ReflectConfig {
  /** How many recent runs to inspect per cycle. */
  lookbackRuns: number;
  /** Minimum number of failures/partials in the lookback window required to trigger. */
  minFailures: number;
  /** Candidate must beat baseline by at least this score delta to auto-commit. */
  commitMargin: number;
  /** Dry-run — propose but never auto-commit, leave human review. */
  dryRun: boolean;
  /** Model override for the optimizer LLM. */
  model: string;
}

const DEFAULT_CONFIG: ReflectConfig = {
  lookbackRuns: 10,
  minFailures: 2,
  commitMargin: 1.5,
  dryRun: false,
  model: "",
};

export class ReflectionOptimizer {
  private providers: Map<string, ChatLlmProvider> = new Map();
  private providerName = "";
  private configRef: KernelConfig | null = null;

  constructor(private service: AgentService) {}

  setProviders(providers: Map<string, ChatLlmProvider>, providerName: string): void {
    this.providers = providers;
    this.providerName = providerName;
  }

  setConfig(config: KernelConfig): void {
    this.configRef = config;
  }

  /**
   * Run one SEPL cycle for the given agent. Safe to call unconditionally — if
   * there aren't enough failures in the lookback window, it returns null.
   */
  async runCycle(
    agentId: string,
    overrides: Partial<ReflectConfig> = {},
  ): Promise<AgentEvolutionRun | null> {
    const cfg: ReflectConfig = { ...DEFAULT_CONFIG, ...overrides };
    const agent = this.service.getAgent(agentId);
    if (!agent) {
      log.warn(`ReflectionOptimizer: agent ${agentId} not found`);
      return null;
    }

    // The reflection optimizer judges and rewrites a specific agent's prompt,
    // so the meta-LLM call should honor THAT agent's configured chain (from
    // /models). Fallback to the global reflection provider only if the agent's
    // chain is empty / all providers unavailable.
    const candidates = buildAgentChain(
      agent,
      this.service,
      this.providers,
      { provider: this.providerName },
      this.configRef?.agents?.defaultModelChain,
    );
    if (candidates.length === 0) {
      log.warn(`ReflectionOptimizer: no usable provider for agent ${agent.name} (chain + fallback empty)`);
      return null;
    }

    // ── Reflect ρ ──────────────────────────────────────
    const recentRuns = this.service.listRuns({ agent_id: agentId, limit: cfg.lookbackRuns });
    const failureRuns = recentRuns.filter(
      (r) => r.status === "failed" || r.status === "cancelled",
    );
    const feedbackMap = this.indexFeedbackByRun(agentId, recentRuns);
    const negativeFeedback = recentRuns.filter((r) => {
      const fb = feedbackMap.get(r.id);
      return fb && (fb.outcome === "failure" || fb.outcome === "partial");
    });
    const triggerRuns = dedupeById([...failureRuns, ...negativeFeedback]);

    if (triggerRuns.length < cfg.minFailures) {
      return null;
    }

    // ── Select σ ──────────────────────────────────────
    const baseVersion = this.service.getActivePromptVersion(agentId);
    const baseVersionNumber = baseVersion?.version ?? 1;
    const proposal = await this.proposeNewPrompt(
      candidates,
      cfg,
      agent,
      triggerRuns,
      feedbackMap,
    );
    if (!proposal) {
      return null;
    }

    // Refuse poisoned proposals before they touch the DB. Failure traces fed
    // to the meta-LLM can carry adversarial text that survives into the
    // rewritten prompt — the sanitizer rejects role-override / exfil
    // payloads. Logged as a hard reject (no fallback) because the worst case
    // is silently shipping a compromised prompt.
    const sanitized = sanitizePromptText(proposal.new_system_prompt);
    if (!sanitized.ok) {
      log.warn(
        `ReflectionOptimizer: rejected proposal for ${agent.name} — ${sanitized.reason}`,
      );
      return null;
    }

    const evolution = this.service.createEvolutionRun({
      agent_id: agentId,
      base_version: baseVersionNumber,
      hypothesis: proposal.hypothesis,
      proposal: proposal.new_system_prompt,
      trigger_run_ids: triggerRuns.map((r) => r.id),
    });

    // ── Improve ι — write candidate as inactive version (baseline stays live) ──
    const candidate = this.service.snapshotPrompt(agentId, {
      system_prompt: proposal.new_system_prompt,
      goal_template: agent.goal_template,
      source: "reflection",
      note: `evolution ${evolution.id}: ${proposal.changes_summary}`.slice(0, 500),
      parent_version: baseVersionNumber,
      activate: false,
    });
    if (!candidate) {
      this.service.updateEvolutionRun(evolution.id, {
        status: "failed",
        error: "snapshotPrompt returned null",
      });
      return evolution;
    }

    this.service.updateEvolutionRun(evolution.id, {
      candidate_version: candidate.version,
    });

    // ── Evaluate ε ────────────────────────────────────
    const judgement = await this.judge(candidates, cfg, agent, baseVersion?.system_prompt ?? agent.system_prompt, proposal.new_system_prompt, triggerRuns);

    if (!judgement) {
      this.service.updateEvolutionRun(evolution.id, {
        status: "failed",
        error: "judge returned no decision",
      });
      return this.service.getEvolutionRun(evolution.id) ?? evolution;
    }

    const delta = judgement.candidate_score - judgement.baseline_score;

    // ── Commit κ — only when the candidate clears the margin ──
    if (!cfg.dryRun && delta >= cfg.commitMargin && judgement.winner === "candidate") {
      this.service.activatePromptVersion(agentId, candidate.version);
      this.service.updateEvolutionRun(evolution.id, {
        status: "accepted",
        baseline_score: judgement.baseline_score,
        candidate_score: judgement.candidate_score,
        evaluation: judgement.reasoning,
        committed_at: new Date().toISOString(),
      });
      log.info(`ReflectionOptimizer: agent ${agent.name} evolved v${baseVersionNumber} → v${candidate.version} (Δ=${delta.toFixed(2)})`);
    } else {
      this.service.updateEvolutionRun(evolution.id, {
        status: "rejected",
        baseline_score: judgement.baseline_score,
        candidate_score: judgement.candidate_score,
        evaluation: judgement.reasoning,
      });
      log.info(`ReflectionOptimizer: agent ${agent.name} candidate rejected (Δ=${delta.toFixed(2)}, margin=${cfg.commitMargin})`);
    }

    return this.service.getEvolutionRun(evolution.id) ?? evolution;
  }

  private indexFeedbackByRun(agentId: string, runs: AgentRun[]): Map<string, AgentFeedback> {
    const map = new Map<string, AgentFeedback>();
    const allFb = this.service.getFeedback(agentId, 200);
    const runIds = new Set(runs.map((r) => r.id));
    for (const fb of allFb) {
      if (runIds.has(fb.run_id) && !map.has(fb.run_id)) {
        map.set(fb.run_id, fb);
      }
    }
    return map;
  }

  private async proposeNewPrompt(
    candidates: ChainCandidate[],
    cfg: ReflectConfig,
    agent: Agent,
    triggerRuns: AgentRun[],
    feedbackMap: Map<string, AgentFeedback>,
  ): Promise<{ hypothesis: string; new_system_prompt: string; changes_summary: string } | null> {
    const lang = this.configRef?.language ?? "es";
    const isEs = lang === "es";

    const failureSummaries = triggerRuns.slice(0, 5).map((r, i) => {
      const fb = feedbackMap.get(r.id);
      return [
        isEs ? `### Falla #${i + 1}` : `### Failure #${i + 1}`,
        isEs ? `Objetivo: ${r.goal.slice(0, 400)}` : `Goal: ${r.goal.slice(0, 400)}`,
        `Status: ${r.status}`,
        r.error ? `Error: ${r.error.slice(0, 400)}` : "",
        r.result ? (isEs ? `Resultado: ${r.result.slice(0, 600)}` : `Result: ${r.result.slice(0, 600)}`) : "",
        fb ? (isEs ? `Feedback: ${fb.outcome}${fb.lesson ? ` — ${fb.lesson}` : ""}` : `Feedback outcome: ${fb.outcome}${fb.lesson ? ` — ${fb.lesson}` : ""}`) : "",
      ].filter(Boolean).join("\n");
    }).join("\n\n");

    const userText = isEs
      ? [
          `## Agente`,
          `Nombre: ${agent.name}`,
          `Descripción: ${agent.description || "(sin descripción)"}`,
          "",
          `## system_prompt actual`,
          agent.system_prompt || "(vacío)",
          "",
          `## Fallas recientes`,
          failureSummaries || "(ninguna)",
          "",
          `Reescribí el system_prompt para atacar el patrón que ves en estas fallas. Devolvé JSON únicamente.`,
        ].join("\n")
      : [
          `## Agent`,
          `Name: ${agent.name}`,
          `Description: ${agent.description || "(none)"}`,
          "",
          `## Current system_prompt`,
          agent.system_prompt || "(empty)",
          "",
          `## Recent failures`,
          failureSummaries || "(none)",
          "",
          `Rewrite the system_prompt to address the pattern in these failures. Output JSON only.`,
        ].join("\n");

    const messages: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: userText }] },
    ];

    try {
      const completion = await runWithChain(
        candidates,
        `ReflectionOptimizer.propose[${agent.name}]`,
        (cand) => cand.provider.chatCompletion(messages, {
          model: cfg.model || cand.model || undefined,
          system: pickProposalSystemPrompt(lang),
          max_tokens: 2000,
          temperature: 0.2,
          caller: `reflect:${agent.name}/propose`,
        }),
      );
      return this.parseProposal(completion.content);
    } catch (err) {
      log.warn(`ReflectionOptimizer: proposal call failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private async judge(
    candidates: ChainCandidate[],
    cfg: ReflectConfig,
    agent: Agent,
    baselinePrompt: string,
    candidatePrompt: string,
    triggerRuns: AgentRun[],
  ): Promise<{ baseline_score: number; candidate_score: number; reasoning: string; winner: "baseline" | "candidate" | "tie" } | null> {
    // Pick one representative failure — judging 5 runs in one call tends to
    // produce mush. The optimizer runs multiple times over time; one well-judged
    // sample per cycle is better than five rushed ones.
    const sample = triggerRuns[0];
    if (!sample) return null;

    const lang = this.configRef?.language ?? "es";
    const isEs = lang === "es";

    const userText = isEs
      ? [
          `## Agente: ${agent.name}`,
          `## Objetivo fallido`,
          sample.goal.slice(0, 600),
          "",
          `## Qué pasó realmente`,
          `Status: ${sample.status}`,
          sample.error ? `Error: ${sample.error.slice(0, 400)}` : "",
          `Resultado: ${(sample.result || "(vacío)").slice(0, 800)}`,
          "",
          `## system_prompt baseline`,
          baselinePrompt.slice(0, 2500),
          "",
          `## system_prompt candidato`,
          candidatePrompt.slice(0, 2500),
          "",
          `Decidí qué prompt habría llevado a un mejor resultado en esta falla. Devolvé JSON únicamente.`,
        ].join("\n")
      : [
          `## Agent: ${agent.name}`,
          `## Failed goal`,
          sample.goal.slice(0, 600),
          "",
          `## What actually happened`,
          `Status: ${sample.status}`,
          sample.error ? `Error: ${sample.error.slice(0, 400)}` : "",
          `Result: ${(sample.result || "(empty)").slice(0, 800)}`,
          "",
          `## Baseline system_prompt`,
          baselinePrompt.slice(0, 2500),
          "",
          `## Candidate system_prompt`,
          candidatePrompt.slice(0, 2500),
          "",
          `Judge which prompt would likely have led to a better outcome on this failure. Output JSON only.`,
        ].join("\n");

    const messages: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: userText }] },
    ];

    try {
      const completion = await runWithChain(
        candidates,
        `ReflectionOptimizer.judge[${agent.name}]`,
        (cand) => cand.provider.chatCompletion(messages, {
          model: cfg.model || cand.model || undefined,
          system: pickJudgeSystemPrompt(lang),
          max_tokens: 600,
          temperature: 0,
          caller: `reflect:${agent.name}/judge`,
        }),
      );
      return this.parseJudgement(completion.content);
    } catch (err) {
      log.warn(`ReflectionOptimizer: judge call failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private parseProposal(raw: string): { hypothesis: string; new_system_prompt: string; changes_summary: string } | null {
    const obj = extractJsonObject(raw);
    if (!obj) return null;
    const hypothesis = typeof obj.hypothesis === "string" ? obj.hypothesis : "";
    const prompt = typeof obj.new_system_prompt === "string" ? obj.new_system_prompt.trim() : "";
    const summary = typeof obj.changes_summary === "string" ? obj.changes_summary : "";
    if (!prompt) return null;
    return { hypothesis, new_system_prompt: prompt, changes_summary: summary };
  }

  private parseJudgement(raw: string): { baseline_score: number; candidate_score: number; reasoning: string; winner: "baseline" | "candidate" | "tie" } | null {
    const obj = extractJsonObject(raw);
    if (!obj) return null;
    const baseline = clamp(Number(obj.baseline_score ?? 5), 0, 10);
    const candidate = clamp(Number(obj.candidate_score ?? 5), 0, 10);
    const reasoning = typeof obj.reasoning === "string" ? obj.reasoning : "";
    const w = String(obj.winner ?? "tie").toLowerCase();
    const winner: "baseline" | "candidate" | "tie" =
      w === "baseline" ? "baseline" : w === "candidate" ? "candidate" : "tie";
    return { baseline_score: baseline, candidate_score: candidate, reasoning, winner };
  }
}

function dedupeById<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  // Strip reasoning-model <think> blocks first (their prose contains braces).
  let cleaned = stripReasoning(raw).replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}
