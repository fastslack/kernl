import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { GraphDriver } from "../../../../../src/core/db-drivers/graph-driver.js";
import type { Task, Tag, TaskProject } from "./types.js";
import { newId, isoNow } from "../../../../../src/core/helpers.js";

export class TaskService {
  constructor(
    private db: SqliteDb,
    private getGraph: () => GraphDriver | null,
  ) {}

  create(input: {
    title: string;
    description?: string;
    priority?: Task["priority"];
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
  }): Task {
    const now = isoNow();
    const task: Task = {
      id: newId(),
      title: input.title,
      description: input.description ?? "",
      status: "todo",
      priority: input.priority ?? "medium",
      context: input.context ?? "",
      due_date: input.due_date ?? null,
      started_at: null,
      completed_at: null,
      target_date: input.target_date ?? null,
      estimated_minutes: input.estimated_minutes ?? 0,
      progress: input.progress ?? 0,
      tags: input.tags ?? "",
      project_id: input.project_id ?? null,
      parent_task_id: input.parent_task_id ?? null,
      sort_order: input.sort_order ?? 0,
      recurrence: input.recurrence ?? "",
      recurrence_parent_id: null,
      reminder_id: "",
      deleted_at: null,
      created_at: now,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO tasks (id, title, description, status, priority, context, due_date,
         started_at, completed_at, target_date, estimated_minutes, progress, tags,
         project_id, parent_task_id, sort_order, recurrence, recurrence_parent_id,
         reminder_id, deleted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id, task.title, task.description, task.status, task.priority,
        task.context, task.due_date, task.started_at, task.completed_at,
        task.target_date, task.estimated_minutes, task.progress, task.tags,
        task.project_id, task.parent_task_id, task.sort_order, task.recurrence,
        task.recurrence_parent_id, task.reminder_id, task.deleted_at,
        task.created_at, task.updated_at,
      );

    if (task.tags) this.syncTags(task.id, task.tags);

    const graph = this.getGraph();
    if (graph?.capabilities.cypher) {
      graph
        .run(
          `MERGE (t:Task {id: $id})
           SET t.title = $title, t.status = $status, t.priority = $priority`,
          { id: task.id, title: task.title, status: task.status, priority: task.priority },
        )
        .catch(() => {});
    }

    return task;
  }

  list(filters?: {
    status?: Task["status"];
    priority?: Task["priority"];
    context?: string;
    tag?: string;
    project_id?: string;
    parent_task_id?: string;
    include_deleted?: boolean;
  }): Task[] {
    let sql = "SELECT * FROM tasks WHERE 1=1";
    const params: unknown[] = [];

    if (!filters?.include_deleted) sql += " AND deleted_at IS NULL";
    if (filters?.status) { sql += " AND status = ?"; params.push(filters.status); }
    if (filters?.priority) { sql += " AND priority = ?"; params.push(filters.priority); }
    if (filters?.context) { sql += " AND context = ?"; params.push(filters.context); }
    if (filters?.project_id) { sql += " AND project_id = ?"; params.push(filters.project_id); }
    if (filters?.parent_task_id) { sql += " AND parent_task_id = ?"; params.push(filters.parent_task_id); }
    if (filters?.tag) {
      const needle = filters.tag.replace(/^#/, "");
      sql += " AND (' ' || REPLACE(REPLACE(tags, ',', ' '), '#', '') || ' ') LIKE ?";
      params.push(`% ${needle} %`);
    }

    sql += " ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, due_date ASC";

    return this.db.prepare(sql).all(...params) as Task[];
  }

  getById(id: string): Task | undefined {
    return this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | Task
      | undefined;
  }

  update(
    id: string,
    changes: Partial<Pick<Task,
      "title" | "description" | "status" | "priority" | "context" | "due_date" |
      "target_date" | "estimated_minutes" | "progress" | "tags" |
      "project_id" | "parent_task_id" | "sort_order" | "recurrence"
    >>,
  ): Task | undefined {
    const existing = this.getById(id);
    if (!existing) return undefined;

    const now = isoNow();
    const updated = { ...existing, ...changes, updated_at: now };

    if (changes.status === "in_progress" && !existing.started_at) {
      updated.started_at = now;
    }
    if (changes.status === "done") {
      updated.completed_at = now;
      updated.progress = 100;
    }
    if (existing.status === "done" && changes.status && changes.status !== "done") {
      updated.completed_at = null;
    }

    this.db
      .prepare(
        `UPDATE tasks SET title=?, description=?, status=?, priority=?, context=?, due_date=?,
         started_at=?, completed_at=?, target_date=?, estimated_minutes=?, progress=?, tags=?,
         project_id=?, parent_task_id=?, sort_order=?, recurrence=?, updated_at=?
         WHERE id=?`,
      )
      .run(
        updated.title, updated.description, updated.status, updated.priority,
        updated.context, updated.due_date, updated.started_at, updated.completed_at,
        updated.target_date, updated.estimated_minutes, updated.progress, updated.tags,
        updated.project_id, updated.parent_task_id, updated.sort_order, updated.recurrence,
        updated.updated_at, id,
      );

    if (changes.tags !== undefined) this.syncTags(id, updated.tags);

    // Roll up progress to a parent when a subtask's status changed.
    if (changes.status !== undefined && existing.parent_task_id) {
      this.recomputeParentProgress(existing.parent_task_id);
    }

    // Completing a task may unblock tasks that depend on it.
    if (changes.status === "done") {
      this.recomputeDependents(id);
    }

    // Spawn the next instance of a recurring task on completion.
    if (changes.status === "done" && existing.recurrence) {
      this.generateNextInstance(existing);
    }

    const graph = this.getGraph();
    if (graph?.capabilities.cypher) {
      graph
        .run(
          `MATCH (t:Task {id: $id}) SET t.status = $status, t.priority = $priority, t.title = $title`,
          { id, status: updated.status, priority: updated.priority, title: updated.title },
        )
        .catch(() => {});
    }

    return updated;
  }

  softDelete(id: string): boolean {
    const existing = this.getById(id);
    if (!existing) return false;
    this.db
      .prepare("UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE id = ?")
      .run(isoNow(), isoNow(), id);
    return true;
  }

  /** Normalize a free-form tag string into distinct, '#'-stripped names. */
  private normalizeTagNames(input: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of input.split(/[\s,]+/)) {
      const name = raw.replace(/^#/, "").trim();
      if (name && !seen.has(name)) { seen.add(name); out.push(name); }
    }
    return out;
  }

  /**
   * Upsert tags into the `tags`/`task_tags` entity tables and refresh the
   * denormalized comma-separated `tasks.tags` cache the dashboard reads.
   */
  private syncTags(taskId: string, tagsInput: string): void {
    const names = this.normalizeTagNames(tagsInput);

    // Clear existing links for this task, then re-link.
    this.db.prepare("DELETE FROM task_tags WHERE task_id = ?").run(taskId);

    for (const name of names) {
      let row = this.db.prepare("SELECT id FROM tags WHERE name = ?").get(name) as
        | { id: string }
        | undefined;
      if (!row) {
        const id = newId();
        this.db.prepare("INSERT INTO tags (id, name, color) VALUES (?, ?, '')").run(id, name);
        row = { id };
      }
      this.db
        .prepare("INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)")
        .run(taskId, row.id);
    }

    // Refresh the cache column (comma-joined canonical names).
    this.db.prepare("UPDATE tasks SET tags = ? WHERE id = ?").run(names.join(","), taskId);
  }

  listTags(): Tag[] {
    return this.db.prepare("SELECT id, name, color FROM tags ORDER BY name ASC").all() as Tag[];
  }

  getTaskTags(taskId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT t.name AS name FROM task_tags tt
         JOIN tags t ON t.id = tt.tag_id
         WHERE tt.task_id = ? ORDER BY t.name ASC`,
      )
      .all(taskId) as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  // ── Projects ──────────────────────────────────────────────────────────────

  createProject(input: {
    name: string; color?: string; icon?: string; area?: string; sort_order?: number;
  }): TaskProject {
    const now = isoNow();
    const project: TaskProject = {
      id: newId(),
      name: input.name,
      color: input.color ?? "",
      icon: input.icon ?? "",
      area: input.area ?? "",
      status: "active",
      sort_order: input.sort_order ?? 0,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    this.db
      .prepare(
        `INSERT INTO task_projects (id, name, color, icon, area, status, sort_order, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        project.id, project.name, project.color, project.icon, project.area,
        project.status, project.sort_order, project.created_at, project.updated_at, project.deleted_at,
      );
    return project;
  }

  listProjects(opts?: { include_archived?: boolean }): TaskProject[] {
    let sql = "SELECT * FROM task_projects WHERE deleted_at IS NULL";
    if (!opts?.include_archived) sql += " AND status = 'active'";
    sql += " ORDER BY sort_order ASC, name ASC";
    return this.db.prepare(sql).all() as TaskProject[];
  }

  getProject(id: string): TaskProject | undefined {
    return this.db.prepare("SELECT * FROM task_projects WHERE id = ?").get(id) as
      | TaskProject
      | undefined;
  }

  updateProject(
    id: string,
    changes: Partial<Pick<TaskProject, "name" | "color" | "icon" | "area" | "sort_order" | "status">>,
  ): TaskProject | undefined {
    const existing = this.getProject(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...changes, updated_at: isoNow() };
    this.db
      .prepare(
        `UPDATE task_projects SET name=?, color=?, icon=?, area=?, status=?, sort_order=?, updated_at=? WHERE id=?`,
      )
      .run(
        updated.name, updated.color, updated.icon, updated.area,
        updated.status, updated.sort_order, updated.updated_at, id,
      );
    return updated;
  }

  archiveProject(id: string): boolean {
    const ok = this.updateProject(id, { status: "archived" });
    return ok !== undefined;
  }

  setProject(taskId: string, projectId: string | null): Task | undefined {
    return this.update(taskId, { project_id: projectId });
  }

  /** Assign sequential sort_order to the given task IDs, in order. */
  reorder(orderedIds: string[]): void {
    const now = isoNow();
    const stmt = this.db.prepare("UPDATE tasks SET sort_order = ?, updated_at = ? WHERE id = ?");
    orderedIds.forEach((id, index) => stmt.run(index, now, id));
  }

  // ── Subtasks + rollup ───────────────────────────────────────────────────

  addSubtask(
    parentId: string,
    input: { title: string; priority?: Task["priority"]; due_date?: string },
  ): Task {
    const subtask = this.create({
      title: input.title,
      priority: input.priority,
      due_date: input.due_date,
      parent_task_id: parentId,
    });
    this.recomputeParentProgress(parentId);
    return subtask;
  }

  listSubtasks(parentId: string): Task[] {
    return this.list({ parent_task_id: parentId });
  }

  /** Set parent progress to the % of its (non-deleted) subtasks that are done. */
  private recomputeParentProgress(parentId: string): void {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
         FROM tasks WHERE parent_task_id = ? AND deleted_at IS NULL`,
      )
      .get(parentId) as { total: number; done: number | null };

    if (!row || row.total === 0) return;
    const progress = Math.round(((row.done ?? 0) / row.total) * 100);
    this.db
      .prepare("UPDATE tasks SET progress = ?, updated_at = ? WHERE id = ?")
      .run(progress, isoNow(), parentId);
  }

  // ── Dependencies (SQLite is source of truth; Neo4j mirrors) ───────────────

  /** Raw list of task IDs that `taskId` depends on. */
  getDependencyIds(taskId: string): string[] {
    const rows = this.db
      .prepare("SELECT depends_on_id FROM task_dependencies WHERE task_id = ?")
      .all(taskId) as Array<{ depends_on_id: string }>;
    return rows.map((r) => r.depends_on_id);
  }

  /** Formatted dependency lines (kept for the existing MCP tool). */
  getDependencies(taskId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT d.depends_on_id AS id, t.title AS title, t.status AS status
         FROM task_dependencies d
         LEFT JOIN tasks t ON t.id = d.depends_on_id
         WHERE d.task_id = ?`,
      )
      .all(taskId) as Array<{ id: string; title: string | null; status: string | null }>;
    return rows.map((r) => `${r.id} — ${r.title ?? "(unknown)"} [${r.status ?? "?"}]`);
  }

  /**
   * DFS from `dependsOnId` following `depends_on` edges. If we can reach
   * `taskId`, adding `taskId -> dependsOnId` would close a cycle.
   */
  private wouldCreateCycle(taskId: string, dependsOnId: string): boolean {
    const stack = [dependsOnId];
    const seen = new Set<string>();
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === taskId) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      stack.push(...this.getDependencyIds(cur));
    }
    return false;
  }

  addDependency(taskId: string, dependsOnId: string): boolean {
    if (taskId === dependsOnId) {
      throw new Error("A task cannot depend on itself");
    }
    if (this.wouldCreateCycle(taskId, dependsOnId)) {
      throw new Error("Adding this dependency would create a cycle");
    }

    this.db
      .prepare(
        "INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_id, created_at) VALUES (?, ?, ?)",
      )
      .run(taskId, dependsOnId, isoNow());

    // Auto-block the dependent if this dependency is not yet done.
    const dependent = this.getById(taskId);
    const dependency = this.getById(dependsOnId);
    if (dependent?.status === "todo" && dependency && dependency.status !== "done") {
      this.update(taskId, { status: "blocked" });
    }

    const graph = this.getGraph();
    if (graph?.capabilities.cypher) {
      graph
        .run(
          `MATCH (a:Task {id: $taskId}), (b:Task {id: $dependsOnId})
           MERGE (a)-[:DEPENDS_ON]->(b)`,
          { taskId, dependsOnId },
        )
        .catch(() => {});
    }

    return true;
  }

  removeDependency(taskId: string, dependsOnId: string): boolean {
    const res = this.db
      .prepare("DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_id = ?")
      .run(taskId, dependsOnId);

    const graph = this.getGraph();
    if (graph?.capabilities.cypher) {
      graph
        .run(
          `MATCH (a:Task {id: $taskId})-[r:DEPENDS_ON]->(b:Task {id: $dependsOnId}) DELETE r`,
          { taskId, dependsOnId },
        )
        .catch(() => {});
    }

    return res.changes > 0;
  }

  // ── Auto-block / unblock ──────────────────────────────────────────────────

  areAllDependenciesDone(taskId: string): boolean {
    const depIds = this.getDependencyIds(taskId);
    if (depIds.length === 0) return true;
    for (const depId of depIds) {
      const dep = this.getById(depId);
      if (!dep || dep.status !== "done") return false;
    }
    return true;
  }

  listBlocked(): Array<{ task: Task; blockedBy: string[] }> {
    const blocked = this.list({ status: "blocked" });
    return blocked.map((task) => ({
      task,
      blockedBy: this.getDependencyIds(task.id).filter((depId) => {
        const dep = this.getById(depId);
        return !dep || dep.status !== "done";
      }),
    }));
  }

  /** When `taskId` reaches a terminal state, unblock dependents whose deps are all done. */
  private recomputeDependents(taskId: string): void {
    const dependents = this.db
      .prepare("SELECT task_id FROM task_dependencies WHERE depends_on_id = ?")
      .all(taskId) as Array<{ task_id: string }>;

    for (const { task_id } of dependents) {
      const t = this.getById(task_id);
      if (!t || t.deleted_at) continue;
      if (t.status === "blocked" && this.areAllDependenciesDone(task_id)) {
        this.update(task_id, { status: "todo" });
      }
    }
  }

  // ── Recurrence (minimal RRULE) ────────────────────────────────────────────

  private static readonly DOW: Record<string, number> = {
    SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
  };

  private parseRRule(rrule: string): { freq: string; interval: number; byday: number[] } | null {
    if (!rrule || !rrule.includes("=")) return null;
    const parts: Record<string, string> = {};
    for (const seg of rrule.split(";")) {
      const [k, v] = seg.split("=");
      if (k && v) parts[k.trim().toUpperCase()] = v.trim().toUpperCase();
    }
    const freq = parts.FREQ ?? "";
    if (!["DAILY", "WEEKLY", "MONTHLY"].includes(freq)) return null;
    const interval = Math.max(1, parseInt(parts.INTERVAL ?? "1", 10) || 1);
    const byday = (parts.BYDAY ? parts.BYDAY.split(",") : [])
      .map((d) => TaskService.DOW[d.trim()])
      .filter((n): n is number => n !== undefined);
    return { freq, interval, byday };
  }

  /** Next due date as YYYY-MM-DD, or null if the rule can't be parsed. */
  previewNextDue(fromDate: string, rrule: string): string | null {
    const rule = this.parseRRule(rrule);
    if (!rule) return null;
    const iso = `${fromDate.slice(0, 10)}T00:00:00Z`;
    const base = new Date(iso);
    if (isNaN(base.getTime())) return null;

    const next = new Date(base);
    if (rule.freq === "DAILY") {
      next.setUTCDate(next.getUTCDate() + rule.interval);
    } else if (rule.freq === "WEEKLY") {
      if (rule.byday.length) {
        for (let add = 1; add <= 7; add++) {
          const cand = new Date(base);
          cand.setUTCDate(base.getUTCDate() + add);
          if (rule.byday.includes(cand.getUTCDay())) { next.setTime(cand.getTime()); break; }
        }
      } else {
        next.setUTCDate(next.getUTCDate() + 7 * rule.interval);
      }
    } else {
      next.setUTCMonth(next.getUTCMonth() + rule.interval);
    }
    return next.toISOString().slice(0, 10);
  }

  /** Spawn the next instance of a recurring task. Returns the new task or null. */
  private generateNextInstance(completed: Task): Task | null {
    if (!completed.recurrence) return null;
    const from = completed.due_date ?? isoNow().slice(0, 10);
    const nextDue = this.previewNextDue(from, completed.recurrence);
    if (!nextDue) return null;

    const next = this.create({
      title: completed.title,
      description: completed.description,
      priority: completed.priority,
      context: completed.context,
      due_date: nextDue,
      target_date: completed.target_date ?? undefined,
      estimated_minutes: completed.estimated_minutes,
      tags: completed.tags || undefined,
      project_id: completed.project_id ?? undefined,
      recurrence: completed.recurrence,
    });
    this.db
      .prepare("UPDATE tasks SET recurrence_parent_id = ? WHERE id = ?")
      .run(completed.recurrence_parent_id ?? completed.id, next.id);
    return { ...next, recurrence_parent_id: completed.recurrence_parent_id ?? completed.id };
  }
}
