/**
 * Tasks RPC Actions — replaces GET /api/tasks/* and POST /api/tasks/* routes.
 *
 * Delegates to TaskService (the source of truth) so the dashboard gets the
 * same behaviour as the MCP tools: tag-entity sync, auto-block/unblock,
 * subtask progress rollup, recurrence generation, cycle detection and
 * soft-delete. (Previously these handlers ran raw SQL and bypassed all of it.)
 */

import type { RpcAction } from "../../../../../src/core/mtw/rpc-handler.js";
import type { TaskService } from "./service.js";
import type { Task } from "./types.js";

export function tasksRpcActions(service: TaskService): RpcAction[] {
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  return [
    {
      name: "tasks.list",
      handler: async () => {
        // service.list() already excludes soft-deleted rows.
        return { tasks: service.list() };
      },
    },
    {
      name: "tasks.create",
      handler: async (args) => {
        const title = str(args.title).trim();
        if (!title) throw new Error("Title required");
        const task = service.create({
          title,
          description: str(args.description) || undefined,
          priority: (args.priority as Task["priority"]) || undefined,
          context: str(args.context) || undefined,
          tags: str(args.tags) || undefined,
          due_date: str(args.due_date) || undefined,
          estimated_minutes: typeof args.estimated_minutes === "number" ? args.estimated_minutes : undefined,
        });
        return { ok: true, id: task.id };
      },
    },
    {
      name: "tasks.updateField",
      handler: async (args) => {
        const allowed = ["title", "description", "context", "tags", "due_date", "progress", "estimated_minutes"] as const;
        const id = str(args.id);
        const field = str(args.field) as (typeof allowed)[number];
        if (!id || !allowed.includes(field)) throw new Error("Invalid id or field");
        const value = field === "progress" || field === "estimated_minutes"
          ? Number(args.value ?? 0)
          : (args.value ?? "");
        const updated = service.update(id, { [field]: value } as Partial<Task>);
        if (!updated) throw new Error("Task not found");
        return { ok: true };
      },
    },
    {
      name: "tasks.updateStatus",
      handler: async (args) => {
        const valid = ["todo", "in_progress", "done", "blocked"];
        const id = str(args.id);
        const status = str(args.status);
        if (!id || !valid.includes(status)) throw new Error("Invalid id or status");
        const updated = service.update(id, { status: status as Task["status"] });
        if (!updated) throw new Error("Task not found");
        return { ok: true };
      },
    },
    {
      name: "tasks.updatePriority",
      handler: async (args) => {
        const valid = ["low", "medium", "high", "urgent"];
        const id = str(args.id);
        const priority = str(args.priority);
        if (!id || !valid.includes(priority)) throw new Error("Invalid id or priority");
        const updated = service.update(id, { priority: priority as Task["priority"] });
        if (!updated) throw new Error("Task not found");
        return { ok: true };
      },
    },
    {
      name: "tasks.reschedule",
      handler: async (args) => {
        const id = str(args.id);
        const due_date = str(args.due_date);
        if (!id || !due_date) throw new Error("id and due_date required");
        const updated = service.update(id, { due_date });
        if (!updated) throw new Error("Task not found");
        return { ok: true };
      },
    },
    {
      name: "tasks.delete",
      handler: async (args) => {
        const id = str(args.id);
        if (!id) throw new Error("Missing id");
        const ok = service.softDelete(id);
        if (!ok) throw new Error("Task not found");
        return { ok: true };
      },
    },
  ];
}
