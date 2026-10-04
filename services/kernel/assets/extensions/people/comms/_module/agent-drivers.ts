/**
 * Comms agent drivers — scheduled no-LLM agents owned by this extension.
 *
 * Moved here from the kernel's builtin-handlers.ts: the inbound mail team
 * (fetch → label → archive) plus the LLM email-triage pipeline. Each driver
 * closes over this module's own services; handler ids are stable so existing
 * `agents` rows keep resolving by `builtin_handler`.
 */

import {
  type AgentDriver,
  type SqliteDb,
  type EventBus,
  type Notifier,
  safeQueryOne,
  localDate,
  isoNow,
  log,
} from "@kernl/extension-sdk";

import type { CommsService } from "./service.js";
import { FETCH_BATCH, FETCH_POLL_MINUTES, writeFetchStatus } from "./fetch-status.js";
import type { EmailTriageService } from "./email-triage-service.js";
import type { AgendaWriter, AgendaWriteResult } from "./agenda-writer.js";
import type { MailOfficeDispatch } from "./mail-office-dispatch.js";

const CAP_NOTIFIED_KEY = "comms.agent_runs.cap_notified";
const EMPTY_AGENDA: AgendaWriteResult = { created: 0, updated: 0, skipped: 0, lines: [] };

export interface CommsDriverDeps {
  db: () => SqliteDb | null;
  service: () => CommsService | null;
  triage: () => EmailTriageService | null;
  events: () => EventBus | null;
  notifier: () => Notifier | null;
  /** Writes the dated items a mail mentions to events/tasks/reminders. */
  agenda: () => AgendaWriter | null;
  /** Hands attention-needed mail to the office router as an inbox letter. */
  office: () => MailOfficeDispatch | null;
}

export function commsAgentDrivers(deps: CommsDriverDeps): AgentDriver[] {
  return [
    // ── IMAP Fetcher ─────────────────────────────────────────────
    // Polls every IMAP/Gmail account, ingests new inbound emails into
    // `communications`, fires the 3D delivery truck when new mail arrives.
    {
      handler: "comms:inbox-fetch",
      name: "IMAP Fetcher",
      description: "Polls every IMAP/Gmail account, ingests new inbound emails into communications, fires the 3D delivery truck when new mail arrives.",
      cron: `*/${FETCH_POLL_MINUTES} * * * *`,
      flow: "Communications",
      run: async () => {
        const comms = deps.service();
        const db = deps.db();
        const events = deps.events();
        const notifier = deps.notifier();
        if (!comms || !db) return "Comms service not available.";

        const accounts = comms.listAccounts();
        const fetchable = accounts.filter((a) => a.provider === "imap_smtp" || a.provider === "gmail");
        if (fetchable.length === 0) return "No IMAP/Gmail accounts configured — nothing to fetch.";

        const lines: string[] = [];
        let totalNew = 0;
        const perAccount: Array<{ account_id: string; email: string; new: number; source: string }> = [];

        for (const acc of fetchable) {
          const startedAt = isoNow();
          const fail = (error: string) =>
            writeFetchStatus(db, acc.id, { state: "error", started_at: startedAt, finished_at: isoNow(), error });
          writeFetchStatus(db, acc.id, {
            state: "fetching", started_at: startedAt,
            finished_at: undefined, on_wire: undefined, done: 0, added: undefined, error: undefined,
          });

          let provider = comms.getProvider(acc.id);
          if (!provider) {
            const reg = comms.registerAccountProvider(acc.id);
            if (!reg.ok) {
              lines.push(`${acc.email}: skipped — ${reg.reason ?? "no provider"}`);
              fail(reg.reason ?? "no provider");
              continue;
            }
            provider = comms.getProvider(acc.id);
          }
          if (!provider?.capabilities.searchInbox || !provider?.capabilities.fetchEmail) {
            lines.push(`${acc.email}: provider cannot fetch inbound`);
            fail("provider cannot fetch inbound");
            continue;
          }

          try {
            // Pull the FETCH_BATCH most recent UIDs from the remote inbox.
            const msgs = await comms.searchInbox("", FETCH_BATCH, acc.id);
            writeFetchStatus(db, acc.id, { on_wire: msgs.length });
            // fetchEmail() dedups by gmail_message_id internally — ask it to
            // ingest each UID; it returns the existing row if already imported.
            // We detect "new" by comparing counts against the boundary we
            // captured before the loop.
            const before = safeQueryOne<{ c: number }>(
              db,
              "SELECT COUNT(*) as c FROM communications WHERE account_id = ? AND direction = 'inbound'",
              acc.id,
            )?.c ?? 0;

            let done = 0;
            for (const m of msgs) {
              try {
                await comms.fetchEmail(m.gmail_id, acc.id);
              } catch (err) {
                log.warn(`comms:inbox-fetch — fetch failed ${acc.email}/${m.gmail_id}: ${err instanceof Error ? err.message : String(err)}`);
              }
              writeFetchStatus(db, acc.id, { done: ++done });
            }

            const after = safeQueryOne<{ c: number }>(
              db,
              "SELECT COUNT(*) as c FROM communications WHERE account_id = ? AND direction = 'inbound'",
              acc.id,
            )?.c ?? 0;

            const delta = Math.max(0, after - before);
            totalNew += delta;
            if (delta > 0) perAccount.push({ account_id: acc.id, email: acc.email, new: delta, source: `imap:${acc.provider}` });
            lines.push(`${acc.email}: +${delta} new (${msgs.length} on wire)`);
            const finishedAt = isoNow();
            writeFetchStatus(db, acc.id, { state: "ok", finished_at: finishedAt, last_success_at: finishedAt, added: delta });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            lines.push(`${acc.email}: ERROR — ${msg}`);
            fail(msg);
          }
        }

        // One aggregate event per tick, so the dashboard fires a single truck
        // per polling run regardless of how many accounts were drained.
        if (totalNew > 0 && events) {
          events.emit("comms:mail:received", {
            count: totalNew,
            source: "imap",
            accounts: perAccount,
            ts: new Date().toISOString(),
          });
        }

        if (totalNew > 0 && notifier) {
          await notifier
            .send({
              title: "New emails",
              body: `${totalNew} new email(s) in the inbox\n${perAccount.map((a) => `• ${a.email}: +${a.new}`).join("\n")}`,
            })
            .catch(() => {});
        }

        return `Inbox fetch — ${totalNew} new from ${fetchable.length} account(s)\n${lines.join("\n")}`;
      },
    },

    // ── Auto Labeller ────────────────────────────────────────────
    // Lightweight SQL-only labeller: tag recent unclassified inbound rows by
    // simple heuristics on subject/sender. Leaves the heavy LLM triage to the
    // email:triage driver — this one just does cheap first-pass bucketing.
    {
      handler: "comms:auto-label",
      name: "Auto Labeller",
      description: "SQL-only first-pass labeller: tags recent inbound emails as newsletter/billing/security/transactional/personal/other in metadata.auto_label.",
      cron: "*/10 * * * *",
      flow: "Communications",
      run: async () => {
        const db = deps.db();
        if (!db) return "Comms db not available.";

        const PATTERNS: Array<{ label: string; match: RegExp }> = [
          { label: "newsletter",  match: /\b(newsletter|digest|unsubscribe|weekly|monthly|noreply|no-reply)\b/i },
          { label: "billing",     match: /\b(invoice|receipt|payment|billing|factura|recibo|pago|subscription|suscripci[oó]n)\b/i },
          { label: "security",    match: /\b(verify|2fa|password|reset|login|account locked|suspicious|security alert)\b/i },
          { label: "transactional", match: /\b(order|shipment|shipped|delivery|confirmation|pedido|env[ií]o|confirmaci[oó]n)\b/i },
          { label: "personal",    match: /\b(hola|hi|hey|hello|saludos|cheers)\b/i },
        ];

        const rows = db.prepare(
          `SELECT id, subject, metadata,
                  json_extract(metadata, '$.from') as meta_from
           FROM communications
           WHERE direction = 'inbound'
             AND channel = 'email'
             AND (
               json_extract(metadata, '$.auto_label') IS NULL
               OR json_extract(metadata, '$.auto_label') = ''
             )
           ORDER BY created_at DESC
           LIMIT 200`,
        ).all() as Array<{ id: string; subject: string; metadata: string; meta_from: string }>;

        if (rows.length === 0) return "No inbound emails needing auto-label.";

        const counts: Record<string, number> = {};
        const upd = db.prepare(
          "UPDATE communications SET metadata = json_set(metadata, '$.auto_label', ?), updated_at = datetime('now') WHERE id = ?",
        );

        for (const r of rows) {
          const haystack = `${r.subject} ${r.meta_from ?? ""}`;
          let label = "other";
          for (const p of PATTERNS) {
            if (p.match.test(haystack)) { label = p.label; break; }
          }
          upd.run(label, r.id);
          counts[label] = (counts[label] ?? 0) + 1;
        }

        const summary = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(", ");
        return `Auto-labelled ${rows.length} email(s): ${summary}`;
      },
    },

    // ── Archiver ─────────────────────────────────────────────────
    {
      handler: "comms:archive-old",
      name: "Archiver",
      description: "Archives inbound emails older than 30 days (status=archived).",
      cron: "0 3 * * *",
      flow: "Communications",
      run: async () => {
        const db = deps.db();
        if (!db) return "Comms db not available.";
        const result = db
          .prepare(
            `UPDATE communications
             SET status = 'archived', updated_at = datetime('now')
             WHERE direction = 'inbound'
               AND channel = 'email'
               AND status NOT IN ('archived')
               AND datetime(sent_at) < datetime('now', '-30 days')`,
          )
          .run();
        return `Archived ${result.changes} inbound email(s) older than 30 days.`;
      },
    },

    // ── Email Triage (LLM classification + draft generation) ─────
    {
      handler: "email:triage",
      name: "Email Triage",
      description: "Classifies inbox emails by urgency, generates draft replies for attention-needed emails",
      cron: "*/3 * * * *",
      flow: "Communications",
      run: async () => {
        const triageService = deps.triage();
        const notifier = deps.notifier();

        // Letters held back by yesterday's cap go out first, before any new
        // mail competes for today's quota — even on a tick with nothing new.
        const office = deps.office();
        let drained = 0;
        try {
          drained = office?.drainQueued() ?? 0;
        } catch (err) {
          log.warn(`EmailTriage: draining queued office letters failed: ${String(err)}`);
        }
        const drainedNote = drained > 0 ? ` ${drained} carta(s) en cola enviadas a ${office?.routerName() ?? "la oficina"}.` : "";

        if (!triageService) return `Email triage service not available.${drainedNote}`;

        // Two sources of unclassified mail:
        //  - Gmail rows in google_emails (synced via gsync:gmail).
        //  - IMAP rows in communications (synced via comms:inbox-fetch — any
        //    self-hosted accounts that don't go through the Google sync).
        // Both are mapped to the GoogleEmailRow shape so classifyBatch reuses
        // the same LLM prompt; apply* routes the result back to the correct
        // table.
        // 8 + 8 per tick: every mail now carries up to 1 500 chars of body.
        const gmailRows = triageService.getUnclassified(8);
        const commsRows = triageService.getUnclassifiedComms(8);

        if (gmailRows.length === 0 && commsRows.length === 0) {
          return `No new emails to classify (Gmail + IMAP).${drainedNote}`;
        }

        const allRows = [...gmailRows, ...commsRows];
        // A model that repeats an idx would otherwise get the mail two agenda
        // writes, two drafts and two letters: first result per mail wins.
        const seen = new Set<string>();
        const results = (await triageService.classifyBatch(allRows)).filter((r) => {
          if (seen.has(r.gmail_id)) return false;
          seen.add(r.gmail_id);
          return true;
        });
        if (results.length === 0) return `Classification failed — no results.${drainedNote}`;

        // Split results by source so we update the right table.
        const gmailIds = new Set(gmailRows.map((r) => r.gmail_id));
        const commsIds = new Set(commsRows.map((r) => r.gmail_id));
        const gmailResults = results.filter((r) => gmailIds.has(r.gmail_id));
        const commsResults = results.filter((r) => commsIds.has(r.gmail_id));

        triageService.applyClassification(gmailResults);
        triageService.applyClassificationComms(commsResults);

        // Dated items (meetings, deliverables, expiries) go straight to the
        // calendar, whether or not the mail needs a reply.
        const agenda = deps.agenda();
        const agendaBySource = new Map<string, AgendaWriteResult>();
        let agendaCreated = 0;
        for (const r of results) {
          const row = allRows.find((e) => e.gmail_id === r.gmail_id);
          if (!row || !agenda || r.agenda_items.length === 0) continue;
          try {
            const written = agenda.write({
              source_table: gmailIds.has(r.gmail_id) ? "google_emails" : "communications",
              source_id: r.gmail_id,
              thread_key: row.thread_key,
              subject: row.subject,
              from: row.from_email,
            }, r.agenda_items);
            agendaBySource.set(r.gmail_id, written);
            agendaCreated += written.created;
          } catch (err) {
            log.warn(`EmailTriage: agenda write failed for ${r.gmail_id}: ${String(err)}`);
          }
        }

        // Auto-draft for every attention_needed across both sources, then
        // hand the mail to the office router as a letter from this agent.
        const needAttention = results.filter((r) => r.attention_needed);
        let draftsCreated = 0;
        let draftErrors = 0;
        let lettersSent = 0;
        let capped = 0;
        let retrying = 0;

        for (const r of needAttention) {
          const fromGmail = gmailRows.find((e) => e.gmail_id === r.gmail_id);
          const fromComms = commsRows.find((e) => e.gmail_id === r.gmail_id);
          const source = fromGmail ?? fromComms;
          if (!source) continue;

          let draftId: string | undefined;
          try {
            if (fromGmail) draftId = await triageService.generateDraft(fromGmail);
            else if (fromComms) draftId = await triageService.generateDraftForComm(fromComms);
            draftsCreated++;
          } catch (err) {
            draftErrors++;
            log.warn(`EmailTriage: draft failed for ${r.gmail_id}`, err);
          }

          if (!office) continue;
          try {
            const outcome = office.letterFor({
              source_table: fromGmail ? "google_emails" : "communications",
              source_id: r.gmail_id,
              thread_key: source.thread_key,
              comm_thread_id: source.comm_thread_id,
              subject: source.subject,
              from: source.from_email,
              date: source.date,
              // Gmail rows have no reader tool, so the letter carries the text.
              body_excerpt: fromGmail ? source.body_excerpt : undefined,
              urgency: r.urgency,
              summary: r.summary,
              draft_comm_id: draftId || undefined,
              agenda: agendaBySource.get(r.gmail_id) ?? EMPTY_AGENDA,
            });
            if (outcome === "sent") lettersSent++;
            if (outcome === "capped") capped++;
            if (outcome === "queued-retry") retrying++;
          } catch (err) {
            log.warn(`EmailTriage: office letter failed for ${r.gmail_id}: ${String(err)}`);
          }
        }

        // Tell the user once a day that mail is waiting behind the cap.
        const db = deps.db();
        if (capped > 0 && notifier && db) {
          const today = localDate();
          const marked = safeQueryOne<{ value: string }>(db, "SELECT value FROM app_settings WHERE key = ?", CAP_NOTIFIED_KEY)?.value;
          if (marked !== today) {
            try {
              db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)").run(CAP_NOTIFIED_KEY, today);
            } catch (err) {
              log.warn(`EmailTriage: cap marker write failed: ${String(err)}`);
            }
            await notifier.send({
              title: "Tope diario de la oficina de correo",
              body: `Se alcanzó el tope diario de cartas a ${office?.routerName() ?? "la oficina"} (comms.agent_runs.daily_cap). ${capped} carta(s) quedaron en cola y salen mañana; los correos ya están clasificados y con borrador en /mail.`,
              priority: "normal",
            }).catch(() => {});
          }
        }

        // Notify on critical/high urgency
        const critical = results.filter((r) => r.urgency === "critical");
        const high = results.filter((r) => r.urgency === "high" && r.attention_needed);

        if ((critical.length > 0 || high.length > 0) && notifier) {
          const lines: string[] = [];
          for (const r of critical) {
            const email = allRows.find((e) => e.gmail_id === r.gmail_id);
            lines.push(`:red_circle: **${email?.subject ?? "?"}** — ${r.summary}`);
          }
          for (const r of high) {
            const email = allRows.find((e) => e.gmail_id === r.gmail_id);
            lines.push(`:orange_circle: **${email?.subject ?? "?"}** — ${r.summary}`);
          }
          await notifier.send({
            title: `Email Triage: ${critical.length} critical, ${high.length} high`,
            body: lines.join("\n"),
            priority: critical.length > 0 ? "high" : "normal",
          });
        }

        const router = office?.routerName() ?? "la oficina";
        return `Classified ${results.length} (${gmailResults.length} Gmail, ${commsResults.length} IMAP): ${critical.length} critical, ${high.length} high, ${needAttention.length} need attention. ${draftsCreated} drafts${draftErrors > 0 ? ` (${draftErrors} errors)` : ""}. ${agendaCreated} al calendario, ${lettersSent} a ${router}${capped ? `, ${capped} en cola por tope` : ""}${retrying ? `, ${retrying} en cola hasta que ${router} esté disponible` : ""}.${drainedNote}`;
      },
    },
  ];
}
