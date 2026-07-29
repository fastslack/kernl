import { z } from "zod";
import type { ToolDefinition } from "../../../../../src/core/types.js";
import type { SubscriptionService } from "./service.js";
import { textResult, errorResult } from "../../../../../src/core/helpers.js";
import { formatCents } from "./helpers.js";

export function subscriptionTools(service: SubscriptionService): ToolDefinition[] {
  return [
    {
      name: "kernel_subscriptions_add",
      description:
        "Add a new subscription (Netflix, Spotify, gym, etc). Tracks recurring costs with automatic billing cycle calculation.",
      inputSchema: z.object({
        name: z.string().describe("Subscription name (e.g. Netflix, Spotify)"),
        provider: z.string().optional().describe("Provider/company name"),
        amount_cents: z.number().describe("Amount in cents (e.g. 1299 = 12.99)"),
        currency: z.string().optional().describe("Currency code (default: EUR)"),
        billing_cycle: z.enum(["weekly", "monthly", "quarterly", "yearly"]).optional()
          .describe("Billing frequency (default: monthly)"),
        category: z.string().optional().describe("Category (e.g. streaming, software, fitness)"),
        start_date: z.string().describe("Start date (YYYY-MM-DD)"),
        next_billing: z.string().optional().describe("Next billing date (auto-computed if omitted)"),
        url: z.string().optional().describe("Service URL or account page"),
        notes: z.string().optional(),
      }),
      handler: async (args) => {
        const input = args as {
          name: string; provider?: string; amount_cents: number; currency?: string;
          billing_cycle?: "weekly" | "monthly" | "quarterly" | "yearly";
          category?: string; start_date: string; next_billing?: string;
          url?: string; notes?: string;
        };
        const sub = service.create(input);
        return textResult(
          `Subscription added:\n  ID: ${sub.id}\n  Name: ${sub.name}\n  Amount: ${formatCents(sub.amount_cents)} ${sub.currency}\n  Cycle: ${sub.billing_cycle}\n  Next billing: ${sub.next_billing}`,
        );
      },
    },

    {
      name: "kernel_subscriptions_list",
      description: "List subscriptions with optional filters by status or category.",
      inputSchema: z.object({
        status: z.enum(["active", "paused", "cancelled"]).optional().describe("Filter by status"),
        category: z.string().optional().describe("Filter by category"),
      }),
      handler: async (args) => {
        const filters = args as { status?: "active" | "paused" | "cancelled"; category?: string };
        const subs = service.list(filters);
        if (subs.length === 0) return textResult("No subscriptions found.");

        const lines = subs.map(
          (s) =>
            `[${s.status.toUpperCase()}] ${s.name} — ${formatCents(s.amount_cents)} ${s.currency}/${s.billing_cycle}${s.category ? ` (${s.category})` : ""}\n  Next: ${s.next_billing} | ID: ${s.id}`,
        );
        return textResult(`${subs.length} subscription(s):\n\n${lines.join("\n\n")}`);
      },
    },

    {
      name: "kernel_subscriptions_update",
      description: "Update a subscription's details (name, amount, cycle, category, etc).",
      inputSchema: z.object({
        id: z.string().describe("Subscription ID"),
        name: z.string().optional(),
        provider: z.string().optional(),
        amount_cents: z.number().optional(),
        currency: z.string().optional(),
        billing_cycle: z.enum(["weekly", "monthly", "quarterly", "yearly"]).optional(),
        category: z.string().optional(),
        next_billing: z.string().optional(),
        url: z.string().optional(),
        notes: z.string().optional(),
      }),
      handler: async (args) => {
        const { id, ...changes } = args as {
          id: string; name?: string; provider?: string; amount_cents?: number;
          currency?: string; billing_cycle?: "weekly" | "monthly" | "quarterly" | "yearly";
          category?: string; next_billing?: string; url?: string; notes?: string;
        };
        const sub = service.update(id, changes);
        if (!sub) return errorResult(`Subscription not found: ${id}`);
        return textResult(
          `Updated "${sub.name}" — ${formatCents(sub.amount_cents)} ${sub.currency}/${sub.billing_cycle}\n  Next billing: ${sub.next_billing}`,
        );
      },
    },

    {
      name: "kernel_subscriptions_cancel",
      description: "Cancel a subscription.",
      inputSchema: z.object({
        id: z.string().describe("Subscription ID"),
      }),
      handler: async (args) => {
        const { id } = args as { id: string };
        const sub = service.cancel(id);
        if (!sub) return errorResult(`Subscription not found: ${id}`);
        return textResult(`Subscription "${sub.name}" cancelled.`);
      },
    },

    {
      name: "kernel_subscriptions_upcoming",
      description: "View subscriptions billing within the next N days (default: 30).",
      inputSchema: z.object({
        days: z.number().optional().describe("Look-ahead window in days (default: 30)"),
      }),
      handler: async (args) => {
        const { days } = args as { days?: number };
        const subs = service.upcoming(days ?? 30);
        if (subs.length === 0) return textResult(`No subscriptions billing in the next ${days ?? 30} days.`);

        const lines = subs.map(
          (s) => `${s.next_billing} — ${s.name} (${formatCents(s.amount_cents)} ${s.currency})`,
        );
        return textResult(`${subs.length} upcoming billing(s):\n\n${lines.join("\n")}`);
      },
    },

    {
      name: "kernel_subscriptions_summary",
      description: "Get a summary of all active subscriptions: monthly/yearly totals, breakdown by category.",
      inputSchema: z.object({}),
      handler: async () => {
        const s = service.summary();
        if (s.active_count === 0) return textResult("No active subscriptions.");

        const catLines = s.by_category.map(
          (c) => `  ${c.category}: ${c.count} sub(s), ${formatCents(c.monthly_cents)} ${s.currency}/mo`,
        );
        return textResult(
          `Active subscriptions: ${s.active_count}\nMonthly total: ${formatCents(s.monthly_total_cents)} ${s.currency}\nYearly total: ${formatCents(s.yearly_total_cents)} ${s.currency}\n\nBy category:\n${catLines.join("\n")}`,
        );
      },
    },
  ];
}
