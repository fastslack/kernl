/**
 * HTTP routes owned by the tasks module. Registered via the module's
 * getDashboardDescriptor.registerRoutes — the module captures `events`
 * via closure during initialize().
 *
 * These are the fallback of the `tasks.*` RPC actions the dashboard calls
 * through rpcOrCall; both roads run the same function (operations.ts).
 */
import type { KernelHttpServer, EventBus } from "@kernl/extension-sdk";
import type { TaskService } from "./service.js";
import { taskOperations } from "./operations.js";

export function registerTasksRoutes(
  server: KernelHttpServer,
  service: TaskService,
  events: EventBus,
): void {
  const op = taskOperations(service, events);
  server.operation("GET", "/api/tasks/all", op["tasks.list"]);
  server.operation("POST", "/api/tasks/update-field", op["tasks.updateField"]);
  server.operation("POST", "/api/tasks/create", op["tasks.create"]);
  server.operation("POST", "/api/tasks/delete", op["tasks.delete"]);
  server.operation("POST", "/api/tasks/update-status", op["tasks.updateStatus"]);
  server.operation("POST", "/api/tasks/update-priority", op["tasks.updatePriority"]);
}
