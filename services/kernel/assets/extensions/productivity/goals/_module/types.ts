export type GoalType = "goal" | "objective";
export type GoalStatus = "active" | "completed" | "abandoned";

export interface Goal {
  id: string;
  title: string;
  description: string;
  type: GoalType;
  status: GoalStatus;
  parent_id: string | null;
  target_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface KeyResult {
  id: string;
  goal_id: string;
  title: string;
  target_value: number;
  current_value: number;
  unit: string;
  task_id: string | null;
  created_at: string;
  updated_at: string;
}
