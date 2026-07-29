/**
 * Comms agent drivers — scheduled no-LLM agents owned by this extension.
 *
 * Moved here from the kernel's builtin-handlers.ts: the inbound mail team
 * (fetch → label → archive) plus the LLM email-triage pipeline. Each driver
 * closes over this module's own services; handler ids are stable so existing
 * `agents` rows keep resolving by `builtin_handler`.
 */

import type { AgentDriver } from "../../../../../src/core/types.js";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { EventBus } from "../../../../../src/core/event-bus.js";
import type { Notifier } from "../../../../../src/core/notify/notifier.js";
import { safeQueryOne } from "../../../../../src/core/db/query-helpers.js";
import { log } from "../../../../../src/core/logger.js";

import type { CommsService } from "./service.js";
import type { EmailTriageService } from "./email-triage-service.js";

export interface CommsDriverDeps {
  db: () => SqliteDb | null;
  service: () => CommsService | null;
  triage: () => EmailTriageService | null;
  events: () => EventBus | null;
  notifier: () => Notifier | null;
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
      cron: "*/3 * * * *",
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
          let provider = comms.getProvider(acc.id);
          if (!provider) {
            const reg = comms.registerAccountProvider(acc.id);
            if (!reg.ok) {
              lines.push(`${acc.email}: skipped — ${reg.reason ?? "no provider"}`);
              continue;
            }
            provider = comms.getProvider(acc.id);
          }
          if (!provider?.capabilities.searchInbox || !provider?.capabilities.fetchEmail) {
            lines.push(`${acc.email}: provider cannot fetch inbound`);
            continue;
          }

          try {
            // Pull the 20 most recent UIDs from the remote inbox.
            const msgs = await comms.searchInbox("", 20, acc.id);
            // fetchEmail() dedups by gmail_message_id internally — ask it to
            // ingest each UID; it returns the existing row if already imported.
            // We detect "new" by comparing counts against the boundary we
            // captured before the loop.
            const before = safeQueryOne<{ c: number }>(
              db,
              "SELECT COUNT(*) as c FROM communications WHERE account_id = ? AND direction = 'inbound'",
              acc.id,
            )?.c ?? 0;

            for (const m of msgs) {
              try {
                await comms.fetchEmail(m.gmail_id, acc.id);
              } catch (err) {
                log.warn(`comms:inbox-fetch — fetch failed ${acc.email}/${m.gmail_id}: ${err instanceof Error ? err.message : String(err)}`);
              }
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
          } catch (err) {
            lines.push(`${acc.email}: ERROR — ${err instanceof Error ? err.message : String(err)}`);
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
        if (!triageService) return "Email triage service not available.";

        // Two sources of unclassified mail:
        //  - Gmail rows in google_emails (synced via gsync:gmail).
        //  - IMAP rows in communications (synced via comms:inbox-fetch — any
        //    self-hosted accounts that don't go through the Google sync).
        // Both are mapped to the GoogleEmailRow shape so classifyBatch reuses
        // the same LLM prompt; apply* routes the result back to the correct
        // table.
        const gmailRows = triageService.getUnclassified(15);
        const commsRows = triageService.getUnclassifiedComms(15);

        if (gmailRows.length === 0 && commsRows.length === 0) {
          return "No new emails to classify (Gmail + IMAP).";
        }

        const allRows = [...gmailRows, ...commsRows];
        const results = await triageService.classifyBatch(allRows);
        if (results.length === 0) return "Classification failed — no results.";

        // Split results by source so we update the right table.
        const gmailIds = new Set(gmailRows.map((r) => r.gmail_id));
        const commsIds = new Set(commsRows.map((r) => r.gmail_id));
        const gmailResults = results.filter((r) => gmailIds.has(r.gmail_id));
        const commsResults = results.filter((r) => commsIds.has(r.gmail_id));

        triageService.applyClassification(gmailResults);
        triageService.applyClassificationComms(commsResults);

        // Auto-draft for every attention_needed across both sources.
        const needAttention = results.filter((r) => r.attention_needed);
        let draftsCreated = 0;
        let draftErrors = 0;

        for (const r of needAttention) {
          const fromGmail = gmailRows.find((e) => e.gmail_id === r.gmail_id);
          const fromComms = commsRows.find((e) => e.gmail_id === r.gmail_id);
          const source = fromGmail ?? fromComms;
          if (!source) continue;

          try {
            if (fromGmail) await triageService.generateDraft(fromGmail);
            else if (fromComms) await triageService.generateDraftForComm(fromComms);
            draftsCreated++;
          } catch (err) {
            draftErrors++;
            log.warn(`EmailTriage: draft failed for ${r.gmail_id}`, err);
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

        return `Classified ${results.length} (${gmailResults.length} Gmail, ${commsResults.length} IMAP): ${critical.length} critical, ${high.length} high, ${needAttention.length} need attention. ${draftsCreated} drafts${draftErrors > 0 ? ` (${draftErrors} errors)` : ""}.`;
      },
    },
  ];
}
