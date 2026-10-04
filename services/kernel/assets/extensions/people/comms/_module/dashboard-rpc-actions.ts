/**
 * Comms dashboard RPC slice — `comms.*` operations and the
 * `emailSuggestions.*` triage flow used by the dashboard. All but approve
 * are operations shared with their HTTP routes; see dashboard-operations.ts.
 *
 * The `emailSuggestions.approve` handler optionally wires in tasks/reminders/
 * crm/shopping services so approved suggestions can be materialised in one
 * round-trip from the UI. Each is optional — missing services fall back to a
 * structured error from `approveSuggestion()`.
 */

import { pickArgs, rpcActionsFrom, type RpcAction, type EventBus } from "@kernl/extension-sdk";
import type { CommsService } from "./service.js";
import type { EmailAnalysisService } from "./email-analysis-service.js";
import type { TaskService } from "../../../productivity/tasks/_module/service.js";
import type { ReminderService } from "../../../productivity/reminders/_module/service.js";
import type { CrmService } from "../../crm/_module/service.js";
import type { ShoppingService } from "../../../home/shopping/_module/service.js";
import { commsOperations, emailSuggestionOperations } from "./dashboard-operations.js";

export interface CommsDashboardRpcDeps {
  commsService: CommsService | null;
  emailAnalysisService: EmailAnalysisService | null;
  /** Optional sibling services consumed by `emailSuggestions.approve`. */
  taskService?: TaskService | null;
  reminderService?: ReminderService | null;
  crmService?: CrmService | null;
  shoppingService?: ShoppingService | null;
  events?: EventBus | null;
}

export function commsDashboardRpcActions(deps: CommsDashboardRpcDeps): RpcAction[] {
  const actions: RpcAction[] = [];

  // Shared with the /api/dashboard/comms/* routes; see dashboard-operations.ts.
  if (deps.commsService) actions.push(...rpcActionsFrom(commsOperations(deps.commsService, deps.events)));

  if (deps.emailAnalysisService) {
    const emailAnalysis = deps.emailAnalysisService;

    // list + dismiss are shared with the /api/email-suggestions routes.
    actions.push(...rpcActionsFrom(emailSuggestionOperations(emailAnalysis)));

    // approve is RPC-only: its HTTP route is deliberately locked (see
    // email-suggestions-routes.ts), and it needs the sibling services.
    actions.push({
      name: "emailSuggestions.approve",
      handler: async (args) => {
        const { id } = pickArgs(args, { id: "string" });
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

        const overrides = pickArgs(args, { overrides: "object" }).overrides ?? {};
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
