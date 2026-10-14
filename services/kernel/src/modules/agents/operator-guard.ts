/**
 * Safety net on the chief's answers (spec 2026-10-14): an answer that leaves
 * work to the operator — names them, or holds/waits for an instruction only
 * they can give — must not close the question. The chief also declares it
 * (leaves_work_to_operator); this catches the answers where it did not.
 * Tuned on the 47 chief answers of 2026-10-14 that parked work on the operator.
 */
const NAMES_OPERATOR = /\b(operador|operator|humano|human|supervisor humano)\b/i;
const HOLDS = /\b(merge_hold|mantener (la cola|el merge_hold|retenid)|mantené el|seguir retenid|dejarlo en espera|en espera de|esperar nuevas instrucciones|hold until|keep (it )?on hold|reanudar lo decide|lo decide (el|la) )/i;

export function leavesWorkToOperator(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return NAMES_OPERATOR.test(t) || HOLDS.test(t);
}
