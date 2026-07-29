/**
 * Bridge between kernel MCP tools and the chat LLM's tool_use capability.
 *
 * Curates a subset of kernel tools, converts their Zod schemas to Anthropic
 * API format, and provides an executor that calls the real tool handlers.
 */

import type { ToolDefinition, ToolResult } from "../../core/types.js";
import { zodToJsonSchema } from "../../core/zod-to-json.js";
import { log } from "../../core/logger.js";
import type { ToolDefinitionForLlm } from "./types.js";

/** Prefix used by all MCP Bridge tools — they bypass the whitelist */
const MCP_BRIDGE_PREFIX = "mcp_";

/** Tools the chat LLM is allowed to use */
const CHAT_TOOL_WHITELIST = new Set([
  // Tasks
  "kernel_tasks_create",
  "kernel_tasks_list",
  "kernel_tasks_update",

  // CRM
  "kernel_crm_find",
  "kernel_crm_add_contact",
  "kernel_crm_get_contact",
  "kernel_crm_log_interaction",

  // Reminders
  "kernel_reminders_create",
  "kernel_reminders_list",
  "kernel_reminders_upcoming",

  // Shopping
  "kernel_shopping_create_list",
  "kernel_shopping_get_list",
  "kernel_shopping_add_item",
  "kernel_shopping_check_item",
  "kernel_shopping_add_product",
  "kernel_shopping_list_products",

  // Notes
  "kernel_notes_create",
  "kernel_notes_search",
  "kernel_notes_list",

  // Life logging
  "kernel_life_log",
  "kernel_life_status",

  // Issues (GitHub/GitLab)
  "kernel_issues_list",
  "kernel_issues_get",
  "kernel_issues_stats",
  "kernel_issues_sync",
  "kernel_issues_velocity",
  "kernel_issues_repos",

  // Events
  "kernel_events_create",
  "kernel_events_list",
  "kernel_events_get",
  "kernel_events_update",
  "kernel_events_upcoming",
  "kernel_events_invite",
  "kernel_events_invite_contacts",
  "kernel_events_rsvp",
  "kernel_events_attendees",
  "kernel_events_notification_text",
  "kernel_events_imminent",

  // Home
  "kernel_home_get_house",
  "kernel_home_list_appliances",
  "kernel_home_list_maintenance",
  "kernel_home_add_incident",
  "kernel_home_list_incidents",
  "kernel_home_update_incident",
  "kernel_home_list_projects",
  "kernel_home_summary",

  // Comms (Email)
  "kernel_comms_search_inbox",
  "kernel_comms_fetch_email",
  "kernel_comms_reply",
  "kernel_comms_send",
  "kernel_comms_list",
  "kernel_comms_get",

  // Dashboard briefings
  "kernel_dashboard_morning",
  "kernel_dashboard_evening",
  "kernel_dashboard_weekly",

  // Graph Analytics
  "kernel_graph_insights",
  "kernel_graph_connections",
  "kernel_graph_stale_contacts",
  "kernel_analytics_similar",
  "kernel_analytics_search",
  "kernel_analytics_report",

  // Subscriptions
  "kernel_subscriptions_add",
  "kernel_subscriptions_list",
  "kernel_subscriptions_update",
  "kernel_subscriptions_cancel",
  "kernel_subscriptions_upcoming",
  "kernel_subscriptions_summary",

  // Finance
  "kernel_finance_add_transaction",
  "kernel_finance_list_transactions",
  "kernel_finance_summary",
  "kernel_finance_balance",
  "kernel_finance_categories",

  // Goals
  "kernel_goals_create",
  "kernel_goals_list",
  "kernel_goals_update",
  "kernel_goals_progress",

  // Health
  "kernel_health_log",
  "kernel_health_summary",
  "kernel_health_recent",

  // Time tracking
  "kernel_time_start",
  "kernel_time_stop",
  "kernel_time_today",
  "kernel_time_summary",

  // Documents
  "kernel_documents_list",
  "kernel_documents_search",
  "kernel_documents_expiring",

  // Vehicles
  "kernel_vehicles_list",
  "kernel_vehicles_maintenance_due",

  // Agents (so chat can talk about agent state)
  "kernel_agents_list",
  "kernel_agents_status",
  "kernel_agents_directory",
]);

/** Maximum tool-use loop iterations to prevent runaway */
export const MAX_TOOL_ITERATIONS = 8;

/** Returns true if a tool should be exposed to the chat LLM */
function isChatAllowed(toolName: string): boolean {
  // MCP Bridge tools are always allowed (they're explicitly configured by the user)
  if (toolName.startsWith(MCP_BRIDGE_PREFIX)) return true;
  return CHAT_TOOL_WHITELIST.has(toolName);
}

/**
 * Convert kernel ToolDefinitions to Anthropic API tool format.
 * Includes whitelisted tools and all MCP Bridge tools.
 *
 * Dedups by tool name (first occurrence wins). LLM APIs (OpenAI, NVIDIA, Grok,
 * Claude) reject duplicate function names with HTTP 400 — without this filter
 * a single double-registered tool (e.g. via the MCP bridge reconnecting)
 * breaks every chat call. Logs a warning per collision so the underlying
 * registration bug is visible in the kernel logs.
 */
export function convertToolsForLlm(
  kernelTools: ToolDefinition[],
): ToolDefinitionForLlm[] {
  const seen = new Set<string>();
  const out: ToolDefinitionForLlm[] = [];
  let dupCount = 0;
  for (const t of kernelTools) {
    if (!isChatAllowed(t.name)) continue;
    if (seen.has(t.name)) {
      dupCount++;
      log.warn(`Chat tools: duplicate tool name "${t.name}" — keeping first registration`);
      continue;
    }
    seen.add(t.name);
    const raw = zodToJsonSchema(t.inputSchema) as Record<string, unknown>;
    const schema: Record<string, unknown> = { ...raw };
    if (!schema.type || typeof schema.type !== "string") schema.type = "object";
    if (!("properties" in schema) || typeof schema.properties !== "object") schema.properties = {};
    out.push({
      name: t.name,
      description: t.description,
      input_schema: schema,
    });
  }
  if (dupCount > 0) {
    log.warn(`Chat tools: dropped ${dupCount} duplicate tool(s); ${out.length} unique tools sent to LLM`);
  }
  return out;
}

/**
 * Build a name→handler map for fast tool execution.
 */
export function buildToolExecutor(
  kernelTools: ToolDefinition[],
): Map<string, (args: unknown) => Promise<ToolResult>> {
  const map = new Map<string, (args: unknown) => Promise<ToolResult>>();
  for (const t of kernelTools) {
    if (isChatAllowed(t.name)) {
      map.set(t.name, t.handler);
    }
  }
  return map;
}

/**
 * Execute a single tool call by name.
 * Returns the text result and error flag.
 */
export async function executeTool(
  executor: Map<string, (args: unknown) => Promise<ToolResult>>,
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const handler = executor.get(toolName);
  if (!handler) {
    log.warn(`Chat tool not found: ${toolName}`);
    return { text: `Tool not found: ${toolName}`, isError: true };
  }

  try {
    const result = await handler(toolInput);
    const text = result.content.map((c) => c.text).join("\n");
    return { text, isError: result.isError ?? false };
  } catch (err) {
    log.error(`Chat tool execution error (${toolName}):`, err);
    return {
      text: `Error executing ${toolName}: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}
