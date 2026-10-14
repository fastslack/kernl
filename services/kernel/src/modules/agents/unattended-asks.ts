/**
 * Runs nobody watches — started by a schedule or an event, with no parent run
 * — end in a summary only someone opening the agent panel would read. Agents
 * still wrote "what you have to do" lists there (an article waiting for
 * approval, an email account to link, a connector to authorize) and nothing
 * reached the operator.
 *
 * Two layers:
 *  1. The goal of an unattended run carries UNATTENDED_NOTE: anything that
 *     needs the operator goes through kernel_agents_ask_supervisor.
 *  2. UnattendedAskWatcher: when such a run ends without having asked, an LLM
 *     reads its result; if it leaves something for the operator, the watcher
 *     files that question to the chief on the agent's behalf (the chief
 *     answers it or escalates it, as with any agent question).
 */
import type { EventBus } from "../../core/event-bus.js";
import { log } from "../../core/logger.js";
import type { Agent, AgentRun } from "./types.js";
import type { AgentQuestion } from "./service.js";

/** A run with no person watching: a schedule or an event started it, not a person or another run. */
export function isUnattended(run: Pick<AgentRun, "trigger_type" | "parent_run_id">): boolean {
  return (run.trigger_type === "schedule" || run.trigger_type === "event") && !run.parent_run_id;
}

export const UNATTENDED_NOTE =
  "\n\n---\nNobody is watching this run: a schedule or an event started it, and nobody reads your final summary. " +
  "If anything needs the operator — an approval, a decision, an account or permission to set up, anything only they can do — " +
  "call kernel_agents_ask_supervisor for it before you finish (one question per decision, exactly 4 options, your recommended one first). " +
  "Never end with a list of things for the operator to do: a list in your summary reaches nobody. If nothing needs the operator, do not ask.";

/** The goal the executor runs: an unattended run's goal carries UNATTENDED_NOTE. */
export function goalForRun(goal: string, run: Pick<AgentRun, "trigger_type" | "parent_run_id">, agent: Pick<Agent, "builtin_handler">): string {
  if (agent.builtin_handler || !isUnattended(run) || goal.includes(UNATTENDED_NOTE)) return goal;
  return goal + UNATTENDED_NOTE;
}

export interface OperatorAsk {
  question: string;
  context: string;
  options: Array<{ label: string }>;
}

type ChatJson = (opts: { system: string; user: string; maxTokens: number; caller: string }) => Promise<unknown>;

const SYSTEM =
  "You read the final report of an AI agent that ran unattended (on a schedule). Nobody reads these reports, " +
  "so your job is to catch what the agent left for the human operator to do or decide: an approval, a review, " +
  "a decision, an account/permission/connector to set up, information only the operator has. " +
  "Ignore what the agent did itself, notes like 'no action required', and things it delegated to other agents. " +
  "Ignore anything already covered by one of the operator's OPEN QUESTIONS listed in the input. " +
  "If something is left for the operator, turn it into ONE question for them (the most important one), with context " +
  "(2-4 sentences: what happened, what is blocked, where to look — file paths, ids) and exactly 4 short options, " +
  "the recommended one first. Write in the same language as the report. " +
  'Return ONLY JSON: {"needs_operator": boolean, "question": string, "context": string, "options": [string, string, string, string]}.';

export function buildAskPrompt(input: { agentName: string; goal: string; result: string; openQuestions: string[] }): string {
  return [
    `AGENT: ${input.agentName}`,
    `GOAL (what the run was asked): ${input.goal.replace(UNATTENDED_NOTE, "").slice(0, 1500)}`,
    `OPEN QUESTIONS already waiting for the operator from this agent:`,
    input.openQuestions.length ? input.openQuestions.map((q) => `- ${q}`).join("\n") : "- (none)",
    `REPORT:`,
    input.result.slice(-8000),
  ].join("\n");
}

/** What the report leaves for the operator, as a question — or null when nothing. */
export async function detectOperatorAsk(
  input: { agentName: string; goal: string; result: string; openQuestions: string[] },
  chatJson: ChatJson,
): Promise<OperatorAsk | null> {
  const raw = (await chatJson({
    system: SYSTEM,
    user: buildAskPrompt(input),
    maxTokens: 2000,
    caller: "agents:unattended-ask",
  })) as Partial<{ needs_operator: unknown; question: unknown; context: unknown; options: unknown }> | null;
  if (raw?.needs_operator !== true) return null;
  const question = typeof raw.question === "string" ? raw.question.trim() : "";
  const options = Array.isArray(raw.options)
    ? raw.options.map((o) => (typeof o === "string" ? o.trim() : "")).filter(Boolean).slice(0, 4)
    : [];
  if (!question || options.length !== 4) return null;
  return {
    question: question.slice(0, 500),
    context: (typeof raw.context === "string" ? raw.context.trim() : "").slice(0, 4000),
    options: options.map((label) => ({ label: label.slice(0, 120) })),
  };
}

/** What the watcher needs from AgentService. */
export interface UnattendedAskService {
  getRun(id: string): AgentRun | undefined | null;
  getAgent(id: string): Agent | undefined;
  getSteps(runId: string): Array<{ tool_name?: string | null }>;
  listQuestions(opts?: { status?: AgentQuestion["status"]; limit?: number }): AgentQuestion[];
  createQuestion(input: {
    from_agent_id: string; flow_id?: string; run_id?: string; question: string; context?: string;
    options: Array<{ label: string; value?: string }>;
  }): { id: string; status: "triage" | "pending" };
}

export class UnattendedAskWatcher {
  constructor(
    private readonly service: UnattendedAskService,
    private readonly events: EventBus,
    private readonly chatJson: ChatJson,
    private readonly delayMs = 3000,
  ) {}

  start(): void {
    this.events.on("agent:flow:run_completed", (payload) => {
      const runId = (payload as { run_id?: unknown })?.run_id;
      if (typeof runId !== "string" || !runId) return;
      // The event can beat the row's final status by a moment; read it a little later.
      setTimeout(() => {
        void this.check(runId).catch((e) => log.warn(`unattended-ask: run ${runId}: ${(e as Error).message}`));
      }, this.delayMs);
    });
  }

  /** Open questions (waiting on the chief or the operator) asked by this agent. */
  private openQuestions(agentId: string): AgentQuestion[] {
    return [
      ...this.service.listQuestions({ status: "triage", limit: 200 }),
      ...this.service.listQuestions({ status: "pending", limit: 200 }),
    ].filter((q) => q.from_agent_id === agentId);
  }

  /** Files the operator's question for an unattended run that ended without asking. Returns its id, or null. */
  async check(runId: string): Promise<string | null> {
    const run = this.service.getRun(runId);
    if (!run || run.status !== "completed" || !isUnattended(run)) return null;
    const agent = this.service.getAgent(run.agent_id);
    if (!agent || agent.builtin_handler) return null;
    const result = (run.result ?? "").trim();
    if (result.length < 40) return null;
    if (this.service.getSteps(runId).some((s) => /ask_supervisor/.test(s.tool_name ?? ""))) return null;

    const open = this.openQuestions(agent.id);
    const ask = await detectOperatorAsk(
      { agentName: agent.name, goal: run.goal ?? "", result, openQuestions: open.map((q) => q.question) },
      this.chatJson,
    );
    if (!ask) return null;
    // The model was told about the open ones; still never file the same text twice.
    if (open.some((q) => q.question.trim().toLowerCase() === ask.question.toLowerCase())) return null;
    const res = this.service.createQuestion({
      from_agent_id: agent.id,
      flow_id: agent.flow_id ?? "",
      run_id: runId,
      question: ask.question,
      context: `${ask.context}\n\n(Raised by Kernl from the report of an unattended run — the agent did not ask itself.)`,
      options: ask.options,
    });
    log.info(`unattended-ask: ${agent.name} run ${runId} left something for the operator → question ${res.id} (${res.status})`);
    return res.id;
  }
}
