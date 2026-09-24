/**
 * Tasks RPC Actions — the WS side of the /api/tasks/* routes.
 * Each one is an operation shared with its HTTP route; see operations.ts.
 */

import { rpcActionsFrom, type RpcAction, type EventBus } from "@kernl/extension-sdk";
import type { TaskService } from "./service.js";
import { taskOperations } from "./operations.js";

export function tasksRpcActions(service: TaskService, events?: EventBus | null): RpcAction[] {
  return rpcActionsFrom(taskOperations(service, events));
}
