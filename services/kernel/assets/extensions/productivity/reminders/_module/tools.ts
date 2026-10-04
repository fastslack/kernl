import { z } from "zod";
import { type ToolDefinition, type Notifier, defineTool, defineToolNoInput, textResult, errorResult } from "@kernl/extension-sdk";
import type { ReminderService } from "./service.js";

export function reminderTools(
  service: ReminderService,
  notifier: Notifier,
): ToolDefinition[] {
  return [
    defineTool({
      name: "kernel_reminders_create",
      description:
        "Create a reminder with a specific trigger time. Supports repeat (daily/weekly/monthly) and optional task linking.",
      schema: z.object({
        title: z.string().describe("Reminder title"),
        body: z.string().optional().describe("Additional details"),
        trigger_at: z
          .string()
          .describe("When to fire, ISO 8601. With Z or an offset it is that instant (2025-03-01T09:00:00Z); without one it is local time in the kernel's TIMEZONE (2025-03-01T09:00)."),
        repeat: z
          .enum(["none", "daily", "weekly", "monthly"])
          .optional()
          .describe("Repeat interval (default: none)"),
        task_id: z
          .string()
          .optional()
          .describe("Link to an existing task by ID"),
        notify_mattermost: z
          .boolean()
          .optional()
          .describe("Send Mattermost notification (default: true)"),
        notify_telegram: z
          .boolean()
          .optional()
          .describe("Send Telegram notification (default: true)"),
      }),
      handler: async (input) => {
        const reminder = service.create(input);
        const notifyChannels: string[] = [];
        if (reminder.notify_mattermost) notifyChannels.push("Mattermost");
        if (reminder.notify_telegram) notifyChannels.push("Telegram");
        return textResult(
          `Reminder created:\n  ID: ${reminder.id}\n  Title: ${reminder.title}\n  Trigger: ${reminder.trigger_at}\n  Repeat: ${reminder.repeat}\n  Notify: ${notifyChannels.join(", ") || "none"}`,
        );
      },
    }),

    defineTool({
      name: "kernel_reminders_list",
      description:
        "List reminders with optional filters by status or linked task.",
      schema: z.object({
        status: z
          .enum(["active", "snoozed", "fired", "dismissed"])
          .optional()
          .describe("Filter by status"),
        task_id: z
          .string()
          .optional()
          .describe("Filter by linked task ID"),
      }),
      handler: async (filters) => {
        const reminders = service.list(filters);
        if (reminders.length === 0) return textResult("No reminders found.");

        const lines = reminders.map(
          (r) =>
            `[${r.status.toUpperCase()}] ${r.title} — ${r.trigger_at}${r.repeat !== "none" ? ` (${r.repeat})` : ""}${r.task_id ? ` [task: ${r.task_id}]` : ""}\n  ID: ${r.id}`,
        );
        return textResult(
          `${reminders.length} reminder(s):\n\n${lines.join("\n\n")}`,
        );
      },
    }),

    defineTool({
      name: "kernel_reminders_get",
      description: "Get detailed info about a reminder by ID.",
      schema: z.object({
        id: z.string().describe("Reminder ID"),
      }),
      handler: async ({ id }) => {
        const r = service.getById(id);
        if (!r) return errorResult(`Reminder not found: ${id}`);

        const lines = [
          `Title: ${r.title}`,
          `Body: ${r.body || "(empty)"}`,
          `Status: ${r.status}`,
          `Trigger: ${r.trigger_at}`,
          `Repeat: ${r.repeat}`,
          `Task: ${r.task_id || "none"}`,
          `Notify Mattermost: ${r.notify_mattermost ? "yes" : "no"}`,
          `Notify Telegram: ${r.notify_telegram ? "yes" : "no"}`,
          `Snoozed until: ${r.snoozed_until || "n/a"}`,
          `Last fired: ${r.last_fired_at || "never"}`,
          `Created: ${r.created_at}`,
          `Updated: ${r.updated_at}`,
        ];
        return textResult(lines.join("\n"));
      },
    }),

    defineTool({
      name: "kernel_reminders_update",
      description:
        "Update a reminder's title, body, trigger time, repeat interval, or notification preferences.",
      schema: z.object({
        id: z.string().describe("Reminder ID"),
        title: z.string().optional(),
        body: z.string().optional(),
        trigger_at: z.string().optional().describe("New trigger time, ISO 8601; without Z or an offset it is local time (the kernel's TIMEZONE)."),
        repeat: z.enum(["none", "daily", "weekly", "monthly"]).optional(),
        task_id: z.string().optional().describe("Link to a different task"),
        notify_mattermost: z.boolean().optional(),
        notify_telegram: z.boolean().optional(),
      }),
      handler: async ({ id, ...changes }) => {
        const updatePayload: Record<string, unknown> = { ...changes };
        if (changes.notify_mattermost !== undefined) {
          updatePayload.notify_mattermost = changes.notify_mattermost ? 1 : 0;
        }
        if (changes.notify_telegram !== undefined) {
          updatePayload.notify_telegram = changes.notify_telegram ? 1 : 0;
        }

        const reminder = service.update(id, updatePayload as any);
        if (!reminder) return errorResult(`Reminder not found: ${id}`);
        return textResult(
          `Reminder updated:\n  Title: ${reminder.title}\n  Trigger: ${reminder.trigger_at}\n  Repeat: ${reminder.repeat}`,
        );
      },
    }),

    defineTool({
      name: "kernel_reminders_dismiss",
      description: "Permanently dismiss a reminder (stops it from firing).",
      schema: z.object({
        id: z.string().describe("Reminder ID"),
      }),
      handler: async ({ id }) => {
        const reminder = service.dismiss(id);
        if (!reminder) return errorResult(`Reminder not found: ${id}`);
        return textResult(`Reminder "${reminder.title}" dismissed.`);
      },
    }),

    defineTool({
      name: "kernel_reminders_snooze",
      description:
        "Snooze a reminder until a specific time. It will fire again at the new time.",
      schema: z.object({
        id: z.string().describe("Reminder ID"),
        until: z
          .string()
          .describe("Snooze until this time (ISO 8601 UTC)"),
      }),
      handler: async ({ id, until }) => {
        const reminder = service.snooze(id, until);
        if (!reminder) return errorResult(`Reminder not found: ${id}`);
        return textResult(
          `Reminder "${reminder.title}" snoozed until ${until}.`,
        );
      },
    }),

    defineTool({
      name: "kernel_reminders_upcoming",
      description:
        "View reminders coming up in the next N hours (default: 24).",
      schema: z.object({
        hours: z
          .number()
          .optional()
          .describe("Look-ahead window in hours (default: 24)"),
      }),
      handler: async ({ hours }) => {
        const reminders = service.upcoming(hours ?? 24);
        if (reminders.length === 0)
          return textResult(`No reminders in the next ${hours ?? 24} hours.`);

        const lines = reminders.map(
          (r) =>
            `${r.trigger_at} — ${r.title}${r.repeat !== "none" ? ` (${r.repeat})` : ""}`,
        );
        return textResult(
          `${reminders.length} upcoming reminder(s):\n\n${lines.join("\n")}`,
        );
      },
    }),

    defineToolNoInput({
      name: "kernel_reminders_test_notification",
      description:
        "Send a test notification to all configured channels.",
      handler: async () => {
        if (!notifier.configured) {
          return errorResult(
            "No notification channels configured. Enable channels from the dashboard or set env vars.",
          );
        }
        const results = await notifier.sendTest();
        const status: string[] = [];
        for (const [id, ok] of Object.entries(results)) {
          status.push(`${id}: ${ok ? "OK" : "FAILED"}`);
        }
        const anySuccess = Object.values(results).some(Boolean);
        if (anySuccess) {
          return textResult(`Test notifications sent:\n${status.join("\n")}`);
        }
        return errorResult(
          `All test notifications failed:\n${status.join("\n")}\n\nCheck server logs for details.`,
        );
      },
    }),
  ];
}
