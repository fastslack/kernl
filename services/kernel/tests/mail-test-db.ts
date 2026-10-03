/**
 * An in-memory comms database with email_accounts already widened to accept
 * 'imap_smtp' (production does that at module init, outside the migrations).
 */
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { crmMigrations } from "../assets/extensions/people/crm/_module/migrations/001_crm.js";
import { commsMigrations } from "../assets/extensions/people/comms/_module/migrations.js";
import { CommsService } from "../assets/extensions/people/comms/_module/service.js";
import { EventBus } from "../src/core/event-bus.js";

export function makeCommsDb(): { db: Database; service: CommsService } {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo', priority TEXT NOT NULL DEFAULT 'medium',
    context TEXT NOT NULL DEFAULT '', due_date TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  runMigrations(db as never, "crm", crmMigrations);
  runMigrations(db as never, "comms", commsMigrations);
  db.run("DROP TABLE email_accounts");
  db.run(`CREATE TABLE email_accounts (
    id TEXT PRIMARY KEY, label TEXT NOT NULL, email TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'personal' CHECK(type IN ('personal','work','transactional','marketing')),
    provider TEXT NOT NULL DEFAULT 'gmail' CHECK(provider IN ('gmail','resend','imap_smtp')),
    company TEXT NOT NULL DEFAULT '', signature TEXT NOT NULL DEFAULT '',
    provider_config TEXT NOT NULL DEFAULT '{}', is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_email_accounts_email ON email_accounts(email)");
  return { db, service: new CommsService(db as never, new EventBus()) };
}
