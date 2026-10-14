import type { AgentQuestion } from "../../modules/agents/service.js";
import type { OperatorButton } from "./types.js";

/** Options the operator can pick now: in 'owed' only the final (non-task) ones. */
export function openOptions(q: AgentQuestion): Array<{ index: number; label: string }> {
  return q.options.map((o, index) => ({ index, label: o.label, task: !!o.task }))
    .filter((o) => q.status !== "owed" || !o.task)
    .map(({ index, label }) => ({ index, label }));
}

export function buttonsFor(q: AgentQuestion): OperatorButton[][] {
  const rows = openOptions(q).map((o) => [{ text: o.label, data: `oq:${q.id}:${o.index}` }]);
  if (q.status === "pending") rows.push([{ text: "Lo veo yo", data: `oq:${q.id}:task` }]);
  if (q.status === "owed") {
    rows.push([{ text: "Listo", data: `oq:${q.id}:done` }]);
    rows.push([{ text: "Descartar", data: `oq:${q.id}:dismiss` }]);
  }
  return rows;
}

export function headline(q: AgentQuestion, who: string, kind: "ask" | "owed" | "remind"): string {
  const tag = kind === "owed" ? `Te toca (elegiste: ${q.selected_option})` : kind === "remind" ? "Recordatorio" : "Te necesita";
  return `${tag} — ${who}\n${q.question}${q.context ? `\n\n${q.context.slice(0, 600)}` : ""}`;
}

export function textFor(q: AgentQuestion, who: string, kind: "ask" | "owed" | "remind", code: number, link: string, canReply = true): string {
  const lines = openOptions(q).map((o, i) => `${i + 1}. ${o.label}`);
  lines.push(q.status === "owed" ? "L. Listo" : "L. Lo veo yo");
  if (q.status === "owed") lines.push("D. Descartar");
  const tail = canReply ? `Respondé "Q${code} <número>" o entrá a ${link}` : `Entrá a ${link}`;
  return `${headline(q, who, kind)}\n\n${lines.join("\n")}\n\n${tail}`;
}
