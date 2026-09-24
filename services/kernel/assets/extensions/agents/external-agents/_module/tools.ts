import { z } from "zod";
import { type ToolDefinition, defineTool, defineToolNoInput, textResult, errorResult, kernelTimezone, limitArg } from "@kernl/extension-sdk";
import type { ExternalAgentService } from "./service.js";

export function externalAgentTools(service: ExternalAgentService): ToolDefinition[] {
  return [
    defineTool({
      name: "kernel_ext_agents_register",
      description: "Register a new external agent (e.g., IoT device, bot, sensor).",
      schema: z.object({
        name: z.string().describe("Agent name (e.g., 'LattePanda CH4 Monitor')"),
        description: z.string().optional().describe("Agent description"),
        platform: z.enum(["telegram", "http", "mqtt"]).describe("Communication platform"),
        platform_id: z.string().describe("Platform-specific ID (Telegram user_id, webhook URL, etc.)"),
        capabilities: z.array(z.string()).optional().describe("List of capabilities (e.g., ['metrics', 'alerts'])"),
      }),
      handler: async (input) => {
        const agent = service.registerAgent(input);

        return textResult(
          `External agent registered:\n` +
          `  Name: ${agent.name}\n` +
          `  ID: ${agent.id}\n` +
          `  Platform: ${agent.platform}\n` +
          `  API Key: \`${agent.api_key}\`\n\n` +
          `Save this API key - it's needed for the agent to authenticate.`
        );
      },
    }),

    defineTool({
      name: "kernel_ext_agents_list",
      description: "List all registered external agents.",
      schema: z.object({
        platform: z.enum(["telegram", "http", "mqtt"]).optional(),
        status: z.enum(["online", "offline", "unknown", "error"]).optional(),
      }),
      handler: async (filters) => {
        const agents = service.listAgents(filters);

        if (agents.length === 0) {
          return textResult("No external agents registered.");
        }

        const lines = agents.map((a) => {
          const statusIcon = a.status === "online" ? "🟢" : a.status === "offline" ? "🔴" : a.status === "error" ? "⚠️" : "⚪";
          const lastSeen = a.last_seen_at ? new Date(a.last_seen_at).toLocaleString(undefined, { timeZone: kernelTimezone() }) : "never";
          return `${statusIcon} *${a.name}*\n  Platform: ${a.platform} | Last seen: ${lastSeen}\n  ID: \`${a.id}\``;
        });

        return textResult(`External Agents (${agents.length}):\n\n${lines.join("\n\n")}`);
      },
    }),

    defineTool({
      name: "kernel_ext_agents_get",
      description: "Get details of a specific external agent.",
      schema: z.object({
        id: z.string().describe("Agent ID"),
      }),
      handler: async ({ id }) => {
        const agent = service.getAgent(id);

        if (!agent) {
          return errorResult(`Agent not found: ${id}`);
        }

        const capabilities = JSON.parse(agent.capabilities) as string[];
        const config = JSON.parse(agent.config) as Record<string, unknown>;

        const lines = [
          `Name: ${agent.name}`,
          `Description: ${agent.description || "(none)"}`,
          `Platform: ${agent.platform}`,
          `Platform ID: ${agent.platform_id}`,
          `Status: ${agent.status}`,
          `Capabilities: ${capabilities.join(", ") || "(none)"}`,
          `Last seen: ${agent.last_seen_at || "never"}`,
          `Config: ${JSON.stringify(config)}`,
          `Created: ${agent.created_at}`,
        ];

        return textResult(lines.join("\n"));
      },
    }),

    defineTool({
      name: "kernel_ext_agents_update",
      description: "Update an external agent's configuration.",
      schema: z.object({
        id: z.string().describe("Agent ID"),
        name: z.string().optional(),
        description: z.string().optional(),
        capabilities: z.array(z.string()).optional(),
        status: z.enum(["online", "offline", "unknown", "error"]).optional(),
      }),
      handler: async ({ id, ...changes }) => {
        const agent = service.updateAgent(id, changes);

        if (!agent) {
          return errorResult(`Agent not found: ${id}`);
        }

        return textResult(`Agent "${agent.name}" updated successfully.`);
      },
    }),

    defineTool({
      name: "kernel_ext_agents_delete",
      description: "Delete an external agent.",
      schema: z.object({
        id: z.string().describe("Agent ID"),
      }),
      handler: async ({ id }) => {
        const success = service.deleteAgent(id);

        if (!success) {
          return errorResult(`Agent not found: ${id}`);
        }

        return textResult(`Agent deleted successfully.`);
      },
    }),

    defineTool({
      name: "kernel_ext_agents_regenerate_key",
      description: "Regenerate API key for an external agent.",
      schema: z.object({
        id: z.string().describe("Agent ID"),
      }),
      handler: async ({ id }) => {
        const newKey = service.regenerateApiKey(id);

        if (!newKey) {
          return errorResult(`Agent not found: ${id}`);
        }

        return textResult(`New API key: \`${newKey}\`\n\nUpdate the agent's configuration with this new key.`);
      },
    }),

    defineTool({
      name: "kernel_ext_agents_metrics",
      description: "Get metrics from an external agent.",
      schema: z.object({
        agent_id: z.string().describe("Agent ID"),
        metric_name: z.string().optional().describe("Filter by metric name"),
        since: z.string().optional().describe("Filter by time (ISO 8601)"),
        limit: limitArg(500, "Max results (default: 100)"),
      }),
      handler: async (input) => {
        const metrics = service.getMetrics(
          input.agent_id,
          input.metric_name,
          input.since,
          input.limit ?? 100,
        );

        if (metrics.length === 0) {
          return textResult("No metrics found.");
        }

        // Group by metric name
        const grouped = new Map<string, typeof metrics>();
        for (const m of metrics) {
          const list = grouped.get(m.metric_name) ?? [];
          list.push(m);
          grouped.set(m.metric_name, list);
        }

        const lines: string[] = [];
        for (const [name, values] of grouped) {
          const latest = values[0];
          const unit = latest.unit ? ` ${latest.unit}` : "";
          lines.push(`*${name}*: ${latest.metric_value}${unit} (${values.length} readings)`);
        }

        return textResult(`Metrics:\n\n${lines.join("\n")}`);
      },
    }),

    defineTool({
      name: "kernel_ext_agents_alerts",
      description: "Get alerts from external agents.",
      schema: z.object({
        agent_id: z.string().optional().describe("Filter by agent ID"),
        severity: z.enum(["info", "warning", "critical"]).optional(),
        acknowledged: z.boolean().optional().describe("Filter by acknowledgment status"),
        limit: limitArg(200),
      }),
      handler: async (filters) => {
        const alerts = service.getAlerts(filters);

        if (alerts.length === 0) {
          return textResult("No alerts found.");
        }

        const lines = alerts.map((a) => {
          const icon = a.severity === "critical" ? "🚨" : a.severity === "warning" ? "⚠️" : "ℹ️";
          const ack = a.acknowledged ? " (ack)" : "";
          const time = new Date(a.created_at).toLocaleString(undefined, { timeZone: kernelTimezone() });
          return `${icon} *${a.title}*${ack}\n  ${a.message || "(no message)"}\n  ${time}`;
        });

        return textResult(`Alerts (${alerts.length}):\n\n${lines.join("\n\n")}`);
      },
    }),

    defineTool({
      name: "kernel_ext_agents_acknowledge",
      description: "Acknowledge an alert from an external agent.",
      schema: z.object({
        alert_id: z.string().describe("Alert ID"),
      }),
      handler: async ({ alert_id }) => {
        const success = service.acknowledgeAlert(alert_id);

        if (!success) {
          return errorResult(`Alert not found: ${alert_id}`);
        }

        return textResult("Alert acknowledged.");
      },
    }),

    defineToolNoInput({
      name: "kernel_ext_agents_summary",
      description: "Get a summary of all external agents and their status.",
      handler: async () => {
        const summary = service.getSummary();

        return textResult(
          `External Agents Summary:\n\n` +
          `Total: ${summary.total}\n` +
          `🟢 Online: ${summary.online}\n` +
          `🔴 Offline: ${summary.offline}\n` +
          `⚪ Unknown: ${summary.unknown}\n` +
          `⚠️ Error: ${summary.error}\n\n` +
          `Unacknowledged alerts: ${summary.unacknowledgedAlerts}`
        );
      },
    }),
  ];
}
