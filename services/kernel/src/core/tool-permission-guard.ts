/**
 * Tools check the caller's permissions themselves.
 *
 * Every tool the registry hands out (`ModuleRegistry.getAllTools`) is wrapped
 * here, so the check holds on every path that reaches a handler: an MCP
 * call, a plan step, a script run by the code runner, a digest source. The
 * caller is read from the request context: a user's request carries their
 * principal; work the kernel starts on its own (an agent run, a trigger, a
 * scheduled job) carries none and is not a user's to restrict — an agent
 * runs with its own tool set.
 *
 * Office scopes apply too: a restricted user cannot pass a tool an agent,
 * office or run outside their offices, and structured results come back
 * without them. A tool's text (markdown) is passed through as written;
 * listing tools may still mention out-of-scope names in prose, never act
 * on them.
 */

import { getPrincipal } from "./request-context.js";
import { principalCan } from "./principal.js";
import { formatRequirement, requirementForTool } from "./permissions.js";
import type { ToolDefinition } from "./types.js";
import { currentScope, filterForScope, scopeDenial } from "./scope.js";

const guarded = new WeakMap<ToolDefinition, ToolDefinition>();

/** Why the current caller may not use this tool, or null if they may. */
export function toolPermissionDenial(tool: Pick<ToolDefinition, "name" | "sideEffects" | "permission">): string | null {
  const principal = getPrincipal();
  if (!principal || principal.kind === "super_admin") return null;
  const need = requirementForTool(tool.name, tool);
  if (principalCan(principal, need)) return null;
  return `Forbidden: ${tool.name} needs ${formatRequirement(need)}, which your role does not grant.`;
}

/** Same tool, refusing callers without the permission it needs. */
export function guardPermission(tool: ToolDefinition): ToolDefinition {
  const hit = guarded.get(tool);
  if (hit) return hit;
  const wrapped: ToolDefinition = {
    ...tool,
    handler: async (args: unknown) => {
      const denial = toolPermissionDenial(tool) ?? scopeDenial(args, requirementForTool(tool.name, tool).level);
      if (denial) return { content: [{ type: "text", text: denial }], isError: true };
      const result = await tool.handler(args);
      // Structured results lose out-of-scope agents, offices and runs for a
      // restricted user. Text cannot be filtered: see the scope note below.
      if (result.structuredContent !== undefined && currentScope()) {
        return { ...result, structuredContent: filterForScope(result.structuredContent) };
      }
      return result;
    },
  };
  guarded.set(tool, wrapped);
  return wrapped;
}
