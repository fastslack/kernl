/**
 * /api/contacts/* — the HTTP side of the contacts operations the dashboard
 * reaches through rpcOrCall (WS first, these routes when the bridge is down).
 * Both roads run the same function; see operations.ts.
 */
import type { KernelHttpServer, EventBus } from "@kernl/extension-sdk";
import type { CrmService } from "./service.js";
import { contactOperations } from "./operations.js";

export function registerContactsRoutes(
  server: KernelHttpServer,
  service: CrmService,
  events?: EventBus,
): void {
  const op = contactOperations(service, events);
  server.operation("GET", "/api/contacts/all", op["contacts.list"]);
  server.operation("GET", "/api/contacts/detail", op["contacts.detail"]);
  server.operation("POST", "/api/contacts/create", op["contacts.create"]);
  server.operation("POST", "/api/contacts/update", op["contacts.update"]);
  server.operation("POST", "/api/contacts/delete", op["contacts.delete"]);
  server.operation("POST", "/api/contacts/log-interaction", op["contacts.logInteraction"]);
}
