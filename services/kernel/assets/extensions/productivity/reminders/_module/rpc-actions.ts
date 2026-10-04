/**
 * Reminders RPC Actions — the WS side of the reminder mutations; dismiss and
 * snooze are shared with their HTTP routes. See operations.ts.
 */

import { rpcActionsFrom, type RpcAction, type EventBus } from "@kernl/extension-sdk";
import type { ReminderService } from "./service.js";
import { reminderOperations } from "./operations.js";

export function remindersRpcActions(service: ReminderService, events?: EventBus | null): RpcAction[] {
  return rpcActionsFrom(reminderOperations(service, events));
}
