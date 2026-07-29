/**
 * Minimal `ReminderService` contract — only the surface area that the
 * kernel framework (event-listeners, bootstrap wiring) actually relies on.
 *
 * The concrete implementation lives in `assets/extensions/productivity/reminders/_module/`.
 * Defining the interface here decouples `src/core/` from any particular
 * extension layout — the reminders extension can be replaced, swapped, or
 * removed without forcing edits in core.
 */
export type ReminderRepeat = "none" | "hourly" | "daily" | "weekly" | "monthly";

export interface ReminderRecord {
  id: string;
  title: string;
  body: string;
  trigger_at: string;
  status: string;
  repeat: ReminderRepeat | string;
  task_id: string | null;
  snoozed_until: string | null;
  last_fired_at: string | null;
  notify_mattermost: number;
  notify_telegram: number;
  created_at: string;
  updated_at: string;
}

export interface CreateReminderInput {
  title: string;
  body?: string;
  trigger_at: string;
  repeat?: ReminderRepeat | string;
  task_id?: string;
  notify_mattermost?: boolean;
  notify_telegram?: boolean;
}

/**
 * Kernel-facing contract. The concrete `ReminderService` exported by the
 * reminders extension satisfies this shape (it has many more methods, but
 * the kernel only needs `create`).
 */
export interface ReminderServiceLike {
  create(input: CreateReminderInput): ReminderRecord;
}
