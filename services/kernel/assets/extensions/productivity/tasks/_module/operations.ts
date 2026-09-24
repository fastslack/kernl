/**
 * Task operations the dashboard reaches over both the WS RPC and HTTP.
 *
 * Every entry delegates to TaskService (the source of truth) so the dashboard
 * gets the same behaviour as the MCP tools: tag-entity sync, auto-block/
 * unblock, subtask progress rollup, recurrence generation and soft-delete.
 * The RPC side already did; the `/api/tasks/*` fallback still ran raw SQL, so
 * a task completed or deleted while the WS bridge was down skipped all of it
 * (and delete was a hard delete). Now rpc-actions.ts exposes this map as is
 * and api-routes.ts binds each entry to its path.
 */

import { HttpError, pickArgs, type Operation, type EventBus } from "@kernl/extension-sdk";
import type { TaskService } from "./service.js";
import type { Task } from "./types.js";

const STATUSES: ReadonlyArray<Task["status"]> = ["todo", "in_progress", "done", "blocked"];
const PRIORITIES: ReadonlyArray<Task["priority"]> = ["low", "medium", "high", "urgent"];
const EDITABLE_FIELDS = ["title", "description", "context", "tags", "due_date", "progress", "estimated_minutes"] as const;

export function taskOperations(service: TaskService, events?: EventBus | null): Record<string, Operation> {
  const changed = (action: string) => { events?.emit("data.changed", { module: "tasks", action }); };
  const update = (id: string, changes: Parameters<TaskService["update"]>[1]) => {
    if (!service.update(id, changes)) throw new HttpError(404, "Task not found");
    return { ok: true };
  };

  return {
    // service.list() already excludes soft-deleted rows.
    "tasks.list": () => ({ tasks: service.list() }),

    "tasks.create": (input) => {
      const args = pickArgs(input, {
        title: "string", description: "string", priority: "string", context: "string",
        tags: "string", due_date: "string", estimated_minutes: "number",
      });
      const title = args.title?.trim() ?? "";
      if (!title) throw new HttpError(400, "Title required");
      if (args.priority && !PRIORITIES.includes(args.priority as Task["priority"])) {
        throw new HttpError(400, "Invalid priority");
      }
      const task = service.create({
        title,
        description: args.description || undefined,
        priority: (args.priority as Task["priority"]) || undefined,
        context: args.context || undefined,
        tags: args.tags || undefined,
        due_date: args.due_date || undefined,
        estimated_minutes: args.estimated_minutes,
      });
      changed("create");
      return { ok: true, id: task.id };
    },

    "tasks.updateField": (input) => {
      const { id, field } = pickArgs(input, { id: "string", field: "string" });
      if (!id || !EDITABLE_FIELDS.includes(field as (typeof EDITABLE_FIELDS)[number])) {
        throw new HttpError(400, "Invalid id or field");
      }
      const value = field === "progress" || field === "estimated_minutes"
        ? Number(input.value ?? 0)
        : (input.value ?? "");
      const result = update(id, { [field as string]: value } as Partial<Task>);
      changed("update_field");
      return result;
    },

    "tasks.updateStatus": (input) => {
      const { id, status } = pickArgs(input, { id: "string", status: "string" });
      if (!id || !STATUSES.includes(status as Task["status"])) throw new HttpError(400, "Invalid id or status");
      const result = update(id, { status: status as Task["status"] });
      changed("update_status");
      return result;
    },

    "tasks.updatePriority": (input) => {
      const { id, priority } = pickArgs(input, { id: "string", priority: "string" });
      if (!id || !PRIORITIES.includes(priority as Task["priority"])) throw new HttpError(400, "Invalid id or priority");
      const result = update(id, { priority: priority as Task["priority"] });
      changed("update_priority");
      return result;
    },

    "tasks.reschedule": (input) => {
      const { id, due_date } = pickArgs(input, { id: "string", due_date: "string" });
      if (!id || !due_date) throw new HttpError(400, "id and due_date required");
      return update(id, { due_date });
    },

    "tasks.delete": (input) => {
      const { id } = pickArgs(input, { id: "string" });
      if (!id) throw new HttpError(400, "Missing id");
      if (!service.softDelete(id)) throw new HttpError(404, "Task not found");
      changed("delete");
      return { ok: true };
    },
  };
}
