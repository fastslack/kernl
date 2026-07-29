import type { SqliteDb } from "../../../../../../src/core/db/sqlite.js";
import type { TaskService } from "../../../../productivity/tasks/_module/service.js";
import type { GoogleClient } from "../google-client.js";
import type { GoogleTask, GoogleTaskList, ImportResult } from "../../../../../../src/core/integrations/google-types.js";
import { newId, isoNow } from "../../../../../../src/core/helpers.js";
import { log } from "../../../../../../src/core/logger.js";

const TASK_LISTS_URL = "https://www.googleapis.com/tasks/v1/users/@me/lists";

function listToContext(listTitle: string): string {
  const lower = listTitle.toLowerCase().trim();
  if (lower === "work" || lower === "trabajo") return "@work";
  if (lower === "home" || lower === "casa" || lower === "hogar") return "@home";
  if (lower === "errands" || lower === "recados") return "@errands";
  return `@${lower}`;
}

export function mapGoogleTask(task: GoogleTask, listTitle: string) {
  return {
    title: task.title ?? "(no title)",
    description: task.notes ?? "",
    due_date: task.due ? task.due.split("T")[0] : undefined,
    status: task.status === "completed" ? ("done" as const) : ("todo" as const),
    priority: "medium" as const,
    context: listToContext(listTitle),
  };
}

export async function importTasks(
  client: GoogleClient,
  db: SqliteDb,
  taskService: TaskService,
): Promise<ImportResult> {
  const result: ImportResult = { source: "tasks", imported: 0, skipped: 0, errors: [] };

  // Get all task lists
  const taskLists = await client.getPaginated<GoogleTaskList>(
    TASK_LISTS_URL,
    { maxResults: "100" },
    "items",
  );

  for (const list of taskLists) {
    const listUrl = `https://www.googleapis.com/tasks/v1/lists/${list.id}/tasks`;

    const tasks = await client.getPaginated<GoogleTask>(
      listUrl,
      { showCompleted: "false", maxResults: "100" },
      "items",
    );

    for (const task of tasks) {
      if (!task.id) {
        result.skipped++;
        continue;
      }

      // Skip empty titles
      if (!task.title?.trim()) {
        result.skipped++;
        continue;
      }

      try {
        const existing = db
          .prepare("SELECT local_id FROM google_sync_map WHERE source = 'tasks' AND google_id = ?")
          .get(task.id) as { local_id: string } | undefined;

        if (existing) {
          result.skipped++;
          continue;
        }

        const mapped = mapGoogleTask(task, list.title);
        const created = taskService.create(mapped);

        db.prepare(
          `INSERT INTO google_sync_map (id, source, google_id, local_id, local_table, synced_at)
           VALUES (?, 'tasks', ?, ?, 'tasks', ?)`,
        ).run(newId(), task.id, created.id, isoNow());

        result.imported++;
      } catch (err) {
        result.errors.push(`Task "${task.title}": ${String(err)}`);
      }
    }
  }

  db.prepare(
    `INSERT INTO google_sync_meta (source, last_sync_at, items_synced)
     VALUES ('tasks', ?, ?)
     ON CONFLICT(source) DO UPDATE SET last_sync_at = excluded.last_sync_at, items_synced = excluded.items_synced`,
  ).run(isoNow(), result.imported);

  log.info(`Tasks sync: ${result.imported} imported, ${result.skipped} skipped`);
  return result;
}
