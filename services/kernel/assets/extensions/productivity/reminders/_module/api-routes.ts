/**
 * HTTP routes for reminders. Mirrors the tasks module pattern: simple
 * action endpoints (dismiss, snooze) backed by direct SQL writes.
 */
import type { KernelHttpServer } from "../../../../../src/core/http-server.js";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { EventBus } from "../../../../../src/core/event-bus.js";

export function registerRemindersRoutes(
  server: KernelHttpServer,
  db: SqliteDb,
  events: EventBus,
): void {
  // GET /api/reminders/detail?id=<uuid> — used by the dashboard's hash-link
  // resolver (clicking a UUID in a tool-result opens its detail modal). All
  // columns including notify_* flags are returned; the modal renderer picks
  // which to show.
  server.get("/api/reminders/detail", (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const id = url.searchParams.get("id");
      if (!id) { server.json(res, 400, { error: "Missing id" }); return; }
      const reminder = db.prepare("SELECT * FROM reminders WHERE id = ?").get(id);
      if (!reminder) { server.json(res, 404, { error: "Not found" }); return; }
      server.json(res, 200, { reminder });
    } catch (err) {
      server.json(res, 500, { error: String(err) });
    }
  });

  server.post("/api/reminders/dismiss", async (req, res) => {
    try {
      const body = await server.parseBody<{ id: string }>(req);
      if (!body.id) { server.json(res, 400, { error: "Missing id" }); return; }
      const now = new Date().toISOString();
      db.prepare("UPDATE reminders SET status = 'dismissed', updated_at = ? WHERE id = ?")
        .run(now, body.id);
      events.emit("data.changed", { module: "reminders", action: "dismiss" });
      server.json(res, 200, { ok: true });
    } catch { server.json(res, 400, { error: "Invalid request" }); }
  });

  server.post("/api/reminders/snooze", async (req, res) => {
    try {
      const body = await server.parseBody<{ id: string; minutes?: number }>(req);
      if (!body.id) { server.json(res, 400, { error: "Missing id" }); return; }
      const mins = body.minutes ?? 30;
      const snoozedUntil = new Date(Date.now() + mins * 60_000).toISOString();
      const now = new Date().toISOString();
      db.prepare("UPDATE reminders SET status = 'snoozed', snoozed_until = ?, updated_at = ? WHERE id = ?")
        .run(snoozedUntil, now, body.id);
      events.emit("data.changed", { module: "reminders", action: "snooze" });
      server.json(res, 200, { ok: true });
    } catch { server.json(res, 400, { error: "Invalid request" }); }
  });
}
