export interface TimeEntry {
  id: string;
  task_id: string | null;
  description: string;
  start_time: string;
  end_time: string | null;
  duration_minutes: number | null;
  tags: string; // comma-separated
  created_at: string;
}
