import type { AgentService } from "../../modules/agents/service.js";
import type { OperatorComms } from "./driver.js";

export const REMIND_AFTER_MS = 24 * 3_600_000;
export const REMIND_SWEEP_MS = 60_000;

/**
 * 24 h reminders for what waits on the operator. Every due question is marked
 * before the first one is sent, so a reminder is never repeated within 24 h —
 * not with no channel ready, and not when a slow channel makes the next sweep
 * start while this one is still sending. Returns how many were sent.
 */
export async function remindDue(
  service: Pick<AgentService, "listRemindable" | "markReminded">,
  comms: Pick<OperatorComms, "remind">,
  now = Date.now(),
): Promise<number> {
  const due = service.listRemindable(new Date(now - REMIND_AFTER_MS).toISOString());
  for (const q of due) service.markReminded(q.id);
  for (const q of due) await comms.remind(q.id);
  return due.length;
}
