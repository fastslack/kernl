import { z } from "zod";
import { textResult, errorResult } from "../../core/helpers.js";
import type { ToolDefinition } from "../../core/types.js";
import type { ConfigService } from "./service.js";
import { defineTool } from "../../core/tool-builder.js";

const CATEGORIES = ["general", "ai", "chat", "agents", "notifications", "integrations", "life", "security", "advanced"] as const;

export function configTools(svc: ConfigService): ToolDefinition[] {
  return [
    // ── kernel_config_list ────────────────────────────────────────────────────
    defineTool({
      name: "kernel_config_list",
      description:
        "List all kernel configuration settings, optionally filtered by category. " +
        "Sensitive values (API keys, tokens) are automatically masked.",
      schema: z.object({
        category: z.enum(CATEGORIES).optional().describe(
          "Filter by category: general | ai | chat | agents | notifications | integrations | life | security | advanced"
        ),
      }),
      handler: async (input) => {
        return textResult(svc.describe(input.category));
      },
    }),

    // ── kernel_config_get ─────────────────────────────────────────────────────
    defineTool({
      name: "kernel_config_get",
      description:
        "Get the current value of a specific configuration setting by its env-var key " +
        "(e.g. ANTHROPIC_API_KEY, LIFE_CITY, CHAT_DEFAULT_PROVIDER). " +
        "Sensitive values are masked.",
      schema: z.object({
        key: z.string().describe("Environment variable name, e.g. ANTHROPIC_API_KEY"),
      }),
      handler: async (input) => {
        const { key } = input;
        const setting = svc.get(key.toUpperCase());
        if (!setting) {
          // Fallback: return raw process.env value if not in catalog
          const raw = process.env[key.toUpperCase()];
          if (raw === undefined) return errorResult(`Setting "${key}" not found.`);
          return textResult(`**${key}**: ${raw} _(not in catalog)_`);
        }
        const display = setting.sensitive ? svc.maskValue(setting.value) : (setting.value || "(not set)");
        const lines = [
          `## ${setting.label}`,
          `- **Key**: \`${setting.key}\``,
          `- **Value**: ${display}`,
          `- **Category**: ${setting.category}`,
          `- **Type**: ${setting.type}`,
          setting.description ? `- **Description**: ${setting.description}` : "",
          `- **Last updated**: ${setting.updated_at} by ${setting.updated_by}`,
        ].filter(Boolean);
        return textResult(lines.join("\n"));
      },
    }),

    // ── kernel_config_set ─────────────────────────────────────────────────────
    defineTool({
      name: "kernel_config_set",
      description:
        "Set a configuration value. Changes take effect immediately (no restart needed) " +
        "and are persisted to the .env file. " +
        "Examples: set LIFE_CITY to 'Berlin', set CHAT_DEFAULT_PROVIDER to 'openai', " +
        "set PROACTIVE_MORNING_TIME to '08:00'.",
      schema: z.object({
        key: z.string().describe("Environment variable name, e.g. LIFE_CITY"),
        value: z.string().describe("New value to set"),
      }),
      handler: async (input) => {
        const { key, value } = input;
        const result = svc.set(key.toUpperCase(), value, "user");
        if (!result.ok) return errorResult(result.error ?? "Failed to update setting.");
        const s = result.setting!;
        const display = s.sensitive ? svc.maskValue(s.value) : s.value;
        return textResult(`Configuration updated:\n- **${s.label ?? s.key}**: ${display}\n\nChange is live immediately and saved to .env.`);
      },
    }),

    // ── kernel_config_set_many ────────────────────────────────────────────────
    defineTool({
      name: "kernel_config_set_many",
      description:
        "Set multiple configuration values at once. Useful when applying a group of " +
        "related settings, e.g. changing location (latitude + longitude + city + timezone).",
      schema: z.object({
        settings: z.array(z.object({
          key: z.string().describe("Environment variable name"),
          value: z.string().describe("New value"),
        })).describe("Array of key-value pairs to set"),
      }),
      handler: async (input) => {
        const normalized = input.settings.map((s) => ({ key: s.key.toUpperCase(), value: s.value }));
        const result = svc.setMany(normalized, "user");
        const lines: string[] = [`## Configuration Updated`];
        if (result.updated.length) {
          lines.push(`\n**Set (${result.updated.length}):** ${result.updated.join(", ")}`);
        }
        if (result.errors.length) {
          lines.push(`\n**Errors (${result.errors.length}):**`);
          for (const e of result.errors) lines.push(`- ${e.key}: ${e.error}`);
        }
        lines.push("\nAll changes are live immediately and saved to .env.");
        return textResult(lines.join("\n"));
      },
    }),

    // ── kernel_config_catalog ─────────────────────────────────────────────────
    defineTool({
      name: "kernel_config_catalog",
      description:
        "List all known configurable settings with their descriptions, types, and categories. " +
        "Use this to discover what can be configured.",
      schema: z.object({
        category: z.enum(CATEGORIES).optional(),
      }),
      handler: async (input) => {
        const { category } = input;
        const defs = svc.getCatalog().filter((d) => !category || d.category === category);
        const byCat = new Map<string, typeof defs>();
        for (const d of defs) {
          (byCat.get(d.category) ?? byCat.set(d.category, []).get(d.category)!).push(d);
        }
        const lines: string[] = ["## Configuration Catalog\n"];
        for (const [cat, items] of byCat) {
          lines.push(`### ${cat.charAt(0).toUpperCase() + cat.slice(1)}`);
          for (const d of items) {
            const flags = [d.sensitive ? "🔒 sensitive" : "", d.readonly ? "⛔ readonly" : ""].filter(Boolean).join(", ");
            lines.push(`- **${d.label}** (\`${d.key}\`) [${d.type}]${flags ? " — " + flags : ""}`);
            if (d.description) lines.push(`  ${d.description}`);
          }
          lines.push("");
        }
        return textResult(lines.join("\n"));
      },
    }),
  ];
}
