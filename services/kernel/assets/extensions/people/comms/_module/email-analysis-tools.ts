/**
 * MCP tools for email analysis and suggestion approval.
 *
 * Tools:
 *   kernel_email_analyze        — Analyze a specific email (by comm_id) on demand
 *   kernel_email_pending         — List pending suggestions awaiting approval
 *   kernel_email_approve         — Approve a suggestion (creates the entity)
 *   kernel_email_dismiss         — Dismiss a suggestion
 *   kernel_email_sync_analyze    — Fetch latest inbox emails + analyze batch
 */

import { z } from "zod";
import { textResult, errorResult } from "../../../../../src/core/helpers.js";
import type { ToolDefinition } from "../../../../../src/core/types.js";
import type { EmailAnalysisService } from "./email-analysis-service.js";
import type { TaskPayload, ReminderPayload, ContactPayload, ShoppingPayload } from "./email-analysis-service.js";
import type { TaskService } from "../../../productivity/tasks/_module/service.js";
import type { ReminderService } from "../../../productivity/reminders/_module/service.js";
import type { CrmService } from "../../crm/_module/service.js";
import type { ShoppingService } from "../../../home/shopping/_module/service.js";
import type { CommsService } from "./service.js";

function fmtSuggestion(s: {
  id: string; comm_id: string; type: string; status: string;
  payload: unknown; created_at: string;
  subject?: string; from_email?: string;
}): string {
  const p = s.payload as Record<string, unknown>;
  const lines: string[] = [
    `**[${s.id}]** \`${s.type}\` — ${s.status}`,
    `  Email: "${s.subject ?? "(unknown)"}" from ${s.from_email ?? "?"}`,
  ];
  switch (s.type) {
    case "task":
      lines.push(`  Task: ${p.title} | priority: ${p.priority}${p.context ? ` | ctx: ${p.context}` : ""}${p.due_date ? ` | due: ${p.due_date}` : ""}`);
      break;
    case "reminder":
      lines.push(`  Reminder: ${p.title} | at: ${p.trigger_at}`);
      break;
    case "contact":
      lines.push(`  Contact: ${p.name} <${p.email}>${p.company ? ` @ ${p.company}` : ""}`);
      break;
    case "shopping":
      lines.push(`  Shopping: ${p.name}${p.quantity ? ` × ${p.quantity}` : ""}`);
      break;
  }
  return lines.join("\n");
}

export function emailAnalysisTools(
  analysisService: EmailAnalysisService,
  taskService: TaskService,
  reminderService: ReminderService,
  crmService: CrmService,
  shoppingService: ShoppingService,
  commsService: CommsService,
): ToolDefinition[] {
  const approveServices = {
    createTask: async (payload: TaskPayload) => {
      const task = taskService.create({
        title: payload.title,
        description: payload.description,
        priority: payload.priority,
        context: payload.context,
        due_date: payload.due_date,
      });
      return task.id;
    },
    createReminder: async (payload: ReminderPayload) => {
      const reminder = reminderService.create({
        title: payload.title,
        body: payload.body ?? "",
        trigger_at: payload.trigger_at,
        repeat: payload.repeat ?? "none",
      });
      return reminder.id;
    },
    createContact: async (payload: ContactPayload) => {
      const contact = crmService.addContact({
        name: payload.name,
        email: payload.email,
        company: payload.company,
        relationship: payload.relationship,
        notes: payload.notes,
      });
      return contact.id;
    },
    addShoppingItem: async (payload: ShoppingPayload) => {
      // Add to first active shopping list, or create one
      const lists = shoppingService.getLists("active");
      let listId: string;
      if (lists.length > 0) {
        listId = lists[0].id;
      } else {
        const newList = shoppingService.createList({ name: "Shopping" });
        listId = newList.id;
      }
      const item = shoppingService.addListItem({
        list_id: listId,
        name: payload.name,
        quantity: payload.quantity ?? 1,
        unit: payload.unit ?? "pcs",
        notes: payload.notes ?? "",
      });
      if (!item) throw new Error("Failed to add shopping item");
      return item.id;
    },
  };

  return [
    // ── kernel_email_analyze ──────────────────────────────────────────────
    {
      name: "kernel_email_analyze",
      description: "Analyze a fetched email (by comm_id) using AI and extract actionable suggestions (tasks, reminders, contacts, shopping items). Suggestions require approval before being created.",
      inputSchema: z.object({
        comm_id: z.string().describe("ID of the communication (must already be fetched with kernel_comms_fetch_email)"),
      }),
      handler: async (args) => {
        const { comm_id } = args as { comm_id: string };
        try {
          const result = await analysisService.analyzeById(comm_id);
          const lines: string[] = [
            `## Email Analysis`,
            `**Summary:** ${result.summary || "(no summary)"}`,
            `**Suggestions found:** ${result.suggestions.length}`,
            "",
          ];
          if (result.suggestions.length === 0) {
            lines.push("No actionable items detected in this email.");
          } else {
            lines.push("### Pending Suggestions (use kernel_email_approve to create)");
            for (const s of result.suggestions) {
              lines.push(fmtSuggestion(s));
            }
          }
          return textResult(lines.join("\n"));
        } catch (err) {
          return errorResult(String(err));
        }
      },
    },

    // ── kernel_email_pending ──────────────────────────────────────────────
    {
      name: "kernel_email_pending",
      description: "List all pending email analysis suggestions awaiting approval. Returns suggestions with their IDs for use with kernel_email_approve or kernel_email_dismiss.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(30).describe("Max suggestions to return"),
      }),
      handler: async (args) => {
        const { limit } = args as { limit: number };
        try {
          const suggestions = analysisService.getPendingSuggestions(limit);
          if (suggestions.length === 0) {
            return textResult("No pending email suggestions. Use kernel_email_analyze or kernel_email_sync_analyze to scan your inbox.");
          }
          const lines = [
            `## Pending Email Suggestions (${suggestions.length})`,
            "",
            "Use `kernel_email_approve` to create an item, or `kernel_email_dismiss` to skip it.",
            "",
          ];
          for (const s of suggestions) {
            lines.push(fmtSuggestion(s));
            lines.push("");
          }
          return textResult(lines.join("\n"));
        } catch (err) {
          return errorResult(String(err));
        }
      },
    },

    // ── kernel_email_approve ──────────────────────────────────────────────
    {
      name: "kernel_email_approve",
      description: "Approve a pending email suggestion and immediately create the corresponding entity (task, reminder, contact, or shopping item). Optionally override fields before creating.",
      inputSchema: z.object({
        suggestion_id: z.string().describe("ID of the suggestion to approve"),
        overrides: z.record(z.unknown()).optional().describe("Optional field overrides, e.g. {\"priority\": \"high\", \"due_date\": \"2026-03-10\"}"),
      }),
      handler: async (args) => {
        const { suggestion_id, overrides } = args as { suggestion_id: string; overrides?: Record<string, unknown> };
        try {
          const result = await analysisService.approveSuggestion(
            suggestion_id,
            overrides as Partial<TaskPayload>,
            approveServices,
          );
          return textResult(`✓ Approved: created **${result.type}** \`${result.created_id}\``);
        } catch (err) {
          return errorResult(String(err));
        }
      },
    },

    // ── kernel_email_dismiss ──────────────────────────────────────────────
    {
      name: "kernel_email_dismiss",
      description: "Dismiss a pending email suggestion without creating anything.",
      inputSchema: z.object({
        suggestion_id: z.string().describe("ID of the suggestion to dismiss"),
      }),
      handler: async (args) => {
        const { suggestion_id } = args as { suggestion_id: string };
        try {
          analysisService.dismissSuggestion(suggestion_id);
          return textResult(`Suggestion \`${suggestion_id}\` dismissed.`);
        } catch (err) {
          return errorResult(String(err));
        }
      },
    },

    // ── kernel_email_sync_analyze ─────────────────────────────────────────
    {
      name: "kernel_email_sync_analyze",
      description: "Fetch recent emails from Gmail inbox and run AI analysis to extract actionable suggestions. Call kernel_email_pending afterwards to review.",
      inputSchema: z.object({
        days_back: z.number().int().min(1).max(30).default(3).describe("How many days back to scan"),
        max_emails: z.number().int().min(1).max(30).default(10).describe("Max emails to fetch and analyze"),
        query: z.string().optional().describe("Additional Gmail query filter (e.g. 'from:boss@company.com is:unread')"),
      }),
      handler: async (args) => {
        const { days_back, max_emails, query } = args as { days_back: number; max_emails: number; query?: string };
        try {
          const gmailQuery = [`newer_than:${days_back}d`, "is:unread", query].filter(Boolean).join(" ");
          const messages = await commsService.searchInbox(gmailQuery, max_emails);

          if (messages.length === 0) {
            return textResult(`No unread emails found in the last ${days_back} days.`);
          }

          let fetched = 0;
          const fetchErrors: string[] = [];
          for (const msg of messages) {
            try {
              await commsService.fetchEmail(msg.gmail_id);
              fetched++;
            } catch (e) {
              fetchErrors.push(`"${msg.subject}": ${String(e)}`);
            }
          }

          const analysis = await analysisService.analyzeNewEmails(max_emails);

          const lines = [
            `## Email Sync & Analysis`,
            `- Found: ${messages.length} emails`,
            `- Fetched: ${fetched}`,
            `- Analyzed: ${analysis.analyzed}`,
            `- New suggestions: **${analysis.suggestions}**`,
          ];
          if (fetchErrors.length > 0) lines.push(`- Fetch errors: ${fetchErrors.join("; ")}`);
          if (analysis.suggestions > 0) lines.push("", "Run `kernel_email_pending` to review suggestions.");
          return textResult(lines.join("\n"));
        } catch (err) {
          return errorResult(String(err));
        }
      },
    },
  ];
}
