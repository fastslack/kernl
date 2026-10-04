/**
 * Hands a mail that needs attention to the office router (Tobias by default)
 * as a letter from the Email Triage agent. Going through postToColleague is
 * what makes InboxWaker wake the router and the 3D office draw the hand-off.
 */

import { type SqliteDb, isoNow, localDate, dayStart, log } from "@kernl/extension-sdk";
import type { AgendaWriteResult } from "./agenda-writer.js";

export interface AgentsLike {
  listAgents(f?: { active?: boolean }): Array<{ id: string; name: string; builtin_handler?: string | null }>;
  postToColleague(i: { from_agent_id: string; to_agent_id: string; subject: string; body: string }): { message: { id: string } | null; error?: string };
}

export interface MailForOffice {
  source_table: "google_emails" | "communications";
  source_id: string;
  /** Conversation key (the thread id the agenda writer dedups on). */
  thread_key: string;
  /** communications.thread_id of the mail, when known: what kernel_comms_thread takes. */
  comm_thread_id?: string;
  subject: string;
  from: string;
  /** When the mail was sent (as stored on the source row). */
  date?: string;
  /** The stored body, capped at 1 500 characters. Gmail letters carry it
   *  because there is no tool that reads a google_emails row back. */
  body_excerpt?: string;
  urgency: string;
  summary: string;
  draft_comm_id?: string;
  agenda: AgendaWriteResult;
}

/**
 * sent       — posted to the router now.
 * duplicate  — this mail already has a letter row (sent, queued or failed).
 * capped     — today's cap is reached; stored as 'queued' for a later day.
 * queued-retry — the post failed (router missing/inactive, agents module not
 *               up yet, postToColleague error); stored as 'queued' so the
 *               next drainQueued() retries it.
 */
export type LetterOutcome = "sent" | "duplicate" | "capped" | "queued-retry";

function setting(db: SqliteDb, key: string, fallback: string): string {
  try {
    const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value?.trim() || fallback;
  } catch {
    return fallback;
  }
}

function readPayload(raw: string): MailForOffice | null {
  try {
    const m = JSON.parse(raw) as Partial<MailForOffice> | null;
    if (!m || typeof m !== "object" || typeof m.source_id !== "string" || !m.source_id
      || (m.source_table !== "google_emails" && m.source_table !== "communications")) return null;
    return m as MailForOffice;
  } catch {
    return null;
  }
}

export class MailOfficeDispatch {
  constructor(private db: SqliteDb, private agents: () => AgentsLike | null) {}

  /** Name of the agent that receives the letters (configurable). */
  routerName(): string {
    return setting(this.db, "mail_office.router_agent", "Tobias");
  }

  private cap(): number {
    return Number(setting(this.db, "comms.agent_runs.daily_cap", "40")) || 40;
  }

  /** Letters actually posted since the kernel's local midnight. created_at
   *  is a UTC instant, so compare against the instant that day starts at. */
  private sentToday(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM mail_office_letters WHERE status = 'sent' AND created_at >= ?")
      .get(dayStart(localDate())) as { n: number }).n;
  }

  letterFor(mail: MailForOffice): LetterOutcome {
    const dup = this.db.prepare("SELECT 1 FROM mail_office_letters WHERE source_table = ? AND source_id = ?")
      .get(mail.source_table, mail.source_id);
    if (dup) return "duplicate";

    if (this.sentToday() >= this.cap()) {
      // Over the cap: the letter waits for a later tick (drainQueued).
      this.queue(mail);
      return "capped";
    }

    const messageId = this.post(mail);
    if (!messageId) {
      // Never lose the letter: the mail is already classified and will not
      // come back through triage, so the retry has to live here.
      this.queue(mail);
      return "queued-retry";
    }
    this.db.prepare(
      "INSERT INTO mail_office_letters (source_table, source_id, message_id, status, payload, created_at) VALUES (?, ?, ?, 'sent', '{}', ?)",
    ).run(mail.source_table, mail.source_id, messageId, isoNow());
    return "sent";
  }

  private queue(mail: MailForOffice): void {
    this.db.prepare(
      "INSERT INTO mail_office_letters (source_table, source_id, message_id, status, payload, created_at) VALUES (?, ?, '', 'queued', ?, ?)",
    ).run(mail.source_table, mail.source_id, JSON.stringify(mail), isoNow());
  }

  /**
   * Posts letters that were queued by the cap, oldest first, while today's
   * cap allows. A posted row flips to 'sent' with created_at = now, so it
   * counts against today. Stops at the first post that fails (no router);
   * those rows stay queued for the next tick. A row whose payload cannot be
   * read is marked 'failed' (out of the queue and the cap) and logged once.
   */
  drainQueued(): number {
    const room = this.cap() - this.sentToday();
    if (room <= 0) return 0;
    const rows = this.db.prepare(
      "SELECT source_table, source_id, payload FROM mail_office_letters WHERE status = 'queued' ORDER BY created_at, rowid LIMIT ?",
    ).all(room) as Array<{ source_table: string; source_id: string; payload: string }>;
    const flip = this.db.prepare(
      "UPDATE mail_office_letters SET status = 'sent', message_id = ?, payload = '{}', created_at = ? WHERE source_table = ? AND source_id = ?",
    );
    const fail = this.db.prepare(
      "UPDATE mail_office_letters SET status = 'failed' WHERE source_table = ? AND source_id = ?",
    );
    let sent = 0;
    for (const r of rows) {
      const mail = readPayload(r.payload);
      if (!mail) {
        log.warn(`MailOfficeDispatch: unreadable queued letter ${r.source_table}:${r.source_id}; marked failed`);
        fail.run(r.source_table, r.source_id);
        continue;
      }
      const messageId = this.post(mail);
      if (!messageId) break;
      flip.run(messageId, isoNow(), r.source_table, r.source_id);
      sent++;
    }
    return sent;
  }

  /** Post the letter from Email Triage to the router; the inbox message id, or null. */
  private post(mail: MailForOffice): string | null {
    const svc = this.agents();
    if (!svc) return null;
    const all = svc.listAgents({ active: true });
    const routerName = this.routerName();
    const router = all.find((a) => a.name === routerName);
    const sender = all.find((a) => a.builtin_handler === "email:triage");
    if (!router || !sender) return null;

    // A google_emails row has no reader tool: kernel_email_fetch goes through
    // the default comms account (wrong provider, or it re-ingests the mail
    // into communications and triage sees it twice). So the letter carries
    // the stored text itself.
    const gmail = mail.source_table === "google_emails";
    const read = !gmail
      ? `Read the original with kernel_comms_get(id="${mail.source_id}")` + (mail.comm_thread_id
        ? ` and the conversation with kernel_comms_thread(thread_id="${mail.comm_thread_id}").`
        : `; the thread_id it returns is what kernel_comms_thread(thread_id=…) takes.`)
      : `Gmail mail: the text is above; draft replies with kernel_comms_create (never send).`;
    const agendaLines = mail.agenda?.lines ?? [];
    const body = [
      `source: ${mail.source_table}:${mail.source_id}`,
      `thread: ${mail.thread_key || "(unknown)"}`,
      `from: ${mail.from}`,
      ...(gmail ? [`subject: ${mail.subject ?? ""}`, `date: ${mail.date || "(unknown)"}`] : []),
      `urgency: ${mail.urgency}`,
      `summary: ${mail.summary}`,
      mail.draft_comm_id ? `draft reply already created: ${mail.draft_comm_id} (refine it with kernel_comms_update, never send it)` : `no draft reply yet`,
      agendaLines.length ? `already on the calendar:\n- ${agendaLines.join("\n- ")}` : `nothing added to the calendar`,
      ...(gmail ? [`text:\n${(mail.body_excerpt ?? "").slice(0, 1500) || "(empty)"}`] : []),
      read,
    ].join("\n");

    const res = svc.postToColleague({ from_agent_id: sender.id, to_agent_id: router.id, subject: (mail.subject ?? "").slice(0, 200) || "(sin asunto)", body });
    if (!res.message) {
      log.warn(`MailOfficeDispatch: post failed for ${mail.source_id}: ${res.error ?? "unknown"}`);
      return null;
    }
    return res.message.id;
  }
}
