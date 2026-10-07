/**
 * Agents the system cannot run without, and so can never be switched off:
 * the Chief (the holder of the top rank — question triage, Kernl bugs and the
 * auto-pause alerts all go through it, and `getTopAgent` stops finding it
 * once it is inactive), the monitor that notices other agents went down, the
 * Agent Factory, and data retention.
 *
 * The Factory is known by name because that is how its seeder finds it (and
 * reactivates it on every boot); the two automations by their handler.
 */
import { HttpError } from "../../sdk/http-error.js";
import type { Agent } from "./types.js";

export const PROTECTED_BUILTIN_HANDLERS: ReadonlySet<string> = new Set(["proactive:agent-monitor", "storage:retention"]);
export const PROTECTED_AGENT_NAMES: ReadonlySet<string> = new Set(["Agent Factory"]);

/** Thrown when something tries to deactivate or delete a protected agent (409). */
export class ProtectedAgentError extends HttpError {
  constructor(agentName: string, reason: string) {
    super(409, `${agentName} cannot be deactivated or deleted: ${reason}.`);
    this.name = "ProtectedAgentError";
  }
}

/** Why `agent` must stay active, or null when it can be paused. */
export function protectedReason(
  agent: Pick<Agent, "name" | "rank_id" | "builtin_handler">,
  topRankId: string | null,
): string | null {
  if (topRankId && agent.rank_id === topRankId) return "it is the Chief, the top of the agent hierarchy";
  if (agent.builtin_handler && PROTECTED_BUILTIN_HANDLERS.has(agent.builtin_handler)) return "it is a core system automation";
  if (PROTECTED_AGENT_NAMES.has(agent.name)) return "it is a core system agent";
  return null;
}
