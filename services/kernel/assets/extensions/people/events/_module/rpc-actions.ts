/**
 * Events RPC Actions — event management + RSVP via mtwRequest, through
 * EventsService. See operations.ts.
 */

import { rpcActionsFrom, type RpcAction } from "@kernl/extension-sdk";
import type { EventsService } from "./service.js";
import { eventOperations } from "./operations.js";

export function eventsRpcActions(service: EventsService): RpcAction[] {
  return rpcActionsFrom(eventOperations(service));
}
