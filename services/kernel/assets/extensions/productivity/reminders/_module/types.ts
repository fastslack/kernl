export type ReminderStatus = "active" | "snoozed" | "fired" | "dismissed";
export type RepeatInterval = "none" | "daily" | "weekly" | "monthly";

export interface Reminder {
  id: string;
  title: string;
  body: string;
  trigger_at: string;           // ISO 8601 UTC
  status: ReminderStatus;
  repeat: RepeatInterval;
  task_id: string | null;       // FK to tasks.id
  snoozed_until: string | null;
  last_fired_at: string | null;
  notify_mattermost: number;    // INTEGER 0/1 in SQLite
  notify_telegram: number;      // INTEGER 0/1 in SQLite
  created_at: string;
  updated_at: string;
}
