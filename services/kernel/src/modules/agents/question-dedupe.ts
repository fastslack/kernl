/**
 * An office kept asking the operator the same thing: six of Growth's sixteen
 * open questions were "which repo owns miniatura.lat?", each from a different
 * agent or a different day, each worded differently. "Never re-ask" in the
 * prompt did not hold — the agent asking had not seen the others.
 *
 * Before a question is filed, it is compared with the office's open ones and
 * with the ones answered in the last DUPLICATE_WINDOW_DAYS. Identical text is
 * caught without a model; anything else goes to a judge that only says which
 * one, if any, asks for the same decision. Any judge failure files the
 * question: a lost question costs more than a repeated one.
 */
import { log } from "../../core/logger.js";
import type { AgentQuestion } from "./service.js";

export const DUPLICATE_WINDOW_DAYS = 21;
const JUDGE_MAX_TOKENS = 2000;
const JUDGE_ATTEMPTS = 2;

export type QuestionJudge = (opts: { system: string; user: string; maxTokens: number; caller: string }) => Promise<unknown>;

const SYSTEM =
  "An AI agent wants to ask its human operator a question. Below are the questions its office already has: " +
  "OPEN ones (waiting for an answer) and ANSWERED ones. Decide whether the NEW question asks for the same decision " +
  "or the same action from the operator as one of them — same subject, even if worded differently, asked by another " +
  "agent, or with different options. A question about a different decision, a different project or site, or one whose " +
  "context says the situation changed since an answered one (new facts, the answer did not work) is NOT a duplicate. " +
  'Return ONLY JSON: {"duplicate_of": "<id>" | null}.';

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function buildJudgePrompt(input: { question: string; context: string }, candidates: AgentQuestion[]): string {
  const line = (q: AgentQuestion) => q.status === "answered"
    ? `- id=${q.id} ANSWERED ${q.answered_at?.slice(0, 10) ?? ""}: ${q.question} → «${q.selected_option}»${q.answered_note ? ` ${q.answered_note.slice(0, 200)}` : ""}`
    : `- id=${q.id} OPEN since ${q.created_at.slice(0, 10)}: ${q.question}`;
  return [
    `NEW QUESTION: ${input.question}`,
    `NEW QUESTION CONTEXT: ${input.context.slice(0, 1500) || "(none)"}`,
    "OFFICE QUESTIONS:",
    candidates.map(line).join("\n"),
  ].join("\n");
}

/** The candidate the new question repeats, or null. */
export async function findDuplicateQuestion(
  input: { question: string; context: string },
  candidates: AgentQuestion[],
  judge: QuestionJudge | null,
): Promise<AgentQuestion | null> {
  if (candidates.length === 0) return null;
  const n = norm(input.question);
  const same = candidates.find((q) => norm(q.question) === n);
  if (same) return same;
  if (!judge) return null;
  // A reasoning model spends its budget thinking: with 200 tokens MiniMax replied nothing and three copies of one
  // question reached the operator in two minutes (08/11). Room to answer, and one more try before giving up.
  let last: unknown = null;
  for (let attempt = 1; attempt <= JUDGE_ATTEMPTS; attempt++) {
    try {
      const raw = (await judge({ system: SYSTEM, user: buildJudgePrompt(input, candidates), maxTokens: JUDGE_MAX_TOKENS, caller: "agents:question-dedupe" })) as
        { duplicate_of?: unknown } | null;
      const id = typeof raw?.duplicate_of === "string" ? raw.duplicate_of.trim() : "";
      return id ? candidates.find((q) => q.id === id) ?? null : null;
    } catch (err) {
      last = err;
    }
  }
  log.warn(`question-dedupe: judge failed ${JUDGE_ATTEMPTS} times, filing the question: ${last instanceof Error ? last.message : String(last)}`);
  return null;
}

/** What the asking agent reads instead of a new question id. */
export function duplicateReply(dup: AgentQuestion, askerName: (agentId: string) => string): string {
  const who = askerName(dup.from_agent_id);
  if (dup.status === "answered") {
    return `Not filed: this was already answered on ${dup.answered_at?.slice(0, 10) ?? "?"} (question ${dup.id}, asked by ${who}): ` +
      `«${dup.question}» → «${dup.selected_option}»${dup.answered_note ? ` — ${dup.answered_note}` : ""}. ` +
      "Act on that answer. Ask again only if something changed since, and say what in the context.";
  }
  const where = dup.status === "triage" ? "with the chief" : "with the operator";
  return `Not filed: question ${dup.id} (asked by ${who} on ${dup.created_at.slice(0, 10)}) already asks this and is waiting ${where}: ` +
    `«${dup.question}». Do not ask it again; the answer reaches the office when it comes. Keep working on what doesn't depend on it.`;
}
