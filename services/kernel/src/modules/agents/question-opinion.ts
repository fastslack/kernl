/**
 * A second opinion on a question an agent escalated to the operator.
 *
 * The operator sees four options written by the chief, who escalated because
 * it was not sure. The opinion used to be one chat call over the question
 * text, on whatever model the default chain picked: it stayed inside the
 * chief's four options and never looked at the issue, the MR or the code.
 * Now an investigator agent reads them first (question-investigator.ts);
 * this file holds what it is told and how its answer is read back.
 * Read-only: nothing is answered here.
 */
import type { KernelLanguage } from "../../core/config.js";
import type { AgentQuestion } from "./service.js";
import type { QuestionRefs } from "./question-refs.js";

export interface QuestionOpinion {
  /** The instruction for the agent, ready to send; numbered conditions when they matter. */
  answer: string;
  /** Why, for the operator, citing the evidence. */
  reasoning: string;
  /** 0-based index of the chief's option it picks, or null when none fits. */
  matches_option: number | null;
  /** It picks matches_option but adds conditions: the answer, not the bare option, is what to send. */
  extends_option: boolean;
  /** What it read or checked: issue, MR, file:line, git command. */
  evidence: string[];
  /** What it states without having been able to check it. */
  unverified: string[];
  /** What only the operator can do (a query in PROD, a decision nobody wrote down). */
  needs_human: string[];
  /** Other open questions this investigation also settles, each with its own pick. */
  also_answers: AlsoAnswer[];
}

/** Another open question the same evidence answers. */
export interface AlsoAnswer {
  question_id: string;
  /** 0-based index of THAT question's option, or null: then `answer` is sent as free text. */
  option: number | null;
  /** The instruction for that question's agent. */
  answer: string;
  /** Why the same evidence settles it, for the operator. */
  why: string;
}

/** Another open question, as the investigator sees it in its goal. */
export interface OtherQuestion {
  id: string;
  agent: string;
  question: string;
  options: string[];
}

export interface OpinionAsker {
  name: string;
  description?: string;
}

/** A registered repo, so `web#2595` can be read from the right forge project. */
export interface KnownRepo {
  name: string;
  remote_url: string;
}

/**
 * The investigator's standing instructions (appended to its system prompt).
 * The goal of each run carries the question itself.
 */
export const INVESTIGATOR_PROMPT: Record<KernelLanguage, string> = {
  es: `Sos el investigador de preguntas escaladas de Kernl. Un agente de una oficina se trabó y escaló una
pregunta; el chief propuso 4 opciones pero no estaba seguro, y el operador te pide tu opinión ANTES de
contestar. Tu opinión no contesta nada: el operador la lee y decide.

Solo podés LEER: issues y merge requests (kernel_gitlab_issue_read, kernel_gitlab_mr_read,
kernel_github_issue_read, kernel_github_pr_read), el código y el git de los repos registrados
(kernel_repos_list, kernel_repos_get, kernel_repos_read, kernel_repos_search, kernel_repos_git) y la
pregunta con la corrida del agente que la hizo (kernel_agents_question_context). No tenés nada que escriba.

Antes de opinar, siempre:
1. kernel_agents_question_context con el question_id: la pregunta entera y qué estaba haciendo el agente.
2. Leé el issue: descripción y últimos comentarios (sobre todo el último de quien hace QA y los
   criterios de aceptación).
3. Si la pregunta nombra un MR, leé su descripción y su diff (patch: true en los archivos que importan).
4. Verificá en el código o en git cada afirmación en la que se apoya la decisión. Si una pregunta se
   responde con un dato verificable (git log entre ramas, un grep, el texto del issue), verificalo en vez
   de preguntarlo. Ejemplo: "¿esto ya está en producción?" se contesta con kernel_repos_git op log,
   ref "origin/stable..origin/develop", grep con el número de issue.
   Los checkouts de los repos pueden estar en otra rama o con cambios sin commitear: para leer lo que
   está en una rama, kernel_repos_read con ref (ej. "origin/develop").

Cómo pensar:
- Las opciones del chief pueden estar todas mal, incompletas o mal planteadas. Tu trabajo principal es
  encontrar lo que se les escapa: efectos colaterales, filtraciones por otro camino (un estado que
  cambia en otra tabla o en otra pantalla y delata lo que se quería ocultar), datos que ya se pueden
  obtener sin pedirlos, supuestos falsos sobre quién puede hacer qué.
- El operador tiene acceso a GitLab, al servidor y a PROD. Nunca recomiendes "que lo haga otra persona
  con acceso": si hay que hacerlo, la recomendación es hacerlo, con el comando o el link listos.
- Separá la decisión de PRODUCTO (si el issue ya la define, citá el punto textual y seguilo) de la
  decisión TÉCNICA (resolvela vos con un default sensato y decí cuál).
- Si elegís una opción del chief pero le faltan condiciones, decilo: matches_option = esa opción y
  extends_option = true, con las condiciones numeradas en answer.
- El goal trae las OTRAS preguntas abiertas. Si lo que investigaste también resuelve alguna (el mismo
  issue o MR, la misma causa, la misma decisión de producto), sumala en also_answers con SU opción. Que se
  parezcan no alcanza: "Reanudar" en un MR no es "Reanudar" en otro. Solo las que tu evidencia cubre;
  ante la duda, afuera. No investigues cada una desde cero: es un extra de lo que ya leíste.

Tu mensaje final es SOLO este JSON, sin texto antes ni después:
{"answer": string, "reasoning": string, "matches_option": number|null, "extends_option": boolean,
 "evidence": string[], "unverified": string[], "needs_human": string[],
 "also_answers": [{"question_id": string, "option": number|null, "answer": string, "why": string}]}
- answer: la instrucción para el agente, lista para pegar, en español rioplatense, concreta; condiciones
  numeradas si hacen falta.
- reasoning: por qué, para el operador, citando la evidencia ("api!95, descripción, sección 'Al
  rechazar'", "git: los 7 commits ya están en origin/stable").
- matches_option: el número de opción empezando en 1, o null si ninguna sirve.
- evidence: cada cosa que leíste o verificaste (issue, MR, archivo:línea, comando git con su resultado).
- unverified: lo que afirmás sin haberlo podido verificar.
- needs_human: lo que solo el operador puede hacer, separado del resto.
- also_answers: [] si ninguna otra se resuelve con lo mismo. option = el número de opción DE ESA pregunta
  empezando en 1, o null si ninguna sirve (entonces answer va como texto libre); why = qué evidencia la
  cubre.`,
  en: `You are Kernl's investigator of escalated questions. An office agent got stuck and escalated a
question; the chief proposed 4 options but was not sure, and the operator asks for your opinion BEFORE
answering. Your opinion answers nothing: the operator reads it and decides.

You can only READ: issues and merge requests (kernel_gitlab_issue_read, kernel_gitlab_mr_read,
kernel_github_issue_read, kernel_github_pr_read), the code and git of the registered repos
(kernel_repos_list, kernel_repos_get, kernel_repos_read, kernel_repos_search, kernel_repos_git) and the
question with the asking agent's run (kernel_agents_question_context). Nothing you have writes.

Before giving an opinion, always:
1. kernel_agents_question_context with the question_id: the whole question and what the agent was doing.
2. Read the issue: description and latest comments (above all the last one from whoever does QA, and the
   acceptance criteria).
3. If the question names an MR, read its description and diff (patch: true on the files that matter).
4. Check in the code or in git every claim the decision rests on. If a question can be answered with a
   verifiable fact (git log between branches, a grep, the issue text), verify it instead of asking. E.g.
   "is this already in production?" is answered with kernel_repos_git op log, ref
   "origin/stable..origin/develop", grep with the issue number.
   Repo checkouts may be on another branch or carry uncommitted changes: to read what a branch has, use
   kernel_repos_read with ref (e.g. "origin/develop").

How to think:
- The chief's options may all be wrong, incomplete or badly framed. Your main job is finding what they
  miss: side effects, leaks through another path (a state that changes in another table or screen and
  gives away what was meant to stay hidden), data that can already be obtained without asking, false
  assumptions about who can do what.
- The operator has access to GitLab, the server and PROD. Never recommend "have someone else with access
  do it": if it has to be done, the recommendation is doing it, with the command or link ready.
- Separate the PRODUCT decision (if the issue already defines it, quote the point and follow it) from the
  TECHNICAL decision (settle it yourself with a sensible default and say which).
- If you pick one of the chief's options but it lacks conditions, say so: matches_option = that option and
  extends_option = true, with the conditions numbered in answer.
- The goal lists the OTHER open questions. If what you investigated also settles one of them (the same
  issue or MR, the same cause, the same product decision), add it to also_answers with ITS option. Looking
  alike is not enough: "Resume" on one MR is not "Resume" on another. Only those your evidence covers;
  when in doubt, leave it out. Do not investigate each from scratch: it is an extra on what you read.

Your final message is ONLY this JSON, with no text before or after:
{"answer": string, "reasoning": string, "matches_option": number|null, "extends_option": boolean,
 "evidence": string[], "unverified": string[], "needs_human": string[],
 "also_answers": [{"question_id": string, "option": number|null, "answer": string, "why": string}]}
- answer: the instruction for the agent, ready to paste, concrete; numbered conditions when needed.
- reasoning: why, for the operator, citing the evidence.
- matches_option: the 1-based option number, or null when none fits.
- evidence: each thing you read or checked (issue, MR, file:line, git command and what it showed).
- unverified: what you state without having been able to check it.
- needs_human: what only the operator can do, kept apart.
- also_answers: [] when no other question is settled by the same. option = THAT question's 1-based option
  number, or null when none fits (answer then goes as free text); why = what evidence covers it.`,
};

const MAX_CONTEXT = 40_000;
/** How many other open questions the goal lists, and how much of each. */
const MAX_OTHERS = 30;
const MAX_OTHER_TEXT = 400;

/** `git@gitlab.com:heural/web.git` → `gitlab.com/heural/web`; "" when it is not a forge remote. */
export function forgeProjectOf(remoteUrl: string): string {
  const s = remoteUrl.trim();
  const scp = /^[\w.-]+@([\w.-]+):(.+?)(?:\.git)?\/?$/.exec(s);
  if (scp) return `${scp[1]}/${scp[2]}`;
  try {
    const u = new URL(s);
    if (!/^(https?|ssh):$/.test(u.protocol)) return "";
    const path = u.pathname.replace(/^\/+/, "").replace(/\.git$/, "").replace(/\/+$/, "");
    return path ? `${u.hostname}/${path}` : "";
  } catch {
    return "";
  }
}

/** The run's goal: the question, everything the chief saw, and where to start reading. */
export function buildInvestigationGoal(
  q: AgentQuestion,
  asker: OpinionAsker | undefined,
  refs: QuestionRefs,
  repos: KnownRepo[],
  others: OtherQuestion[] = [],
): string {
  const lines = [
    `question_id: ${q.id}`,
    `Agente que pregunta: ${asker?.name ?? q.from_agent_id}${asker?.description ? ` — ${asker.description}` : ""}`,
    `Pregunta: ${q.question}`,
  ];
  if (q.chief_note) lines.push(`Motivo del chief para escalarla: ${q.chief_note}`);
  if (q.context) {
    const ctx = q.context.length > MAX_CONTEXT
      ? `${q.context.slice(0, MAX_CONTEXT)}\n… (${q.context.length - MAX_CONTEXT} caracteres más: kernel_agents_question_context los trae enteros)`
      : q.context;
    lines.push(`Contexto:\n${ctx}`);
  }
  lines.push("Opciones del chief:", ...q.options.map((o, i) => `${i + 1}. ${o.label}${o.value && o.value !== o.label ? ` (${o.value})` : ""}`));

  const byName = new Map(repos.map((r) => [r.name.toLowerCase(), r]));
  const project = (repo: string) => {
    const r = byName.get(repo);
    return r ? forgeProjectOf(r.remote_url) : "";
  };
  const start: string[] = [];
  for (const i of refs.issues) {
    const p = i.repo ? project(i.repo) : "";
    start.push(p ? `- issue ${i.repo}#${i.number}: project "${p}", number ${i.number}` : `- issue ${i.repo || ""}#${i.number}${i.repo ? " (repo no registrado: buscalo con kernel_repos_list)" : " (sin repo: deducilo del contexto)"}`);
  }
  for (const c of refs.changes) {
    const p = c.repo ? project(c.repo) : "";
    start.push(p ? `- MR ${c.repo}!${c.number}: project "${p}", number ${c.number}` : `- MR ${c.repo || ""}!${c.number}${c.repo ? " (repo no registrado)" : " (sin repo: deducilo del contexto)"}`);
  }
  for (const s of refs.shas) start.push(`- commit ${s}`);
  for (const p of refs.paths) start.push(`- archivo ${p.path}${p.line ? `:${p.line}` : ""}`);
  if (start.length) lines.push("Referencias detectadas (empezá por acá):", ...start);
  if (repos.length) {
    lines.push("Repos registrados (name → proyecto en la forja):",
      ...repos.map((r) => `- ${r.name}${forgeProjectOf(r.remote_url) ? ` → ${forgeProjectOf(r.remote_url)}` : ""}`));
  }
  const listed = others.filter((o) => o.id !== q.id).slice(0, MAX_OTHERS);
  if (listed.length) {
    lines.push("Otras preguntas abiertas (para also_answers; no las investigues de cero):");
    for (const o of listed) {
      const text = o.question.length > MAX_OTHER_TEXT ? `${o.question.slice(0, MAX_OTHER_TEXT)}…` : o.question;
      lines.push(`- question_id ${o.id} — ${o.agent}: ${text}`, ...o.options.map((l, i) => `    ${i + 1}. ${l}`));
    }
  }
  return lines.join("\n");
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const strList = (v: unknown) =>
  Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean).slice(0, 40) : [];

/** The JSON object in a final message: bare, fenced, or after some prose. */
function extractJson(text: string): unknown {
  const t = text.trim();
  const tries = [t];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) tries.push(fence[1].trim());
  const first = t.indexOf("{"), last = t.lastIndexOf("}");
  if (first >= 0 && last > first) tries.push(t.slice(first, last + 1));
  for (const s of tries) {
    try { return JSON.parse(s); } catch { /* next */ }
  }
  return null;
}

/**
 * Read the investigator's final message. The old shape ({answer, reasoning,
 * matches_option}) is still accepted, with the new lists empty. null when
 * there is no answer in it.
 */
export function parseOpinion(
  text: string,
  optionCount: number,
  /** The other questions still open: id → how many options it has. */
  others: ReadonlyMap<string, number> = new Map(),
): QuestionOpinion | null {
  const raw = extractJson(text) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object") return null;
  const answer = str(raw.answer);
  if (!answer) return null;
  const n = typeof raw.matches_option === "number" ? Math.trunc(raw.matches_option) : NaN;
  const matches = n >= 1 && n <= optionCount ? n - 1 : null;
  return {
    answer,
    reasoning: str(raw.reasoning),
    matches_option: matches,
    extends_option: matches !== null && raw.extends_option === true,
    evidence: strList(raw.evidence),
    unverified: strList(raw.unverified),
    needs_human: strList(raw.needs_human),
    also_answers: alsoAnswers(raw.also_answers, others),
  };
}

/** Only questions still open, each once, with an option that exists or a free answer. */
function alsoAnswers(v: unknown, others: ReadonlyMap<string, number>): AlsoAnswer[] {
  if (!Array.isArray(v)) return [];
  const out: AlsoAnswer[] = [];
  for (const x of v) {
    if (!x || typeof x !== "object") continue;
    const r = x as Record<string, unknown>;
    const id = str(r.question_id);
    const count = others.get(id);
    if (count === undefined || out.some((a) => a.question_id === id)) continue;
    const n = typeof r.option === "number" ? Math.trunc(r.option) : NaN;
    const option = n >= 1 && n <= count ? n - 1 : null;
    const answer = str(r.answer);
    if (option === null && !answer) continue;
    out.push({ question_id: id, option, answer, why: str(r.why) });
  }
  return out;
}

/**
 * Why there is no opinion, in terms the card can explain. `no_answer`: the
 * investigator ran but its final message had no answer. `unavailable`: the
 * model could not be reached (no Claude session, rate limit, the run failed
 * to start). There is no fallback to a smaller model on purpose.
 */
export type OpinionFailure = "no_answer" | "unavailable";

/** A failed run's error, sorted into what the card says. */
export function failureOf(error: string): OpinionFailure {
  return /not logged in|oauth|credit balance|rate.?limit|429|overloaded|claude code cli|claude login|api key|authentication|unavailable|ENOENT|spawn/i.test(error)
    ? "unavailable"
    : "no_answer";
}
