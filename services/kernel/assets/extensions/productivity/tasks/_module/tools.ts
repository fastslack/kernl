import { z } from "zod";
import type { ToolDefinition } from "../../../../../src/core/types.js";
import type { TaskService } from "./service.js";
import { textResult, errorResult } from "../../../../../src/core/helpers.js";

function fmtMins(m: number): string {
  if (m <= 0) return "0m";
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h > 0 ? `${h}h${r > 0 ? ` ${r}m` : ""}` : `${r}m`;
}

export function taskTools(service: TaskService): ToolDefinition[] {
  return [
    {
      name: "kernel_tasks_create",
      description:
        "Create a new task. Supports GTD contexts (@home, @work, @errands), priority levels, effort estimation, progress tracking, and tags.",
      inputSchema: z.object({
        title: z.string().describe("Task title"),
        description: z.string().optional().describe("Detailed description"),
        priority: z
          .enum(["low", "medium", "high", "urgent"])
          .optional()
          .describe("Priority level (default: medium)"),
        context: z
          .string()
          .optional()
          .describe("GTD context, e.g. @home, @work, @errands"),
        due_date: z
          .string()
          .optional()
          .describe("Due date in ISO format (YYYY-MM-DD)"),
        target_date: z
          .string()
          .optional()
          .describe("Aspirational completion date (YYYY-MM-DD), distinct from hard due_date deadline"),
        estimated_minutes: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Estimated effort in minutes"),
        progress: z
          .number()
          .int()
          .min(0)
          .max(100)
          .optional()
          .describe("Progress percentage 0-100"),
        tags: z
          .string()
          .optional()
          .describe("Comma-separated tags, e.g. 'backend,api'"),
        project_id: z.string().optional().describe("Project this task belongs to"),
        parent_task_id: z.string().optional().describe("Parent task ID (makes this a subtask)"),
        recurrence: z
          .string()
          .optional()
          .describe("RRULE for a recurring task, e.g. 'FREQ=WEEKLY' or 'FREQ=DAILY;INTERVAL=3'"),
        sort_order: z.number().int().optional().describe("Manual sort position"),
      }),
      handler: async (args) => {
        const input = args as {
          title: string;
          description?: string;
          priority?: "low" | "medium" | "high" | "urgent";
          context?: string;
          due_date?: string;
          target_date?: string;
          estimated_minutes?: number;
          progress?: number;
          tags?: string;
          project_id?: string;
          parent_task_id?: string;
          recurrence?: string;
          sort_order?: number;
        };
        const task = service.create(input);
        const lines = [
          `Task created:`,
          `  ID: ${task.id}`,
          `  Title: ${task.title}`,
          `  Priority: ${task.priority}`,
          `  Status: ${task.status}`,
        ];
        if (task.estimated_minutes > 0) lines.push(`  Estimate: ${fmtMins(task.estimated_minutes)}`);
        if (task.progress > 0) lines.push(`  Progress: ${task.progress}%`);
        if (task.tags) lines.push(`  Tags: ${task.tags}`);
        if (task.target_date) lines.push(`  Target: ${task.target_date}`);
        if (task.project_id) lines.push(`  Project: ${task.project_id}`);
        if (task.parent_task_id) lines.push(`  Parent: ${task.parent_task_id}`);
        if (task.recurrence) lines.push(`  Recurrence: ${task.recurrence}`);
        return textResult(lines.join("\n"));
      },
    },

    {
      name: "kernel_tasks_list",
      description:
        "List tasks with optional filters by status, priority, GTD context, or tag. Sorted by priority then due date.",
      inputSchema: z.object({
        status: z
          .enum(["todo", "in_progress", "done", "blocked"])
          .optional()
          .describe("Filter by status"),
        priority: z
          .enum(["low", "medium", "high", "urgent"])
          .optional()
          .describe("Filter by priority"),
        context: z.string().optional().describe("Filter by GTD context"),
        tag: z.string().optional().describe("Filter by tag (matches tasks containing this tag)"),
        project_id: z.string().optional().describe("Filter by project"),
        parent_task_id: z.string().optional().describe("Filter by parent task (lists subtasks)"),
        include_deleted: z.boolean().optional().describe("Include soft-deleted tasks (default: false)"),
      }),
      handler: async (args) => {
        const filters = args as {
          status?: "todo" | "in_progress" | "done" | "blocked";
          priority?: "low" | "medium" | "high" | "urgent";
          context?: string;
          tag?: string;
          project_id?: string;
          parent_task_id?: string;
          include_deleted?: boolean;
        };
        const tasks = service.list(filters);
        if (tasks.length === 0) return textResult("No tasks found.");

        const lines = tasks.map((t) => {
          let line = `[${t.priority.toUpperCase()}] ${t.title} — ${t.status}`;
          if (t.progress > 0 && t.progress < 100) line += ` (${t.progress}%)`;
          if (t.due_date) line += ` (due: ${t.due_date})`;
          if (t.context) line += ` ${t.context}`;
          if (t.tags) line += ` [${t.tags}]`;
          if (t.estimated_minutes > 0) line += ` ~${fmtMins(t.estimated_minutes)}`;
          line += `\n  ID: ${t.id}`;
          return line;
        });
        return textResult(`${tasks.length} task(s):\n\n${lines.join("\n\n")}`);
      },
    },

    {
      name: "kernel_tasks_update",
      description:
        "Update a task's fields. Status transitions auto-set timestamps: in_progress sets started_at, done sets completed_at and progress=100, reopening clears completed_at.",
      inputSchema: z.object({
        id: z.string().describe("Task ID"),
        title: z.string().optional(),
        description: z.string().optional(),
        status: z.enum(["todo", "in_progress", "done", "blocked"]).optional(),
        priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
        context: z.string().optional(),
        due_date: z.string().optional(),
        target_date: z.string().optional().describe("Aspirational completion date (YYYY-MM-DD)"),
        estimated_minutes: z.number().int().min(0).optional().describe("Estimated effort in minutes"),
        progress: z.number().int().min(0).max(100).optional().describe("Progress percentage 0-100"),
        tags: z.string().optional().describe("Comma-separated tags"),
        project_id: z.string().nullable().optional().describe("Reassign project (null clears it)"),
        parent_task_id: z.string().nullable().optional().describe("Reparent task (null detaches)"),
        sort_order: z.number().int().optional().describe("Manual sort position"),
        recurrence: z.string().optional().describe("RRULE for a recurring task"),
      }),
      handler: async (args) => {
        const { id, ...changes } = args as {
          id: string;
          title?: string;
          description?: string;
          status?: "todo" | "in_progress" | "done" | "blocked";
          priority?: "low" | "medium" | "high" | "urgent";
          context?: string;
          due_date?: string;
          target_date?: string;
          estimated_minutes?: number;
          progress?: number;
          tags?: string;
          project_id?: string | null;
          parent_task_id?: string | null;
          sort_order?: number;
          recurrence?: string;
        };
        const task = service.update(id, changes);
        if (!task) return errorResult(`Task not found: ${id}`);
        const lines = [
          `Task updated:`,
          `  Title: ${task.title}`,
          `  Status: ${task.status}`,
          `  Priority: ${task.priority}`,
          `  Progress: ${task.progress}%`,
        ];
        if (task.started_at) lines.push(`  Started: ${task.started_at}`);
        if (task.completed_at) lines.push(`  Completed: ${task.completed_at}`);
        if (task.estimated_minutes > 0) lines.push(`  Estimate: ${fmtMins(task.estimated_minutes)}`);
        if (task.tags) lines.push(`  Tags: ${task.tags}`);
        return textResult(lines.join("\n"));
      },
    },

    {
      name: "kernel_tasks_get",
      description: "Get a single task by ID, including its dependencies and subtasks.",
      inputSchema: z.object({
        id: z.string().describe("Task ID"),
      }),
      handler: async (args) => {
        const { id } = args as { id: string };
        const task = service.getById(id);
        if (!task) return errorResult(`Task not found: ${id}`);
        const lines = [
          `${task.title} — ${task.status} [${task.priority.toUpperCase()}]`,
          `  ID: ${task.id}`,
        ];
        if (task.description) lines.push(`  Description: ${task.description}`);
        if (task.progress > 0) lines.push(`  Progress: ${task.progress}%`);
        if (task.due_date) lines.push(`  Due: ${task.due_date}`);
        if (task.context) lines.push(`  Context: ${task.context}`);
        if (task.tags) lines.push(`  Tags: ${task.tags}`);
        if (task.project_id) lines.push(`  Project: ${task.project_id}`);
        if (task.parent_task_id) lines.push(`  Parent: ${task.parent_task_id}`);
        if (task.recurrence) lines.push(`  Recurrence: ${task.recurrence}`);
        if (task.deleted_at) lines.push(`  Deleted: ${task.deleted_at}`);
        const deps = service.getDependencies(id);
        if (deps.length) lines.push(`  Depends on:\n    ${deps.join("\n    ")}`);
        const subs = service.listSubtasks(id);
        if (subs.length) {
          lines.push(`  Subtasks (${subs.length}):`);
          for (const s of subs) lines.push(`    [${s.status}] ${s.title} (${s.id})`);
        }
        return textResult(lines.join("\n"));
      },
    },

    {
      name: "kernel_tasks_delete",
      description: "Soft-delete a task (sets deleted_at; excluded from default lists, recoverable).",
      inputSchema: z.object({
        id: z.string().describe("Task ID to delete"),
      }),
      handler: async (args) => {
        const { id } = args as { id: string };
        const ok = service.softDelete(id);
        if (!ok) return errorResult(`Task not found: ${id}`);
        return textResult(`Task deleted: ${id}`);
      },
    },

    {
      name: "kernel_tasks_add_dependency",
      description:
        "Add a dependency (task A depends on task B). SQLite is the source of truth; rejects self-dependencies and cycles. A todo task with an unfinished dependency is auto-set to 'blocked'.",
      inputSchema: z.object({
        task_id: z.string().describe("The task that has the dependency"),
        depends_on: z.string().describe("The task it depends on"),
      }),
      handler: async (args) => {
        const { task_id, depends_on } = args as { task_id: string; depends_on: string };
        try {
          service.addDependency(task_id, depends_on);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
        return textResult(`Dependency added: ${task_id} → depends on → ${depends_on}`);
      },
    },

    {
      name: "kernel_tasks_remove_dependency",
      description: "Remove a dependency between two tasks. Completing all deps auto-unblocks a task.",
      inputSchema: z.object({
        task_id: z.string().describe("The dependent task"),
        depends_on: z.string().describe("The dependency to remove"),
      }),
      handler: async (args) => {
        const { task_id, depends_on } = args as { task_id: string; depends_on: string };
        const ok = service.removeDependency(task_id, depends_on);
        if (!ok) return errorResult("No such dependency to remove.");
        return textResult(`Dependency removed: ${task_id} ⇏ ${depends_on}`);
      },
    },

    {
      name: "kernel_tasks_get_dependencies",
      description: "Get all dependencies for a task (from SQLite).",
      inputSchema: z.object({
        task_id: z.string().describe("Task ID to check dependencies for"),
      }),
      handler: async (args) => {
        const { task_id } = args as { task_id: string };
        const deps = service.getDependencies(task_id);
        if (deps.length === 0)
          return textResult("No dependencies found for this task.");
        return textResult(`Dependencies:\n${deps.join("\n")}`);
      },
    },

    {
      name: "kernel_tasks_blocked",
      description: "List tasks currently blocked, with the IDs of their unfinished dependencies.",
      inputSchema: z.object({}),
      handler: async () => {
        const blocked = service.listBlocked();
        if (blocked.length === 0) return textResult("No blocked tasks.");
        const lines = blocked.map(
          (b) => `[BLOCKED] ${b.task.title} (${b.task.id})\n  waiting on: ${b.blockedBy.join(", ") || "(none)"}`,
        );
        return textResult(`${blocked.length} blocked task(s):\n\n${lines.join("\n\n")}`);
      },
    },

    {
      name: "kernel_tasks_add_subtask",
      description: "Create a subtask under a parent task. The parent's progress rolls up from its subtasks.",
      inputSchema: z.object({
        parent_id: z.string().describe("Parent task ID"),
        title: z.string().describe("Subtask title"),
        priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
        due_date: z.string().optional().describe("Due date (YYYY-MM-DD)"),
      }),
      handler: async (args) => {
        const { parent_id, ...input } = args as {
          parent_id: string;
          title: string;
          priority?: "low" | "medium" | "high" | "urgent";
          due_date?: string;
        };
        if (!service.getById(parent_id)) return errorResult(`Parent task not found: ${parent_id}`);
        const sub = service.addSubtask(parent_id, input);
        return textResult(`Subtask created under ${parent_id}:\n  ${sub.title} (${sub.id})`);
      },
    },

    {
      name: "kernel_tasks_reorder",
      description: "Set the manual sort order of tasks. Pass task IDs in the desired order.",
      inputSchema: z.object({
        ordered_ids: z.array(z.string()).describe("Task IDs in the desired order"),
      }),
      handler: async (args) => {
        const { ordered_ids } = args as { ordered_ids: string[] };
        service.reorder(ordered_ids);
        return textResult(`Reordered ${ordered_ids.length} task(s).`);
      },
    },

    {
      name: "kernel_tasks_recurrence_preview",
      description:
        "Preview the next due date for an RRULE without creating anything. Supports FREQ=DAILY|WEEKLY|MONTHLY, INTERVAL, and WEEKLY BYDAY.",
      inputSchema: z.object({
        from_date: z.string().describe("Base date (YYYY-MM-DD)"),
        recurrence: z.string().describe("RRULE, e.g. 'FREQ=WEEKLY;BYDAY=MO'"),
      }),
      handler: async (args) => {
        const { from_date, recurrence } = args as { from_date: string; recurrence: string };
        const next = service.previewNextDue(from_date, recurrence);
        if (!next) return errorResult(`Could not parse recurrence rule: ${recurrence}`);
        return textResult(`Next occurrence after ${from_date}: ${next}`);
      },
    },

    {
      name: "kernel_tasks_list_tags",
      description: "List all distinct tags across tasks.",
      inputSchema: z.object({}),
      handler: async () => {
        const tags = service.listTags();
        if (tags.length === 0) return textResult("No tags yet.");
        return textResult(`${tags.length} tag(s):\n${tags.map((t) => `  #${t.name}`).join("\n")}`);
      },
    },

    {
      name: "kernel_tasks_project_create",
      description: "Create a project to group tasks.",
      inputSchema: z.object({
        name: z.string().describe("Project name"),
        color: z.string().optional().describe("Hex color, e.g. '#09f'"),
        icon: z.string().optional().describe("Icon name or emoji"),
        area: z.string().optional().describe("Life area, e.g. 'Work', 'Home'"),
        sort_order: z.number().int().optional(),
      }),
      handler: async (args) => {
        const input = args as {
          name: string; color?: string; icon?: string; area?: string; sort_order?: number;
        };
        const p = service.createProject(input);
        return textResult(`Project created:\n  ${p.name} (${p.id})`);
      },
    },

    {
      name: "kernel_tasks_project_list",
      description: "List projects (active only by default).",
      inputSchema: z.object({
        include_archived: z.boolean().optional().describe("Include archived projects"),
      }),
      handler: async (args) => {
        const { include_archived } = args as { include_archived?: boolean };
        const projects = service.listProjects({ include_archived });
        if (projects.length === 0) return textResult("No projects found.");
        const lines = projects.map(
          (p) => `${p.name}${p.area ? ` [${p.area}]` : ""} — ${p.status}\n  ID: ${p.id}`,
        );
        return textResult(`${projects.length} project(s):\n\n${lines.join("\n\n")}`);
      },
    },

    {
      name: "kernel_tasks_project_update",
      description: "Update a project's fields.",
      inputSchema: z.object({
        id: z.string().describe("Project ID"),
        name: z.string().optional(),
        color: z.string().optional(),
        icon: z.string().optional(),
        area: z.string().optional(),
        sort_order: z.number().int().optional(),
        status: z.enum(["active", "archived"]).optional(),
      }),
      handler: async (args) => {
        const { id, ...changes } = args as {
          id: string;
          name?: string; color?: string; icon?: string; area?: string;
          sort_order?: number; status?: "active" | "archived";
        };
        const p = service.updateProject(id, changes);
        if (!p) return errorResult(`Project not found: ${id}`);
        return textResult(`Project updated: ${p.name} (${p.status})`);
      },
    },

    {
      name: "kernel_tasks_project_archive",
      description: "Archive a project (hides it from the default list; tasks are unaffected).",
      inputSchema: z.object({
        id: z.string().describe("Project ID to archive"),
      }),
      handler: async (args) => {
        const { id } = args as { id: string };
        const ok = service.archiveProject(id);
        if (!ok) return errorResult(`Project not found: ${id}`);
        return textResult(`Project archived: ${id}`);
      },
    },

    {
      name: "kernel_tasks_set_project",
      description: "Assign a task to a project, or clear it (pass project_id=null).",
      inputSchema: z.object({
        task_id: z.string().describe("Task ID"),
        project_id: z.string().nullable().describe("Project ID, or null to clear"),
      }),
      handler: async (args) => {
        const { task_id, project_id } = args as { task_id: string; project_id: string | null };
        const task = service.setProject(task_id, project_id);
        if (!task) return errorResult(`Task not found: ${task_id}`);
        return textResult(
          project_id
            ? `Task ${task_id} assigned to project ${project_id}.`
            : `Task ${task_id} removed from its project.`,
        );
      },
    },
  ];
}
