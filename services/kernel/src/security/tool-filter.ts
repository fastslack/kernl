/**
 * Tool Filter
 * Implements allowlist/denylist for tool execution
 */

import { log } from "../core/logger.js";
import type { ToolDefinition } from "../core/types.js";
import type { SecurityPolicy } from "./types.js";

/**
 * Filter tools based on security policy
 */
export function filterTools(
  tools: ToolDefinition[],
  policy: SecurityPolicy
): ToolDefinition[] {
  return tools.filter((tool) => isToolAllowed(tool.name, policy));
}

/**
 * Check if a tool is allowed by the policy
 */
export function isToolAllowed(toolName: string, policy: SecurityPolicy): boolean {
  // Denied tools always take precedence
  if (policy.deniedTools.includes(toolName)) {
    return false;
  }

  // Check pattern matches for denied tools
  for (const pattern of policy.deniedTools) {
    if (matchesPattern(toolName, pattern)) {
      return false;
    }
  }

  // In allowlist mode, tool must be explicitly allowed
  if (policy.mode === "allowlist") {
    if (policy.allowedTools.includes(toolName)) {
      return true;
    }

    // Check pattern matches for allowed tools
    for (const pattern of policy.allowedTools) {
      if (matchesPattern(toolName, pattern)) {
        return true;
      }
    }

    return false;
  }

  // In denylist mode, all tools are allowed except denied ones
  return true;
}

/**
 * Create a tool execution guard
 */
export function createToolGuard(
  policy: SecurityPolicy,
  onBlocked?: (toolName: string, reason: string) => void
): (toolName: string) => void {
  return (toolName: string) => {
    if (!isToolAllowed(toolName, policy)) {
      const reason = policy.deniedTools.includes(toolName)
        ? "Tool is in deny list"
        : "Tool is not in allow list";

      log.warn(`Security: blocked tool ${toolName} - ${reason}`);
      onBlocked?.(toolName, reason);

      throw new Error(`Tool "${toolName}" is not allowed: ${reason}`);
    }
  };
}

/**
 * Wrap tools with security guards
 */
export function wrapToolsWithSecurity(
  tools: ToolDefinition[],
  policy: SecurityPolicy
): ToolDefinition[] {
  const guard = createToolGuard(policy);

  return tools.map((tool) => ({
    ...tool,
    handler: async (input: unknown) => {
      guard(tool.name);
      return tool.handler(input);
    },
  }));
}

/**
 * Match a tool name against a pattern (supports wildcards)
 * Patterns:
 * - "kernel_*" matches all tools starting with "kernel_"
 * - "*_create" matches all tools ending with "_create"
 * - "kernel_tasks_*" matches all task tools
 */
function matchesPattern(toolName: string, pattern: string): boolean {
  if (!pattern.includes("*")) {
    return toolName === pattern;
  }

  // Convert pattern to regex
  const regexStr = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\\\*/g, ".*");

  const regex = new RegExp(`^${regexStr}$`);
  return regex.test(toolName);
}

/** Default safe tools (always allowed) */
export const SAFE_TOOLS = [
  "kernel_dashboard_*",
  "kernel_tasks_list",
  "kernel_reminders_list",
  "kernel_reminders_upcoming",
];

/** Dangerous tools (require explicit approval) */
export const DANGEROUS_TOOLS = [
  "kernel_*_delete*",
  "kernel_finance_*",
  "kernel_health_*",
];

/**
 * Create a default security policy
 */
export function createDefaultPolicy(): SecurityPolicy {
  return {
    allowedTools: [],
    deniedTools: DANGEROUS_TOOLS,
    mode: "denylist",
    rateLimit: 60, // 60 requests per minute
    maxTokens: 4000,
    requirePairing: true,
  };
}

/**
 * Create a permissive policy (for trusted users)
 */
export function createPermissivePolicy(): SecurityPolicy {
  return {
    allowedTools: [],
    deniedTools: [],
    mode: "denylist",
    rateLimit: 120,
    maxTokens: 8000,
    requirePairing: false,
  };
}

/**
 * Create a restrictive policy (for untrusted/new users)
 */
export function createRestrictivePolicy(): SecurityPolicy {
  return {
    allowedTools: SAFE_TOOLS,
    deniedTools: [],
    mode: "allowlist",
    rateLimit: 10,
    maxTokens: 1000,
    requirePairing: true,
  };
}
