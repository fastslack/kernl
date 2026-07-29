/**
 * Comms dashboard RPC slice — `comms.*` operations and the
 * `emailSuggestions.*` triage flow used by the dashboard.
 *
 * The `emailSuggestions.approve` handler optionally wires in tasks/reminders/
 * crm/shopping services so approved suggestions can be materialised in one
 * round-trip from the UI. Each is optional — missing services fall back to a
 * structured error from `approveSuggestion()`.
 */

import type { RpcAction } from "../../../../../src/core/mtw/rpc-handler.js";
import type { CommsService } from "./service.js";
import type { EmailAnalysisService } from "./email-analysis-service.js";
import type { TaskService } from "../../../productivity/tasks/_module/service.js";
import type { ReminderService } from "../../../productivity/reminders/_module/service.js";
import type { CrmService } from "../../crm/_module/service.js";
import type { ShoppingService } from "../../../home/shopping/_module/service.js";

export interface CommsDashboardRpcDeps {
  commsService: CommsService | null;
  emailAnalysisService: EmailAnalysisService | null;
  /** Optional sibling services consumed by `emailSuggestions.approve`. */
  taskService?: TaskService | null;
  reminderService?: ReminderService | null;
  crmService?: CrmService | null;
  shoppingService?: ShoppingService | null;
}

export function commsDashboardRpcActions(deps: CommsDashboardRpcDeps): RpcAction[] {
  const actions: RpcAction[] = [];

  if (deps.commsService) {
    const comms = deps.commsService;
    actions.push(
      {
        name: "comms.create",
        handler: async (args) => {
          const comm = comms.create({
            channel: typeof args.channel === "string" ? args.channel as "email" : undefined,
            direction: typeof args.direction === "string" ? args.direction as "inbound" | "outbound" : undefined,
            subject: typeof args.subject === "string" ? args.subject : undefined,
            body: typeof args.body === "string" ? args.body : undefined,
            body_html: typeof args.body_html === "string" ? args.body_html : undefined,
            contact_id: typeof args.contact_id === "string" ? args.contact_id : undefined,
            task_id: typeof args.task_id === "string" ? args.task_id : undefined,
            account_id: typeof args.account_id === "string" ? args.account_id : undefined,
            in_reply_to: typeof args.in_reply_to === "string" ? args.in_reply_to : undefined,
            recipients_to: typeof args.recipients_to === "string" ? args.recipients_to : undefined,
            recipients_cc: typeof args.recipients_cc === "string" ? args.recipients_cc : undefined,
            recipients_bcc: typeof args.recipients_bcc === "string" ? args.recipients_bcc : undefined,
          });
          return { ok: true, comm };
        },
      },
      {
        name: "comms.send",
        handler: async (args) => {
          const id = typeof args.id === "string" ? args.id : "";
          if (!id) return { error: "id is required" };
          const comm = await comms.sendEmail(id);
          return { ok: true, gmail_message_id: comm.gmail_message_id, sent_at: comm.sent_at };
        },
      },
      {
        name: "comms.update",
        handler: async (args) => {
          const id = typeof args.id === "string" ? args.id : "";
          if (!id) return { error: "id is required" };
          const { id: _id, ...changes } = args as Record<string, unknown>;
          const comm = comms.update(id, changes as Parameters<typeof comms.update>[1]);
          if (!comm) return { error: "Communication not found or not editable" };
          return { ok: true, comm };
        },
      },
      {
        name: "comms.search",
        handler: async (args) => {
          const query = typeof args.q === "string" ? args.q : "";
          const maxResults = typeof args.limit === "number" ? args.limit : 10;
          if (!query) return { error: "q is required" };
          const results = await comms.searchInbox(query, maxResults);
          return { results };
        },
      },
      {
        name: "comms.thread",
        handler: async (args) => {
          const threadId = typeof args.thread_id === "string" ? args.thread_id : "";
          if (!threadId) return { error: "thread_id is required" };
          const messages = comms.getThread(threadId);
          return { messages };
        },
      },
      {
        name: "comms.detail",
        handler: async (args) => {
          const id = typeof args.id === "string" ? args.id : "";
          if (!id) return { error: "id is required" };
          const detail = comms.getWithDetails(id);
          if (!detail) return { error: "Communication not found" };
          return detail;
        },
      },
      {
        name: "comms.campaign",
        handler: async (args) => {
          const id = typeof args.id === "string" ? args.id : "";
          if (!id) return { error: "id is required" };
          const campaign = comms.getCampaign(id);
          if (!campaign) return { error: "Campaign not found" };
          const recipients = comms.getCampaignRecipients(id);
          return { campaign, recipients };
        },
      },
    );
  }

  if (deps.emailAnalysisService) {
    const emailAnalysis = deps.emailAnalysisService;

    actions.push({
      name: "emailSuggestions.list",
      handler: async (args) => {
        const limit = typeof args.limit === "number" ? args.limit : 50;
        const suggestions = emailAnalysis.getPendingSuggestions(limit);
        // Counts by type — cheap to compute, saves a second roundtrip
        // for the filter chips on the dashboard.
        const counts = { task: 0, reminder: 0, contact: 0, shopping: 0 };
        for (const s of suggestions) counts[s.type]++;
        return { suggestions, counts, total: suggestions.length };
      },
    });

    actions.push({
      name: "emailSuggestions.dismiss",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) return { error: "id is required" };
        emailAnalysis.dismissSuggestion(id);
        return { ok: true };
      },
    });

    actions.push({
      name: "emailSuggestions.approve",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) return { error: "id is required" };

        // Wire only the services that exist. approveSuggestion() throws
        // a clear error if the type's service is missing — surfaces in
        // the UI as a "not available" toast instead of a silent no-op.
        const services: Parameters<typeof emailAnalysis.approveSuggestion>[2] = {};
        if (deps.taskService) {
          const ts = deps.taskService;
          services.createTask = async (p) => ts.create({
            title: p.title,
            description: p.description,
            priority: p.priority,
            context: p.context,
            due_date: p.due_date,
          }).id;
        }
        if (deps.reminderService) {
          const rs = deps.reminderService;
          services.createReminder = async (p) => rs.create({
            title: p.title,
            body: p.body ?? "",
            trigger_at: p.trigger_at,
            repeat: p.repeat ?? "none",
          }).id;
        }
        if (deps.crmService) {
          const cs = deps.crmService;
          services.createContact = async (p) => cs.addContact({
            name: p.name,
            email: p.email,
            company: p.company,
            relationship: p.relationship,
            notes: p.notes,
          }).id;
        }
        if (deps.shoppingService) {
          const ss = deps.shoppingService;
          services.addShoppingItem = async (p) => {
            const lists = ss.getLists("active");
            const listId = lists.length > 0
              ? lists[0].id
              : ss.createList({ name: "Shopping" }).id;
            const item = ss.addListItem({
              list_id: listId,
              name: p.name,
              quantity: p.quantity ?? 1,
              unit: p.unit ?? "pcs",
              notes: p.notes ?? "",
            });
            if (!item) throw new Error("Failed to add shopping item");
            return item.id;
          };
        }

        const overrides = (args.overrides ?? {}) as Record<string, unknown>;
        try {
          const result = await emailAnalysis.approveSuggestion(id, overrides, services);
          return { ok: true, ...result };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    });
  }

  return actions;
}
