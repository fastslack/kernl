/**
 * A second opinion on a question an agent escalated to the operator.
 *
 * The operator sees four options written by the chief, who escalated because
 * it was not sure. This asks the LLM to read the same material and say what
 * it would answer — which may be one of the four or something else — so the
 * card can offer it as a fifth option. Read-only: nothing is answered here.
 */
import type { KernelLanguage } from "../../core/config.js";
import type { AgentQuestion } from "./service.js";

export interface QuestionOpinion {
  /** The answer it would send, ready to deliver as a free answer. */
  answer: string;
  /** Why, in two or three sentences, for the operator. */
  reasoning: string;
  /** 0-based index of the chief's option it agrees with, or null when none fits. */
  matches_option: number | null;
}

export interface OpinionAsker {
  name: string;
  description?: string;
}

type ChatJson = (opts: { system: string; user: string; maxTokens: number; caller: string }) => Promise<unknown>;

const SYSTEM: Record<KernelLanguage, string> = {
  es:
    "Sos un asesor técnico del operador de Kernl, un sistema de oficinas de agentes de IA. " +
    "Un agente se trabó y escaló una pregunta; el chief propuso opciones pero no estaba seguro. " +
    "Leé la pregunta, el motivo del chief, el contexto y las opciones, y decí qué contestarías vos. " +
    "Si una opción es correcta, elegila; si ninguna lo es, proponé la tuya. " +
    "La respuesta va directo al agente: escribila como una instrucción concreta y accionable, en español rioplatense, en 1 a 3 oraciones. " +
    "Si con lo que tenés no alcanza para decidir, decilo en la respuesta y pedí al agente el dato puntual que falta. " +
    'Devolvé SOLO JSON: {"answer": string, "reasoning": string, "matches_option": number|null} ' +
    "(matches_option es el número de opción empezando en 1, o null).",
  en:
    "You advise the operator of Kernl, a system of AI agent offices. " +
    "An agent got stuck and escalated a question; the chief proposed options but was not sure. " +
    "Read the question, the chief's reason, the context and the options, and say what you would answer. " +
    "If one option is right, pick it; if none is, propose your own. " +
    "The answer goes straight to the agent: write it as a concrete, actionable instruction in 1 to 3 sentences. " +
    "If what you have is not enough to decide, say so in the answer and ask the agent for the specific missing fact. " +
    'Return ONLY JSON: {"answer": string, "reasoning": string, "matches_option": number|null} ' +
    "(matches_option is the 1-based option number, or null).",
};

export function buildOpinionPrompt(q: AgentQuestion, asker: OpinionAsker | undefined): string {
  const lines = [
    `Agente: ${asker?.name ?? q.from_agent_id}${asker?.description ? ` — ${asker.description}` : ""}`,
    `Pregunta: ${q.question}`,
  ];
  if (q.chief_note) lines.push(`Motivo del chief para escalarla: ${q.chief_note}`);
  if (q.context) lines.push(`Contexto:\n${q.context.slice(0, 6000)}`);
  lines.push("Opciones:", ...q.options.map((o, i) => `${i + 1}. ${o.label}${o.value && o.value !== o.label ? ` (${o.value})` : ""}`));
  return lines.join("\n");
}

/**
 * Why there is no opinion, in terms the card can explain. `no_answer`: a model
 * answered but never got to the JSON (a reasoning model that thinks out loud
 * and runs out of room, or one that ignores the format). `unavailable`: no
 * model answered at all.
 */
export class OpinionError extends Error {
  constructor(readonly reason: "no_answer" | "unavailable", readonly detail: string) {
    super(detail);
    this.name = "OpinionError";
  }
}

/**
 * Reasoning models (nemotron-3-super on NVIDIA, measured 2026-10-08) think in
 * plain text before answering: at 700 tokens the reply was cut mid-thought,
 * "We need to produce JSON with answer, reasoning…", and the card showed that
 * raw. So: room to think, and one stricter retry before giving up.
 */
const FIRST_BUDGET = 2500;
const RETRY_BUDGET = 5000;
const RETRY_NUDGE: Record<KernelLanguage, string> = {
  es: "\n\nIMPORTANTE: tu respuesta anterior no fue el JSON. Respondé únicamente con el objeto JSON, sin razonamiento ni texto antes o después.",
  en: "\n\nIMPORTANT: your previous reply was not the JSON. Reply with the JSON object only, with no reasoning or text before or after it.",
};

const NO_JSON = /did not return JSON|no answer/i;

export async function askOpinion(
  q: AgentQuestion,
  asker: OpinionAsker | undefined,
  language: KernelLanguage,
  chatJson: ChatJson,
): Promise<QuestionOpinion> {
  const user = buildOpinionPrompt(q, asker);
  let lastNoJson = "";
  for (const attempt of [0, 1]) {
    let raw: Partial<{ answer: unknown; reasoning: unknown; matches_option: unknown }> | null;
    try {
      raw = (await chatJson({
        system: SYSTEM[language] + (attempt === 1 ? RETRY_NUDGE[language] : ""),
        user,
        maxTokens: attempt === 0 ? FIRST_BUDGET : RETRY_BUDGET,
        caller: "agents:question-opinion",
      })) as typeof raw;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!NO_JSON.test(msg)) throw new OpinionError("unavailable", msg);
      lastNoJson = msg;
      continue;
    }
    const answer = typeof raw?.answer === "string" ? raw.answer.trim() : "";
    if (!answer) {
      lastNoJson = "LLM returned no answer";
      continue;
    }
    const n = typeof raw?.matches_option === "number" ? Math.trunc(raw.matches_option) : NaN;
    return {
      answer,
      reasoning: typeof raw?.reasoning === "string" ? raw.reasoning.trim() : "",
      matches_option: n >= 1 && n <= q.options.length ? n - 1 : null,
    };
  }
  throw new OpinionError("no_answer", lastNoJson);
}
