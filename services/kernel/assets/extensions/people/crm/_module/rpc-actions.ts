/**
 * CRM/Contacts RPC Actions — the WS side of the /api/contacts/* routes.
 * Each one is an operation shared with its HTTP route; see operations.ts.
 */

import { rpcActionsFrom, type RpcAction, type EventBus } from "@kernl/extension-sdk";
import type { CrmService } from "./service.js";
import { contactOperations } from "./operations.js";

export function contactsRpcActions(service: CrmService, events?: EventBus | null): RpcAction[] {
  return rpcActionsFrom(contactOperations(service, events));
}
