/**
 * HTTP routes owned by the tasks module. Registered via the module's
 * getDashboardDescriptor.registerRoutes — the module captures `events`
 * via closure during initialize().
 */
import { HttpError, isHttpError, type KernelHttpServer, type SqliteDb, type EventBus } from "@kernl/extension-sdk";

export function registerTasksRoutes(
  server: KernelHttpServer,
  db: SqliteDb,
  events: EventBus,
): void {
  // Any unexpected failure in a mutation is answered with the same 400 it
  // always was; the validation 400s keep their own message.
  const invalidRequest = <T>(fn: () => T): T => {
    try { return fn(); } catch (err) {
      if (isHttpError(err)) throw err;
      throw new HttpError(400, "Invalid request");
    }
  };

  server.route("GET", "/api/tasks/all", () => {
    try {
      const rows = db.prepare(
        `SELECT id, title, description, status, priority, context, tags,
                due_date, progress, estimated_minutes, created_at, updated_at,
                started_at, completed_at
         FROM tasks ORDER BY
           CASE status WHEN 'in_progress' THEN 0 WHEN 'todo' THEN 1
                       WHEN 'blocked' THEN 2 WHEN 'done' THEN 3 ELSE 4 END,
           CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
                         WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
           created_at DESC`,
      ).all();
      return { tasks: rows };
    } catch { throw new HttpError(500, "Failed to fetch tasks"); }
  });

  server.route<{ id: string; field: string; value: unknown }>(
    "POST", "/api/tasks/update-field", ({ body }) => invalidRequest(() => {
      const allowed = ["title", "description", "context", "tags", "due_date", "progress", "estimated_minutes"];
      if (!body.id || !allowed.includes(body.field)) throw new HttpError(400, "Invalid id or field");
      const now = new Date().toISOString();
      db.prepare(`UPDATE tasks SET ${body.field} = ?, updated_at = ? WHERE id = ?`)
        .run(body.value ?? "", now, body.id);
      events.emit("data.changed", { module: "tasks", action: "update_field" });
      return { ok: true };
    }),
  );

  server.route<{
    title: string; description?: string; priority?: string; context?: string;
    tags?: string; due_date?: string; estimated_minutes?: number;
  }>("POST", "/api/tasks/create", ({ body }) => invalidRequest(() => {
    if (!body.title?.trim()) throw new HttpError(400, "Title required");
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO tasks (id, title, description, status, priority, context, tags, due_date, progress, estimated_minutes, created_at, updated_at)
       VALUES (?, ?, ?, 'todo', ?, ?, ?, ?, 0, ?, ?, ?)`,
    ).run(
      id, body.title.trim(), body.description ?? "", body.priority ?? "medium",
      body.context ?? "", body.tags ?? "", body.due_date ?? null,
      body.estimated_minutes ?? 0, now, now,
    );
    events.emit("data.changed", { module: "tasks", action: "create" });
    return { ok: true, id };
  }));

  server.route<{ id: string }>("POST", "/api/tasks/delete", ({ body }) => invalidRequest(() => {
    if (!body.id) throw new HttpError(400, "Missing id");
    db.prepare("DELETE FROM tasks WHERE id = ?").run(body.id);
    events.emit("data.changed", { module: "tasks", action: "delete" });
    return { ok: true };
  }));

  server.route<{ id: string; status: string }>("POST", "/api/tasks/update-status", ({ body }) => invalidRequest(() => {
    const valid = ["todo", "in_progress", "done", "blocked"];
    if (!body.id || !valid.includes(body.status)) throw new HttpError(400, "Invalid id or status");
    const now = new Date().toISOString();
    if (body.status === "in_progress") {
      db.prepare(
        "UPDATE tasks SET status = ?, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?",
      ).run(body.status, now, now, body.id);
    } else if (body.status === "done") {
      db.prepare(
        "UPDATE tasks SET status = ?, completed_at = ?, progress = 100, updated_at = ? WHERE id = ?",
      ).run(body.status, now, now, body.id);
    } else {
      db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?")
        .run(body.status, now, body.id);
    }
    events.emit("data.changed", { module: "tasks", action: "update_status" });
    return { ok: true };
  }));

  server.route<{ id: string; priority: string }>("POST", "/api/tasks/update-priority", ({ body }) => invalidRequest(() => {
    const valid = ["low", "medium", "high", "urgent"];
    if (!body.id || !valid.includes(body.priority)) throw new HttpError(400, "Invalid id or priority");
    const now = new Date().toISOString();
    db.prepare("UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ?")
      .run(body.priority, now, body.id);
    events.emit("data.changed", { module: "tasks", action: "update_priority" });
    return { ok: true };
  }));
}
