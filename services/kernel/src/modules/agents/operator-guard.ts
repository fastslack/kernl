/**
 * Safety net on the chief's answers (spec 2026-10-14): an answer that leaves
 * work to the operator — names them, or holds/waits for an instruction only
 * they can give — must not close the question. The chief also declares it
 * (leaves_work_to_operator); this catches the answers where it did not.
 * Tuned on the 47 chief answers of 2026-10-14 that parked work on the operator.
 */
// The operator/human only counts when they are the one who must wait, decide,
// act, approve or load something — a bare "operator" (ternary operator,
// human-readable, el operador de spread) is a technical word, not a hand-off.
const WHO = "(operador|humano|operator|human)";
const NAMES_OPERATOR = new RegExp(
  [
    `\\besper\\S*\\s+(a que\\s+|al\\s+|a la\\s+)?(el\\s+|la\\s+)?${WHO}\\b`,
    `\\b(hasta que|que) (el|la) ${WHO}\\b`,
    `\\blo (decide|manda|aprueba|carga|revisa|define)\\b[^.]{0,30}\\b(el|la) ${WHO}\\b`,
    `\\b(decide|decidir|aprueba|aprobar) (el|la) ${WHO}\\b`,
    `\\buntil the ${WHO}\\b`,
    `\\bthe ${WHO} (has to|must|needs to|will|decides|should)\\b`,
  ].join("|"),
  "i",
);
// A hold is only a hold when something is being kept/left waiting; lifting
// merge_hold or waiting on CI is ordinary work.
const HOLDS = /\b((mantener|mantené|mantene|seguir|sigue|dejar|dejá) (con )?(el )?merge_hold|mantener (la cola|retenid)|seguir retenid|dejarlo en espera|esperar nuevas instrucciones|hold until|keep (it )?on hold)/i;

export function leavesWorkToOperator(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return NAMES_OPERATOR.test(t) || HOLDS.test(t);
}
