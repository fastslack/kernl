/**
 * HTTP routes for reminders: the detail lookup, and the dismiss/snooze
 * fallback of the `reminders.*` RPC actions (both roads run the same
 * function; see operations.ts).
 */
import { HttpError, type KernelHttpServer, type EventBus } from "@kernl/extension-sdk";
import type { ReminderService } from "./service.js";
import { reminderOperations } from "./operations.js";

export function registerRemindersRoutes(
  server: KernelHttpServer,
  service: ReminderService,
  events: EventBus,
): void {
  // GET /api/reminders/detail?id=<uuid> — used by the dashboard's hash-link
  // resolver (clicking a UUID in a tool-result opens its detail modal). All
  // columns including notify_* flags are returned; the modal renderer picks
  // which to show.
  server.route("GET", "/api/reminders/detail", ({ query }) => {
    const id = query.get("id");
    if (!id) throw new HttpError(400, "Missing id");
    const reminder = service.getById(id);
    if (!reminder) throw new HttpError(404, "Not found");
    return { reminder };
  });

  const op = reminderOperations(service, events);
  server.operation("POST", "/api/reminders/dismiss", op["reminders.dismiss"]);
  server.operation("POST", "/api/reminders/snooze", op["reminders.snooze"]);
}
