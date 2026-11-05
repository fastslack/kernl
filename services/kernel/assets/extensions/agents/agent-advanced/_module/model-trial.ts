/**
 * A cheaper model per kind of letter, learned from the agent's own runs.
 *
 * An agent opts in with the variable `__cheap_model__` (e.g. "claude-haiku-5-5"): the operator picks which agents
 * may try it. For each agent and kind of letter (TurnBudgets' samples, which also keep the model of each run):
 *   - the kind goes well on the usual model (20+ runs, 90%+ ok) → one run in four tries the cheap model;
 *   - 10+ cheap runs doing as well as the usual model (at most 5 points less) → the cheap model stays;
 *   - the run just before was a cheap one that failed → this one goes back to the usual model;
 *   - cheap runs doing worse, or 3 cheap failures before 10 tries → the trial ends, the usual model stays.
 * A run that ran out of turns counts as a failure. Why: an office's watcher and closer ran every letter on the big
 * model, most of them routine.
 */

export interface ModelSample { model: string; ok: boolean; maxed: boolean }
export type ModelReason = "usual" | "trial" | "promoted" | "escalated" | "demoted";

const MIN_USUAL = 20;
const USUAL_OK = 0.9;
const MIN_CHEAP = 10;
const MARGIN = 0.05;
const TRIAL_EVERY = 4;
const MAX_CHEAP_FAILS = 3;

const okRate = (xs: ModelSample[]) => (xs.length ? xs.filter((x) => x.ok && !x.maxed).length / xs.length : 0);

/** `history`: newest first, this agent and kind only. */
export function modelChoice(history: ModelSample[], usual: string, cheap: string): { model: string; reason: ModelReason } {
  const onUsual = history.filter((h) => h.model === usual);
  const onCheap = history.filter((h) => h.model === cheap);
  const failed = (x: ModelSample) => !x.ok || x.maxed;
  if (history[0] && history[0].model === cheap && failed(history[0])) return { model: usual, reason: "escalated" };
  if (onCheap.length < MIN_CHEAP && onCheap.filter(failed).length >= MAX_CHEAP_FAILS) return { model: usual, reason: "demoted" };
  if (onCheap.length >= MIN_CHEAP) {
    return okRate(onCheap) >= okRate(onUsual) - MARGIN ? { model: cheap, reason: "promoted" } : { model: usual, reason: "demoted" };
  }
  if (onUsual.length >= MIN_USUAL && okRate(onUsual) >= USUAL_OK && history.length % TRIAL_EVERY === 0) {
    return { model: cheap, reason: "trial" };
  }
  return { model: usual, reason: "usual" };
}
