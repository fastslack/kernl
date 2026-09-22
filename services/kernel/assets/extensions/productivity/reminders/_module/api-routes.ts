/**
 * HTTP routes for reminders. Mirrors the tasks module pattern: simple
 * action endpoints (dismiss, snooze) backed by direct SQL writes.
 */
import { HttpError, isHttpError, type KernelHttpServer, type SqliteDb, type EventBus } from "@kernl/extension-sdk";

export function registerRemindersRoutes(
  server: KernelHttpServer,
  db: SqliteDb,
  events: EventBus,
): void {
  // GET /api/reminders/detail?id=<uuid> — used by the dashboard's hash-link
  // resolver (clicking a UUID in a tool-result opens its detail modal). All
  // columns including notify_* flags are returned; the modal renderer picks
  // which to show.
  server.route("GET", "/api/reminders/detail", ({ query }) => {
    const id = query.get("id");
    if (!id) throw new HttpError(400, "Missing id");
    const reminder = db.prepare("SELECT * FROM reminders WHERE id = ?").get(id);
    if (!reminder) throw new HttpError(404, "Not found");
    return { reminder };
  });

  // Any unexpected failure in an action (e.g. a `minutes` that makes an
  // invalid date) is answered with the same 400 it always was.
  const invalidRequest = <T>(fn: () => T): T => {
    try { return fn(); } catch (err) {
      if (isHttpError(err)) throw err;
      throw new HttpError(400, "Invalid request");
    }
  };

  server.route<{ id: string }>("POST", "/api/reminders/dismiss", ({ body }) => invalidRequest(() => {
    if (!body.id) throw new HttpError(400, "Missing id");
    const now = new Date().toISOString();
    db.prepare("UPDATE reminders SET status = 'dismissed', updated_at = ? WHERE id = ?")
      .run(now, body.id);
    events.emit("data.changed", { module: "reminders", action: "dismiss" });
    return { ok: true };
  }));

  server.route<{ id: string; minutes?: number }>("POST", "/api/reminders/snooze", ({ body }) => invalidRequest(() => {
    if (!body.id) throw new HttpError(400, "Missing id");
    const mins = body.minutes ?? 30;
    const snoozedUntil = new Date(Date.now() + mins * 60_000).toISOString();
    const now = new Date().toISOString();
    db.prepare("UPDATE reminders SET status = 'snoozed', snoozed_until = ?, updated_at = ? WHERE id = ?")
      .run(snoozedUntil, now, body.id);
    events.emit("data.changed", { module: "reminders", action: "snooze" });
    return { ok: true };
  }));
}
