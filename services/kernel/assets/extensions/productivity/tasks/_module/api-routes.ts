/**
 * HTTP routes owned by the tasks module. Registered via the module's
 * getDashboardDescriptor.registerRoutes — the module captures `events`
 * via closure during initialize().
 */
import type { KernelHttpServer } from "../../../../../src/core/http-server.js";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { EventBus } from "../../../../../src/core/event-bus.js";

export function registerTasksRoutes(
  server: KernelHttpServer,
  db: SqliteDb,
  events: EventBus,
): void {
  server.get("/api/tasks/all", async (_req, res) => {
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
      server.json(res, 200, { tasks: rows });
    } catch { server.json(res, 500, { error: "Failed to fetch tasks" }); }
  });

  server.post("/api/tasks/update-field", async (req, res) => {
    try {
      const body = await server.parseBody<{ id: string; field: string; value: unknown }>(req);
      const allowed = ["title", "description", "context", "tags", "due_date", "progress", "estimated_minutes"];
      if (!body.id || !allowed.includes(body.field)) {
        server.json(res, 400, { error: "Invalid id or field" });
        return;
      }
      const now = new Date().toISOString();
      db.prepare(`UPDATE tasks SET ${body.field} = ?, updated_at = ? WHERE id = ?`)
        .run(body.value ?? "", now, body.id);
      events.emit("data.changed", { module: "tasks", action: "update_field" });
      server.json(res, 200, { ok: true });
    } catch { server.json(res, 400, { error: "Invalid request" }); }
  });

  server.post("/api/tasks/create", async (req, res) => {
    try {
      const body = await server.parseBody<{
        title: string; description?: string; priority?: string; context?: string;
        tags?: string; due_date?: string; estimated_minutes?: number;
      }>(req);
      if (!body.title?.trim()) { server.json(res, 400, { error: "Title required" }); return; }
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
      server.json(res, 200, { ok: true, id });
    } catch { server.json(res, 400, { error: "Invalid request" }); }
  });

  server.post("/api/tasks/delete", async (req, res) => {
    try {
      const body = await server.parseBody<{ id: string }>(req);
      if (!body.id) { server.json(res, 400, { error: "Missing id" }); return; }
      db.prepare("DELETE FROM tasks WHERE id = ?").run(body.id);
      events.emit("data.changed", { module: "tasks", action: "delete" });
      server.json(res, 200, { ok: true });
    } catch { server.json(res, 400, { error: "Invalid request" }); }
  });

  server.post("/api/tasks/update-status", async (req, res) => {
    try {
      const body = await server.parseBody<{ id: string; status: string }>(req);
      const valid = ["todo", "in_progress", "done", "blocked"];
      if (!body.id || !valid.includes(body.status)) {
        server.json(res, 400, { error: "Invalid id or status" });
        return;
      }
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
      server.json(res, 200, { ok: true });
    } catch { server.json(res, 400, { error: "Invalid request" }); }
  });

  server.post("/api/tasks/update-priority", async (req, res) => {
    try {
      const body = await server.parseBody<{ id: string; priority: string }>(req);
      const valid = ["low", "medium", "high", "urgent"];
      if (!body.id || !valid.includes(body.priority)) {
        server.json(res, 400, { error: "Invalid id or priority" });
        return;
      }
      const now = new Date().toISOString();
      db.prepare("UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ?")
        .run(body.priority, now, body.id);
      events.emit("data.changed", { module: "tasks", action: "update_priority" });
      server.json(res, 200, { ok: true });
    } catch { server.json(res, 400, { error: "Invalid request" }); }
  });
}
