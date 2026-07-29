export interface Task {
  id: string;
  title: string;
  description: string;
  status: "todo" | "in_progress" | "done" | "blocked";
  priority: "low" | "medium" | "high" | "urgent";
  context: string; // GTD context: @home, @work, @errands, etc.
  due_date: string | null;
  started_at: string | null;
  completed_at: string | null;
  target_date: string | null;
  estimated_minutes: number;
  progress: number;
  tags: string; // comma-separated cache; canonical source is tags/task_tags
  // ── v3 additions ──
  project_id: string | null;
  parent_task_id: string | null;
  sort_order: number;
  recurrence: string; // RRULE; "" = non-recurring
  recurrence_parent_id: string | null;
  reminder_id: string; // "" = none
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskProject {
  id: string;
  name: string;
  color: string;
  icon: string;
  area: string;
  status: "active" | "archived";
  sort_order: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface TaskDependencyRow {
  task_id: string;
  depends_on_id: string;
  created_at: string;
}

export interface TaskChecklistItem {
  id: string;
  task_id: string;
  text: string;
  done: number;
  sort_order: number;
  created_at: string;
}

export interface Tag {
  id: string;
  name: string;
  color: string;
}
