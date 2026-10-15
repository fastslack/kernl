/**
 * The question investigator: a read-only claude_code agent the "¿Qué
 * contestaría la IA?" button starts on an escalated question.
 *
 * The opinion used to be one chat call on the default model chain (which on
 * this kind of instance starts with small models), with the question text and
 * nothing else; an operator pasting the same question into a coding session
 * got far better answers because that session read the issue, the MR and git
 * first. This agent does the same, and cannot write anything:
 *
 *  1. Its tools are a closed list of reads (INVESTIGATOR_TOOLS); every
 *     built-in that writes, runs commands or reaches the web is denied.
 *  2. No Docker sandbox (`__sandbox_driver__: "none"`): inside one the SDK
 *     runs with bypassPermissions and drops the allow rules; outside, with
 *     `dontAsk`, anything not allowed is refused.
 *  3. The kernel's MCP dispatch holds it to the same list
 *     (core/caller-tool-gate.ts), whatever its executor was told.
 *  4. One model, no fallback chain (QUESTION_OPINION_MODEL, Opus by default):
 *     if it cannot run, the card says "unavailable" instead of showing a
 *     worse opinion.
 *
 * The opinion is stored on the question; nothing is answered until the
 * operator presses Send.
 */
import type { EventBus } from "../../core/event-bus.js";
import type { KernelLanguage } from "../../core/config.js";
import { log } from "../../core/logger.js";
import { restrictCallerTools } from "../../core/caller-tool-gate.js";
import type { AgentService, AgentQuestion } from "./service.js";
import type { AgentExecutor } from "./executor.js";
import { startAgentRun } from "./start-run.js";
import { parseQuestionRefs } from "./question-refs.js";
import {
  INVESTIGATOR_PROMPT, buildInvestigationGoal, failureOf, parseOpinion, type KnownRepo, type OtherQuestion,
} from "./question-opinion.js";

export const INVESTIGATOR_ROLE = "question-investigator";

/** Everything the investigator may call. All of them only read. */
export const INVESTIGATOR_TOOLS = [
  "kernel_agents_question_context",
  "kernel_repos_list",
  "kernel_repos_get",
  "kernel_repos_list_files",
  "kernel_repos_read",
  "kernel_repos_search",
  "kernel_repos_git",
  "kernel_gitlab_issue_read",
  "kernel_gitlab_mr_read",
  "kernel_github_issue_read",
  "kernel_github_pr_read",
] as const;

/**
 * Claude Code built-ins it must not have. Read/Glob/Grep only reach its own
 * empty workspace, but the repos are read through kernel_repos_* (jailed per
 * repo), so they go too. ask_supervisor is denied because the executor adds it
 * to every agent with an allow list.
 */
export const INVESTIGATOR_DENIED = [
  "Bash", "BashOutput", "KillShell", "Edit", "MultiEdit", "Write", "NotebookEdit",
  "Read", "Glob", "Grep", "Task", "WebFetch", "WebSearch", "SlashCommand", "ExitPlanMode",
  "kernel_agents_ask_supervisor",
] as const;

export const DEFAULT_OPINION_MODEL = "claude-opus-5-5";
const MAX_TURNS = 30;
const TIMEOUT_MS = 8 * 60_000;
const SETTLE_TRIES = 120;
const SETTLE_EVERY_MS = 250;

/** The agent's fixed definition: re-asserted before every run, so an edit in the panel cannot widen it. */
export function investigatorDefinition(language: KernelLanguage, model = process.env.QUESTION_OPINION_MODEL || DEFAULT_OPINION_MODEL) {
  return {
    name: "Kernl Investigator",
    description: language === "es"
      ? "Investiga las preguntas escaladas antes de opinar: lee el issue, el MR, el código y git. Solo lectura. Lo lanza «¿Qué contestaría la IA?» en la tarjeta de la pregunta."
      : "Investigates escalated questions before giving an opinion: reads the issue, the MR, the code and git. Read-only. Started by \"What would the AI answer?\" on the question card.",
    system_prompt: INVESTIGATOR_PROMPT[language],
    allowed_tools: [...INVESTIGATOR_TOOLS] as string[],
    denied_tools: [...INVESTIGATOR_DENIED] as string[],
    variables: {
      __sandbox_driver__: "none",
      __permission_mode__: "dontAsk",
      __self_improve__: "false",
    } as Record<string, string>,
    model,
    max_iterations: MAX_TURNS,
    timeout_ms: TIMEOUT_MS,
  };
}

export interface OpinionState {
  status: "" | "running" | "ready" | "failed";
  run_id: string;
  opinion: Record<string, unknown> | null;
  /** When failed. */
  reason?: "no_answer" | "unavailable";
  detail?: string;
}

export function opinionStateOf(q: AgentQuestion): OpinionState {
  const base = { status: q.opinion_status, run_id: q.opinion_run_id, opinion: q.opinion };
  if (q.opinion_status !== "failed") return base;
  const [reason, ...rest] = q.opinion_error.split(": ");
  return { ...base, reason: reason === "unavailable" ? "unavailable" : "no_answer", detail: rest.join(": ") };
}

export interface QuestionInvestigator {
  /** Start (or join) the investigation of a question. */
  start(questionId: string): OpinionState;
  state(questionId: string): OpinionState | null;
}

export function createQuestionInvestigator(deps: {
  service: AgentService;
  executor: Pick<AgentExecutor, "execute">;
  events: EventBus;
  language: KernelLanguage;
}): QuestionInvestigator {
  const { service, executor, events, language } = deps;

  const ensureAgent = (): string => {
    const def = investigatorDefinition(language);
    let id = service.getSystemAgentId(INVESTIGATOR_ROLE);
    let agent = id ? service.getAgent(id) : undefined;
    if (!agent) {
      agent = service.createAgent({ ...def, show_on_dashboard: false });
      id = agent.id;
      service.setSystemAgentId(INVESTIGATOR_ROLE, id);
    }
    service.updateAgent(id, {
      system_prompt: def.system_prompt, allowed_tools: def.allowed_tools, denied_tools: def.denied_tools,
      variables: def.variables, model: def.model, max_iterations: def.max_iterations, timeout_ms: def.timeout_ms,
      active: true,
    });
    service.setExecutorType(id, "claude_code");
    // Three failed opinions in a row (an expired Claude session) trip the breaker and the chief hears
    // about it; the next click is the operator trying again, so it starts clean.
    service.clearAutoPause(id);
    restrictCallerTools(id, INVESTIGATOR_TOOLS);
    return id;
  };

  const knownRepos = (): KnownRepo[] => {
    try {
      return service.getDb()
        .prepare("SELECT name, remote_url FROM repos WHERE deleted_at IS NULL ORDER BY name")
        .all() as KnownRepo[];
    } catch {
      return []; // the repos extension is not installed
    }
  };

  /** Every question waiting on the operator except `id`: the ones an opinion may also settle. */
  const openOthers = (id: string): AgentQuestion[] =>
    (["pending", "owed"] as const)
      .flatMap((status) => service.listQuestions({ status, limit: 200 }))
      .filter((o) => o.id !== id);

  const finish = (q: AgentQuestion, run: { status: string; result: string; error: string }) => {
    if (run.status === "completed") {
      // Checked against what is open NOW: one answered meanwhile drops out.
      const open = new Map(openOthers(q.id).map((o) => [o.id, o.options.length]));
      const opinion = parseOpinion(run.result ?? "", q.options.length, open);
      service.finishQuestionOpinion(q.id, opinion
        ? { opinion: opinion as unknown as Record<string, unknown> }
        : { error: `no_answer: ${(run.result ?? "").slice(-1500) || "the investigator ended without an answer"}` });
    } else {
      const err = run.error || `run ${run.status}`;
      service.finishQuestionOpinion(q.id, { error: `${failureOf(err)}: ${err}` });
    }
    events.emit("agent:flow:question_opinion", { question_id: q.id, status: service.getQuestion(q.id)?.opinion_status ?? "" });
  };

  // The executor emits run_completed before startAgentRun writes the run's
  // status and result, so the row may still say "running" here: wait for it
  // (it follows within milliseconds) instead of reading an empty result.
  const settle = async (runId: string): Promise<void> => {
    for (let i = 0; i < SETTLE_TRIES; i++) {
      const q = service.getQuestionByOpinionRun(runId);
      if (!q || q.opinion_status !== "running") return;
      const run = service.getRun(runId);
      if (run && run.status !== "running" && run.status !== "pending") {
        finish(q, { status: run.status, result: run.result ?? "", error: run.error ?? "" });
        return;
      }
      await new Promise((r) => setTimeout(r, SETTLE_EVERY_MS));
    }
    const q = service.getQuestionByOpinionRun(runId);
    if (q?.opinion_status === "running") finish(q, { status: "failed", result: "", error: "the investigator's run never recorded its end" });
  };

  events.on("agent:flow:run_completed", (payload) => {
    const runId = (payload as { run_id?: unknown })?.run_id;
    if (typeof runId !== "string" || !runId || !service.getQuestionByOpinionRun(runId)) return;
    void settle(runId).catch((e) => log.warn(`Question investigator: finishing run ${runId} failed: ${(e as Error).message}`));
  });

  // Investigations that ended (or died) while the kernel was down.
  try {
    // The fixed agent comes back with its gate on, even before anyone asks.
    if (service.getSystemAgentId(INVESTIGATOR_ROLE)) ensureAgent();
    for (const q of service.listRunningOpinions()) {
      const run = service.getRun(q.opinion_run_id);
      if (!run) finish(q, { status: "failed", result: "", error: "the investigation was lost in a kernel restart" });
      else if (run.status !== "running" && run.status !== "pending") finish(q, { status: run.status, result: run.result ?? "", error: run.error ?? "" });
    }
  } catch (e) {
    log.warn(`Question investigator: startup sweep failed: ${(e as Error).message}`);
  }

  return {
    start(questionId) {
      const q = service.getQuestion(questionId);
      if (!q) throw new Error("Question not found");
      if (q.opinion_status === "running") {
        const run = service.getRun(q.opinion_run_id);
        if (run && (run.status === "running" || run.status === "pending")) return opinionStateOf(q);
      }
      const agentId = ensureAgent();
      const agent = service.getAgent(agentId)!;
      const asker = service.getAgent(q.from_agent_id);
      const others: OtherQuestion[] = openOthers(q.id).map((o) => ({
        id: o.id,
        agent: service.getAgent(o.from_agent_id)?.name ?? o.from_agent_id,
        question: o.question,
        options: o.options.map((x) => x.label),
      }));
      const goal = buildInvestigationGoal(q, asker ? { name: asker.name, description: asker.description } : undefined,
        parseQuestionRefs(q.question, q.chief_note, q.context), knownRepos(), others);
      const run = startAgentRun({ service, executor, events }, { agent, goal, triggerPayload: { question_id: q.id } });
      service.startQuestionOpinion(q.id, run.id);
      return opinionStateOf(service.getQuestion(q.id)!);
    },
    state(questionId) {
      const q = service.getQuestion(questionId);
      return q ? opinionStateOf(q) : null;
    },
  };
}
