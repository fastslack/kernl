// Decisions taken in code before spending an LLM call on self-improvement. Pure: the services own the state.
//
// 2026-10-16, one week of usage: reflection cost US$64 in 1,882 calls and auto-eval US$22 in 1,117. The
// reflection sweep (every 6 h) re-read the same failed runs from an agent's last 10 and proposed a new
// prompt for them again and again; auto-eval graded every single completed run of agents that run dozens
// of times a day.

/** Default minutes between two gradings of an agent's completed runs. Failed runs are always graded. */
export const EVAL_EVERY_MIN_DEFAULT = 60;

/** `__eval_every_min__` in the agent's variables; 0 grades every run, as before. */
export function evalEveryMin(variables: string | undefined): number {
  try {
    const v = Number(JSON.parse(variables || "{}").__eval_every_min__);
    return Number.isFinite(v) && v >= 0 ? v : EVAL_EVERY_MIN_DEFAULT;
  } catch { return EVAL_EVERY_MIN_DEFAULT; }
}

/** Grade this run? A failure always; a completed run at most once every `everyMin` per agent. */
export function shouldGrade(status: "completed" | "failed", lastGradedAt: number | undefined, now: number, everyMin: number): boolean {
  if (status === "failed" || everyMin === 0) return true;
  return lastGradedAt === undefined || now - lastGradedAt >= everyMin * 60_000;
}

/**
 * Reflect on these failures? Only when at least one of them is newer than what the last cycle already
 * looked at. `since` is the newest created_at a previous cycle saw (or the last evolution run's).
 */
export function hasFreshFailures(triggerRuns: Array<{ created_at: string }>, since: string | undefined): boolean {
  if (!since) return triggerRuns.length > 0;
  return triggerRuns.some((r) => r.created_at > since);
}

export const newestCreatedAt = (runs: Array<{ created_at: string }>): string | undefined =>
  runs.reduce<string | undefined>((m, r) => (!m || r.created_at > m ? r.created_at : m), undefined);
