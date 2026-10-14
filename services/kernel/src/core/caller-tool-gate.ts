/**
 * Agents the kernel lets call only a fixed set of its tools, whatever their
 * executor was told.
 *
 * A claude_code agent's allow/deny lists live in the SDK options of its
 * subprocess; the kernel trusts them. For an agent that must never write
 * (the question investigator), that is one layer too few: a mistake in how
 * those options are built would hand it every kernel tool. This gate is the
 * second layer, at the kernel's own MCP dispatch: a call from a restricted
 * agent to a tool outside its set is refused before the handler runs.
 */

const restricted = new Map<string, ReadonlySet<string>>();

/** From now on `agentId` may call only `tools` through the kernel's MCP server. */
export function restrictCallerTools(agentId: string, tools: Iterable<string>): void {
  if (!agentId) return;
  restricted.set(agentId, new Set(tools));
}

/** Lift the restriction (tests, or an agent that was deleted). */
export function unrestrictCallerTools(agentId: string): void {
  restricted.delete(agentId);
}

/** Why `agentId` may not call `tool`, or null when it may (or is not restricted). */
export function callerToolDenial(agentId: string, tool: string): string | null {
  if (!agentId) return null;
  const allowed = restricted.get(agentId);
  if (!allowed || allowed.has(tool)) return null;
  return `Tool ${tool} is not available to this agent: it is read-only and may only call ${[...allowed].sort().join(", ")}.`;
}
