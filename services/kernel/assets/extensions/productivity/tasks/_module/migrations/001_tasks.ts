import type { Migration } from "../../../../../../src/core/db/migrations.js";

export const tasksMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS tasks (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'todo'
                    CHECK(status IN ('todo','in_progress','done','blocked')),
        priority    TEXT NOT NULL DEFAULT 'medium'
                    CHECK(priority IN ('low','medium','high','urgent')),
        context     TEXT NOT NULL DEFAULT '',
        due_date    TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
      CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE tasks ADD COLUMN started_at TEXT;
      ALTER TABLE tasks ADD COLUMN completed_at TEXT;
      ALTER TABLE tasks ADD COLUMN target_date TEXT;
      ALTER TABLE tasks ADD COLUMN estimated_minutes INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tasks ADD COLUMN progress INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tasks ADD COLUMN tags TEXT NOT NULL DEFAULT '';

      UPDATE tasks SET started_at = created_at WHERE status = 'in_progress';
      UPDATE tasks SET completed_at = updated_at, progress = 100 WHERE status = 'done';
    `,
  },
  {
    version: 3,
    sql: `
      ALTER TABLE tasks ADD COLUMN project_id TEXT;
      ALTER TABLE tasks ADD COLUMN parent_task_id TEXT;
      ALTER TABLE tasks ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tasks ADD COLUMN recurrence TEXT NOT NULL DEFAULT '';
      ALTER TABLE tasks ADD COLUMN recurrence_parent_id TEXT;
      ALTER TABLE tasks ADD COLUMN reminder_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE tasks ADD COLUMN deleted_at TEXT;

      CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_deleted ON tasks(deleted_at);

      CREATE TABLE IF NOT EXISTS task_projects (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        color       TEXT NOT NULL DEFAULT '',
        icon        TEXT NOT NULL DEFAULT '',
        area        TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'active'
                    CHECK(status IN ('active','archived')),
        sort_order  INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        deleted_at  TEXT
      );

      CREATE TABLE IF NOT EXISTS task_dependencies (
        task_id       TEXT NOT NULL,
        depends_on_id TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        UNIQUE(task_id, depends_on_id)
      );
      CREATE INDEX IF NOT EXISTS idx_task_deps_task ON task_dependencies(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_deps_dep ON task_dependencies(depends_on_id);

      CREATE TABLE IF NOT EXISTS task_checklist_items (
        id          TEXT PRIMARY KEY,
        task_id     TEXT NOT NULL,
        text        TEXT NOT NULL,
        done        INTEGER NOT NULL DEFAULT 0,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_checklist_task ON task_checklist_items(task_id);

      CREATE TABLE IF NOT EXISTS tags (
        id    TEXT PRIMARY KEY,
        name  TEXT NOT NULL UNIQUE,
        color TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS task_tags (
        task_id TEXT NOT NULL,
        tag_id  TEXT NOT NULL,
        UNIQUE(task_id, tag_id)
      );
      CREATE INDEX IF NOT EXISTS idx_task_tags_task ON task_tags(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_tags_tag ON task_tags(tag_id);
    `,
  },
];
