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

/** The address inside "Name <addr>", lowercased. */
export function senderOf(from: string): string {
  const m = /<([^>]+)>/.exec(from);
  return (m ? m[1] : from).trim().toLowerCase();
}

const STOP = new Set(["el", "la", "los", "las", "de", "del", "por", "para", "con", "en", "y", "a", "al", "un", "una", "the", "of", "for", "and", "to", "on", "de", "het", "een", "van", "voor"]);
// A trailing "s" off longer words: «feriados» and «feriado» are one word here.
const words = (t: string) => new Set(t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z0-9]+/)
  .filter((w) => w.length > 2 && !STOP.has(w)).map((w) => (w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w)));

/** Share of the words two titles have in common (Jaccard over the meaningful words). */
export function titleSimilarity(a: string, b: string): number {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / (A.size + B.size - both);
}

/** Senders of the links written before the column existed, from the Gmail mirror (absent without google-sync). */
export function backfillAgendaSenders(db: SqliteDb): void {
  try {
    db.prepare(
      `UPDATE mail_agenda_links SET sender = COALESCE((SELECT lower(g.from_email) FROM google_emails g WHERE g.gmail_id = mail_agenda_links.source_id), '')
       WHERE source_table = 'google_emails' AND sender = ''`,
    ).run();
  } catch { /* no Gmail mirror here */ }
}

/** Code-like tokens (a lot, an order, a flight): letters and digits together, three characters or more. */
const codes = (t: string) => new Set((t.toLowerCase().match(/[a-z0-9-]*\d[a-z0-9-]*/g) ?? []).filter((c) => c.length >= 3 && /[a-z]/.test(c)));

/** Both titles name a code and none is shared: two different things (two lots, two orders), however alike. */
export function conflictingCodes(a: string, b: string): boolean {
  const A = codes(a), B = codes(b);
  if (!A.size || !B.size) return false;
  for (const c of A) if (B.has(c)) return false;
  return true;
}

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

      // The same thing told again — reworded in a later mail, or in a sender's auto-reply thread: already there.
      if (this.findSame(src, item, target)) return "skipped";
      if (this.alreadyFromGoogle(item)) return "skipped";

      const localId = this.create(target, src, item);
      if (!localId) return "skipped";
      const now = isoNow();
      this.db.prepare(
        `INSERT INTO mail_agenda_links (id, source_table, source_id, thread_key, kind, fingerprint, local_table, local_id, start_at, created_at, updated_at, sender)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(newId(), src.source_table, src.source_id, src.thread_key, item.kind, fp, target, localId, item.start_at, now, now, senderOf(src.from));
      return "created";
    });
    return run();
  }

  /**
   * An item of the same kind already on the calendar for the same day — and the same minute when both carry a time —
   * that is plainly the same thing: from the same thread, from the same sender with a related title, or with nearly
   * the same title.
   * Two appointments of one sender at different hours stay two.
   */
  private findSame(src: AgendaSource, item: AgendaItem, target: Target): boolean {
    const day = item.start_at.slice(0, 10);
    const rows = this.db.prepare(
      "SELECT thread_key, sender, fingerprint, start_at FROM mail_agenda_links WHERE local_table = ? AND substr(start_at, 1, 10) = ?",
    ).all(target, day) as Array<{ thread_key: string; sender: string; fingerprint: string; start_at: string }>;
    const sender = senderOf(src.from);
    const title = fingerprint(item).split("|").slice(1).join("|");
    for (const r of rows) {
      const timed = r.start_at.length > 10 && !item.all_day;
      if (timed && r.start_at.slice(0, 16) !== item.start_at.slice(0, 16)) continue;
      const otherTitle = r.fingerprint.split("|").slice(1).join("|");
      if (conflictingCodes(item.title, otherTitle)) continue;
      const sim = titleSimilarity(title, otherTitle);
      // Same thread or same sender: only when the titles share something — a reworded mention or an auto-reply does,
      // two different stock lots of one sender do not. The thread is the stronger hint, so it needs less.
      if ((r.thread_key === src.thread_key && sim >= 0.1) || (sender && r.sender === sender && sim >= 0.2) || sim >= 0.5) return true;
    }
    return false;
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
