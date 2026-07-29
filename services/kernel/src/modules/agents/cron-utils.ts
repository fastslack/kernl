import { CronExpressionParser } from "cron-parser";
import { log } from "../../core/logger.js";

/**
 * Compute next cron run time for a given expression and timezone. If `from`
 * is provided, computes the next fire after that anchor (used to estimate
 * cron cadence by computing two consecutive fires).
 */
export function computeNextCronRun(cron: string, timezone: string, from?: Date): string {
  try {
    const opts: { tz: string; currentDate?: Date } = { tz: timezone };
    if (from) opts.currentDate = from;
    const interval = CronExpressionParser.parse(cron, opts);
    const next = interval.next();
    return next.toISOString() ?? new Date(Date.now() + 3_600_000).toISOString();
  } catch (err) {
    log.warn(`Invalid cron expression "${cron}", falling back to 1h from now`, err);
    return new Date(Date.now() + 3_600_000).toISOString();
  }
}
