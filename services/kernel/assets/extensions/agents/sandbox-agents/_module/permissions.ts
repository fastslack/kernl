import { log } from "../../../../../src/core/logger.js";
import type { ToolDefinition } from "../../../../../src/core/types.js";
import type { AgentManifest } from "./types.js";

/**
 * Filter a full list of kernel tools down to only those the agent is
 * permitted to call, according to its manifest.permissions list.
 *
 * Rules:
 *   - ["*"]              → all tools allowed
 *   - ["kernel_tasks_*"] → wildcard prefix match
 *   - ["kernel_tasks_create"] → exact match
 *   - []                 → no tools allowed
 */
export function buildPermittedTools(
  allTools: ToolDefinition[],
  manifest: AgentManifest,
): ToolDefinition[] {
  const { permissions, name } = manifest;

  if (permissions.length === 0) {
    log.debug(`[sandbox:${name}] No permissions — agent cannot call any kernel tools`);
    return [];
  }

  // "*" means everything
  if (permissions.includes("*")) {
    log.warn(`[sandbox:${name}] Wildcard permissions ("*") — agent can call ALL kernel tools`);
    return allTools;
  }

  const permitted = allTools.filter((tool) => matchesPermissions(tool.name, permissions));

  log.debug(
    `[sandbox:${name}] Permitted tools: ${permitted.map((t) => t.name).join(", ") || "(none)"}`,
  );

  return permitted;
}

/**
 * Check whether `toolName` is allowed by the given permission patterns.
 * Supports:
 *   - Exact match:   "kernel_tasks_create"
 *   - Prefix glob:   "kernel_tasks_*"  (only trailing * supported)
 */
function matchesPermissions(toolName: string, permissions: string[]): boolean {
  for (const perm of permissions) {
    if (perm === toolName) return true;
    if (perm.endsWith("*")) {
      const prefix = perm.slice(0, -1);
      if (toolName.startsWith(prefix)) return true;
    }
  }
  return false;
}
