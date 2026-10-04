/**
 * Puts the dated things a mail mentions on the Kernl calendar, each in the
 * module that already draws it: meetings and events in `events`, things to
 * deliver as tasks with a due date, expiries as reminders. A later mail in
 * the same thread that mentions the same item moves it instead of adding a
 * second copy.
 */

import { type SqliteDb, newId, isoNow, log, localParts } from "@kernl/extension-sdk";
import type { AgendaItem } from "./agenda-extract.js";

export interface EventsLike {
  create(input: { title: string; start_at: string; end_at?: string; description?: string; type?: string; location?: string; notes?: string }): { id: string };
  update(id: string, patch: { start_at?: string; end_at?: string; status?: string; title?: string }): unknown;
}
export interface TasksLike {
  create(input: { title: string; description?: string; due_date?: string; tags?: string }): { id: string };
  update(id: string, patch: { due_date?: string; title?: string }): unknown;
}
export interface RemindersLike {
  create(input: { title: string; body?: string; trigger_at: string; repeat?: string }): { id: string };
  update(id: string, patch: { trigger_at?: string; title?: string }): unknown;
}

export interface AgendaSource {
  source_table: "google_emails" | "communications";
  source_id: string;
  thread_key: string;
  subject: string;
  from: string;
}

export interface AgendaWriteResult { created: number; updated: number; skipped: number; lines: string[] }

const PREFIX_RE = /^((re|fw|fwd|rv|reenv)\s*:\s*)+/i;

export function fingerprint(item: AgendaItem): string {
  const t = item.title.replace(PREFIX_RE, "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
  return `${item.kind}|${t}`;
}

type Target = "events" | "tasks" | "reminders";
const TARGET: Record<AgendaItem["kind"], Target> = { appointment: "events", event: "events", deadline: "tasks", expiry: "reminders" };
const LABEL: Record<Target, string> = { events: "evento", tasks: "entrega", reminders: "vencimiento" };

export class AgendaWriter {
  constructor(
    private db: SqliteDb,
    private deps: { events: EventsLike | null; tasks: TasksLike | null; reminders: RemindersLike | null },
  ) {}

  write(src: AgendaSource, items: AgendaItem[]): AgendaWriteResult {
    const res: AgendaWriteResult = { created: 0, updated: 0, skipped: 0, lines: [] };
    for (const item of items) {
      try {
        const outcome = this.writeOne(src, item);
        res[outcome]++;
        if (outcome !== "skipped") res.lines.push(`${LABEL[TARGET[item.kind]]} «${item.title}» ${item.start_at.replace("T", " ")}`);
      } catch (err) {
        res.skipped++;
        log.warn(`AgendaWriter: ${item.kind} "${item.title}" failed: ${String(err)}`);
      }
    }
    return res;
  }

  /**
   * Lookup, calendar-row create/move and the mail_agenda_links write all run
   * inside one db transaction: the events/tasks/reminders services write
   * through this same sqlite handle, so a throw anywhere in here (e.g. the
   * events.update(open) call) rolls back the calendar row too — never a
   * created event with no link to show for it. Each call to write() is its
   * own top-level transaction, so one item's rollback never touches another.
   */
  private writeOne(src: AgendaSource, item: AgendaItem): "created" | "updated" | "skipped" {
    const run = this.db.transaction((): "created" | "updated" | "skipped" => {
      const fp = fingerprint(item);
      const target = TARGET[item.kind];
      const existing = this.db
        .prepare("SELECT id, local_table, local_id FROM mail_agenda_links WHERE thread_key = ? AND fingerprint = ?")
        .get(src.thread_key, fp) as { id: string; local_table: Target; local_id: string } | undefined;

      if (existing) {
        this.move(existing.local_table, existing.local_id, item);
        this.db.prepare("UPDATE mail_agenda_links SET start_at = ?, source_id = ?, updated_at = ? WHERE id = ?")
          .run(item.start_at, src.source_id, isoNow(), existing.id);
        return "updated";
      }

      if (this.alreadyFromGoogle(item)) return "skipped";

      const localId = this.create(target, src, item);
      if (!localId) return "skipped";
      const now = isoNow();
      this.db.prepare(
        `INSERT INTO mail_agenda_links (id, source_table, source_id, thread_key, kind, fingerprint, local_table, local_id, start_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(newId(), src.source_table, src.source_id, src.thread_key, item.kind, fp, target, localId, item.start_at, now, now);
      return "created";
    });
    return run();
  }

  private create(target: Target, src: AgendaSource, item: AgendaItem): string | null {
    const origin = `De: ${src.from} — «${src.subject}»\n"${item.evidence}"`;
    if (target === "events") {
      if (!this.deps.events) return null;
      const ev = this.deps.events.create({
        title: item.title,
        start_at: item.start_at,
        end_at: item.end_at,
        type: "professional",
        location: item.location ?? "",
        description: origin,
        notes: `mail:${src.source_table}:${src.source_id}`,
      });
      if (item.confidence === "high") this.deps.events.update(ev.id, { status: "open" });
      return ev.id;
    }
    if (target === "tasks") {
      if (!this.deps.tasks) return null;
      return this.deps.tasks.create({ title: item.title, description: origin, due_date: item.start_at.slice(0, 10), tags: "mail" }).id;
    }
    if (!this.deps.reminders) return null;
    const at = item.all_day ? `${item.start_at.slice(0, 10)}T09:00` : item.start_at;
    return this.deps.reminders.create({ title: item.title, body: origin, trigger_at: at, repeat: "none" }).id;
  }

  private move(table: Target, id: string, item: AgendaItem): void {
    if (table === "events") this.deps.events?.update(id, { start_at: item.start_at, end_at: item.end_at });
    else if (table === "tasks") this.deps.tasks?.update(id, { due_date: item.start_at.slice(0, 10) });
    else this.deps.reminders?.update(id, { trigger_at: item.all_day ? `${item.start_at.slice(0, 10)}T09:00` : item.start_at });
  }

  /** Google Calendar events are imported as reminders; same local day+time+title means it's already there. */
  private alreadyFromGoogle(item: AgendaItem): boolean {
    try {
      const rows = this.db.prepare(
        `SELECT r.title, r.trigger_at FROM google_sync_map m JOIN reminders r ON r.id = m.local_id
         WHERE m.source = 'calendar' AND m.local_table = 'reminders'`,
      ).all() as Array<{ title: string; trigger_at: string }>;
      const want = fingerprint(item).split("|")[1];
      return rows.some((r) => {
        const p = localParts(r.trigger_at);
        const at = item.all_day ? p.date : `${p.date}T${p.time}`;
        return at === item.start_at && fingerprint({ ...item, title: r.title }).split("|")[1] === want;
      });
    } catch {
      return false; // google-sync not installed → no table
    }
  }
}
