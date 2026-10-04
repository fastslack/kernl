import { type SqliteDb, type GraphDriver, newId, isoNow } from "@kernl/extension-sdk";
import type { Goal, KeyResult, GoalType, GoalStatus } from "./types.js";

export class GoalsService {
  constructor(
    private db: SqliteDb,
    private getGraph: () => GraphDriver | null,
  ) {}

  // ── Goals ────────────────────────────────────────

  createGoal(input: {
    title: string;
    description?: string;
    type?: GoalType;
    parent_id?: string;
    target_date?: string;
  }): Goal {
    const now = isoNow();
    const goal: Goal = {
      id: newId(),
      title: input.title,
      description: input.description ?? "",
      type: input.type ?? "goal",
      status: "active",
      parent_id: input.parent_id ?? null,
      target_date: input.target_date ?? null,
      created_at: now,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO goals (id, title, description, type, status, parent_id, target_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(goal.id, goal.title, goal.description, goal.type, goal.status, goal.parent_id, goal.target_date, goal.created_at, goal.updated_at);

    const graph = this.getGraph();
    if (graph?.capabilities.cypher) {
      graph
        .run(
          `MERGE (g:Goal {id: $id})
           SET g.title = $title, g.type = $type, g.status = $status`,
          { id: goal.id, title: goal.title, type: goal.type, status: goal.status },
        )
        .catch(() => {});
    }

    return goal;
  }

  getGoal(id: string): Goal | undefined {
    return this.db.prepare("SELECT * FROM goals WHERE id = ?").get(id) as Goal | undefined;
  }

  updateGoal(
    id: string,
    changes: Partial<Pick<Goal, "title" | "description" | "type" | "status" | "parent_id" | "target_date">>,
  ): Goal | undefined {
    const existing = this.getGoal(id);
    if (!existing) return undefined;

    const updated = { ...existing, ...changes, updated_at: isoNow() };

    this.db
      .prepare(
        `UPDATE goals SET title=?, description=?, type=?, status=?, parent_id=?, target_date=?, updated_at=?
         WHERE id=?`,
      )
      .run(updated.title, updated.description, updated.type, updated.status, updated.parent_id, updated.target_date, updated.updated_at, id);

    const graph = this.getGraph();
    if (graph?.capabilities.cypher) {
      graph
        .run(
          `MERGE (g:Goal {id: $id})
           SET g.title = $title, g.type = $type, g.status = $status`,
          { id, title: updated.title, type: updated.type, status: updated.status },
        )
        .catch(() => {});
    }

    return updated;
  }

  listGoals(filters?: { status?: GoalStatus; type?: GoalType; parent_id?: string }): Goal[] {
    let sql = "SELECT * FROM goals WHERE 1=1";
    const params: unknown[] = [];

    if (filters?.status) { sql += " AND status = ?"; params.push(filters.status); }
    if (filters?.type) { sql += " AND type = ?"; params.push(filters.type); }
    if (filters?.parent_id !== undefined) {
      if (filters.parent_id === "") {
        sql += " AND parent_id IS NULL";
      } else {
        sql += " AND parent_id = ?";
        params.push(filters.parent_id);
      }
    }

    sql += " ORDER BY created_at DESC";
    return this.db.prepare(sql).all(...params) as Goal[];
  }

  /** The dashboard's goal list: each goal with its key-result count and the
   *  average progress of those key results (each capped at 100%), active
   *  goals first, most recently updated first. */
  listWithProgress(status?: string): Array<Goal & { kr_count: number; progress: number }> {
    let where = "1=1";
    const params: unknown[] = [];
    if (status) { where += " AND g.status = ?"; params.push(status); }
    return this.db.prepare(
      `SELECT g.id, g.title, g.description, g.type, g.status, g.parent_id, g.target_date,
              g.created_at, g.updated_at,
              (SELECT COUNT(*) FROM key_results kr WHERE kr.goal_id = g.id) as kr_count,
              (SELECT CASE WHEN COUNT(*) = 0 THEN 0
                ELSE ROUND(AVG(CASE WHEN kr2.target_value > 0 THEN MIN(kr2.current_value / kr2.target_value * 100, 100) ELSE 0 END))
               END FROM key_results kr2 WHERE kr2.goal_id = g.id) as progress
       FROM goals g WHERE ${where}
       ORDER BY CASE g.status WHEN 'active' THEN 0 ELSE 1 END, g.updated_at DESC`,
    ).all(...params) as Array<Goal & { kr_count: number; progress: number }>;
  }

  // ── Key Results ────────────────────────────────────

  addKeyResult(input: {
    goal_id: string;
    title: string;
    target_value?: number;
    current_value?: number;
    unit?: string;
    task_id?: string;
  }): KeyResult {
    const goal = this.getGoal(input.goal_id);
    if (!goal) throw new Error(`Goal not found: ${input.goal_id}`);

    const now = isoNow();
    const kr: KeyResult = {
      id: newId(),
      goal_id: input.goal_id,
      title: input.title,
      target_value: input.target_value ?? 100,
      current_value: input.current_value ?? 0,
      unit: input.unit ?? "%",
      task_id: input.task_id ?? null,
      created_at: now,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO key_results (id, goal_id, title, target_value, current_value, unit, task_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(kr.id, kr.goal_id, kr.title, kr.target_value, kr.current_value, kr.unit, kr.task_id, kr.created_at, kr.updated_at);

    const graph = this.getGraph();
    if (graph?.capabilities.cypher && kr.task_id) {
      graph
        .run(
          `MATCH (g:Goal {id: $gid}), (t:Task {id: $tid})
           MERGE (g)-[:ACHIEVED_BY]->(t)`,
          { gid: kr.goal_id, tid: kr.task_id },
        )
        .catch(() => {});
    }

    return kr;
  }

  updateKeyResult(
    id: string,
    changes: Partial<Pick<KeyResult, "title" | "target_value" | "current_value" | "unit" | "task_id">>,
  ): KeyResult | undefined {
    const existing = this.db.prepare("SELECT * FROM key_results WHERE id = ?").get(id) as KeyResult | undefined;
    if (!existing) return undefined;

    const updated = { ...existing, ...changes, updated_at: isoNow() };

    this.db
      .prepare(
        `UPDATE key_results SET title=?, target_value=?, current_value=?, unit=?, task_id=?, updated_at=?
         WHERE id=?`,
      )
      .run(updated.title, updated.target_value, updated.current_value, updated.unit, updated.task_id, updated.updated_at, id);

    return updated;
  }

  getKeyResults(goalId: string): KeyResult[] {
    return this.db
      .prepare("SELECT * FROM key_results WHERE goal_id = ? ORDER BY created_at ASC")
      .all(goalId) as KeyResult[];
  }

  linkTask(goalId: string, taskId: string): void {
    const graph = this.getGraph();
    if (graph?.capabilities.cypher) {
      graph
        .run(
          `MATCH (g:Goal {id: $gid}), (t:Task {id: $tid})
           MERGE (g)-[:ACHIEVED_BY]->(t)`,
          { gid: goalId, tid: taskId },
        )
        .catch(() => {});
    }
  }

  progress(goalId: string): {
    goal: Goal;
    key_results: KeyResult[];
    overall_percentage: number;
  } | undefined {
    const goal = this.getGoal(goalId);
    if (!goal) return undefined;

    const krs = this.getKeyResults(goalId);
    if (krs.length === 0) return { goal, key_results: krs, overall_percentage: 0 };

    const percentages = krs.map((kr) =>
      kr.target_value > 0 ? Math.min(100, (kr.current_value / kr.target_value) * 100) : 0,
    );
    const overall = Math.round(percentages.reduce((a, b) => a + b, 0) / percentages.length);

    return { goal, key_results: krs, overall_percentage: overall };
  }
}
