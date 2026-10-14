import type { AgentQuestion } from "../../modules/agents/service.js";
import type { KernelLanguage } from "../config.js";
import type { OperatorButton } from "./types.js";

type Kind = "ask" | "owed" | "remind";

/** Every operator-facing text of the driver, per kernel language. */
const STRINGS = {
  es: {
    someone: "Un agente",
    asks: "Te necesita",
    remind: "Recordatorio",
    owedTag: (opt: string) => `Te toca (elegiste: ${opt})`,
    take: "Lo veo yo",
    done: "Listo",
    dismiss: "Descartar",
    dismissed: "DESCARTADA",
    resolved: (what: string) => `✓ Resuelta: ${what}`,
    yourTurn: (opt: string) => `Te toca — elegiste: ${opt}`,
    codeReply: (code: number) => `Respondé "Q${code} <número>"`,
    orLink: (link: string) => `o entrá a ${link}`,
    orDashboard: "o en el dashboard: Oficina → Preguntas.",
    link: (link: string) => `Entrá a ${link}`,
    dashboard: "Respondé en el dashboard: Oficina → Preguntas.",
    notOpen: "Esta pregunta ya no está abierta.",
    badChoice: "Esa opción no vale para esta pregunta.",
    invalidButton: "Botón inválido.",
  },
  en: {
    someone: "An agent",
    asks: "Needs you",
    remind: "Reminder",
    owedTag: (opt: string) => `Your turn (you chose: ${opt})`,
    take: "I'll handle it",
    done: "Done",
    dismiss: "Dismiss",
    dismissed: "DISMISSED",
    resolved: (what: string) => `✓ Resolved: ${what}`,
    yourTurn: (opt: string) => `Your turn — you chose: ${opt}`,
    codeReply: (code: number) => `Reply "Q${code} <number>"`,
    orLink: (link: string) => `or open ${link}`,
    orDashboard: "or in the dashboard: Office → Questions.",
    link: (link: string) => `Open ${link}`,
    dashboard: "Answer in the dashboard: Office → Questions.",
    notOpen: "This question is no longer open.",
    badChoice: "That option is not valid for this question.",
    invalidButton: "Invalid button.",
  },
};

export type OperatorStrings = (typeof STRINGS)["es"];

export function strings(lang: KernelLanguage): OperatorStrings {
  return STRINGS[lang] ?? STRINGS.en;
}

/** The option the operator chose; the stored "Lo veo yo" marker shows in the operator's language. */
export function chosen(q: AgentQuestion, lang: KernelLanguage): string {
  return q.selected_index === -1 && q.selected_option === STRINGS.es.take ? strings(lang).take : (q.selected_option ?? "");
}

/** Options the operator can pick now: in 'owed' only the final (non-task) ones. */
export function openOptions(q: AgentQuestion): Array<{ index: number; label: string }> {
  return q.options.map((o, index) => ({ index, label: o.label, task: !!o.task }))
    .filter((o) => q.status !== "owed" || !o.task)
    .map(({ index, label }) => ({ index, label }));
}

export function buttonsFor(q: AgentQuestion, lang: KernelLanguage = "es"): OperatorButton[][] {
  const s = strings(lang);
  const rows = openOptions(q).map((o) => [{ text: o.label, data: `oq:${q.id}:${o.index}` }]);
  if (q.status === "pending") rows.push([{ text: s.take, data: `oq:${q.id}:task` }]);
  if (q.status === "owed") {
    rows.push([{ text: s.done, data: `oq:${q.id}:done` }]);
    rows.push([{ text: s.dismiss, data: `oq:${q.id}:dismiss` }]);
  }
  return rows;
}

export function headline(q: AgentQuestion, who: string, kind: Kind, lang: KernelLanguage = "es"): string {
  const s = strings(lang);
  const tag = kind === "owed" ? s.owedTag(chosen(q, lang)) : kind === "remind" ? s.remind : s.asks;
  return `${tag} — ${who}\n${q.question}${q.context ? `\n\n${q.context.slice(0, 600)}` : ""}`;
}

/** Message for a text channel: numbered options and how to answer. `link` null = no public URL configured. */
export function textFor(
  q: AgentQuestion, who: string, kind: Kind, code: number, link: string | null, canReply = true, lang: KernelLanguage = "es",
): string {
  const s = strings(lang);
  const lines = openOptions(q).map((o, i) => `${i + 1}. ${o.label}`);
  lines.push(q.status === "owed" ? `L. ${s.done}` : `L. ${s.take}`);
  if (q.status === "owed") lines.push(`D. ${s.dismiss}`);
  const tail = canReply
    ? `${s.codeReply(code)} ${link ? s.orLink(link) : s.orDashboard}`
    : link ? s.link(link) : s.dashboard;
  return `${headline(q, who, kind, lang)}\n\n${lines.join("\n")}\n\n${tail}`;
}

/** What a resolved question's message turns into: the edit, and the reply to the button that resolved it. */
export function resolvedText(q: AgentQuestion, lang: KernelLanguage = "es"): string {
  const s = strings(lang);
  return `${s.resolved(q.status === "dismissed" ? s.dismissed : (q.selected_option ?? ""))}\n${q.question}`;
}

/** The reply to the button or code that left the question on the operator. */
export function owedText(q: AgentQuestion, lang: KernelLanguage = "es"): string {
  return `${strings(lang).yourTurn(chosen(q, lang))}\n${q.question}`;
}
