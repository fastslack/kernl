/**
 * Google-sync agent drivers — scheduled no-LLM agents owned by this extension.
 *
 * Moved here from the kernel's builtin-handlers.ts (gsync:contacts /
 * gsync:gmail / gsync:calendar / gsync:graph-enrich) together with their
 * helpers (Gmail error classification + the throttled escalation
 * auth-expired alert). Handler ids are stable — existing `agents` rows keep
 * resolving by `builtin_handler`.
 *
 * The gmail driver's optional post-sync analysis lives in the comms
 * extension (EmailAnalysisService); it's resolved lazily via ctx.getModule
 * so google-sync keeps working when comms isn't installed.
 */

import type { AgentDriver, KernelModule, ModuleContext } from "../../../../../src/core/types.js";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { Notifier } from "../../../../../src/core/notify/notifier.js";
import { safeQueryOne } from "../../../../../src/core/db/query-helpers.js";
import type { GoogleSyncService } from "./sync-service.js";

export interface GoogleSyncDriverDeps {
  service: () => GoogleSyncService | null;
  db: () => SqliteDb | null;
  notifier: () => Notifier | null;
  /** Module context captured at initialize() — used to lazily resolve the
   *  comms extension's email-analysis service for the post-sync pass. */
  ctx: () => ModuleContext | null;
}

// ── Gmail error classification ─────────────────────────────────────────
function classifyGmailErr(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes("quota") || m.includes("rate") || m.includes("429")) return "quota";
  if (m.includes("auth") || m.includes("401") || m.includes("unauthor") || m.includes("invalid_grant")) return "auth";
  if (m.includes("timeout") || m.includes("etimedout") || m.includes("econnreset")) return "network";
  if (m.includes("not found") || m.includes("404")) return "not-found";
  return "other";
}

// ── Escalation alert: Google auth expired ─────────────────────────────
// gsync handlers swallow their own errors as result strings, so the executor
// never sees them as failures. Detect the auth-expired signature inside the
// caught error and push a high-priority notification — the dashboard surfaces
// it under the escalation banner + the inline "Re-login Google" button in the
// agent detail panel (see AgentWorld3D.svelte:dependsOnGoogleAuth).
//
// Throttled per-handler (gsync:gmail runs every 2 min — without a cooldown
// we'd flood Telegram/Mattermost with the same alert until the user re-auths).
const GOOGLE_AUTH_EXPIRED_RE =
  /invalid_grant|Token refresh failed|Token has been expired or revoked|kernel_google_auth/i;
const AUTH_ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1h per handler
const lastAuthAlertAt = new Map<string, number>();

function isGoogleAuthExpired(input: unknown): boolean {
  const text = input instanceof Error ? input.message : String(input ?? "");
  return GOOGLE_AUTH_EXPIRED_RE.test(text);
}

async function maybeAlertGoogleAuthExpired(
  notifier: Notifier | null,
  handlerKey: string,
  agentLabel: string,
  err: unknown,
): Promise<void> {
  if (!notifier) return;
  if (!isGoogleAuthExpired(err)) return;
  const now = Date.now();
  const last = lastAuthAlertAt.get(handlerKey) ?? 0;
  if (now - last < AUTH_ALERT_COOLDOWN_MS) return;
  lastAuthAlertAt.set(handlerKey, now);
  try {
    await notifier.send({
      title: "⚠️ Google auth expired",
      body:
        `${agentLabel} cannot continue — the Google OAuth token expired or was revoked.\n\n` +
        `Open the dashboard → Agents Flow → ${agentLabel} and click "🔑 Re-login Google", ` +
        `or run \`kernel_google_auth\` to re-authenticate.`,
      priority: "high",
      source: "google-auth",
    });
  } catch {
    // Notifier failure must never break the handler — the result string still
    // carries the error for the dashboard's inline re-auth button.
  }
}

/** Structural view of the comms module (avoid a hard import — google-sync
 *  must not fail when comms isn't installed). */
interface CommsModuleLike extends KernelModule {
  getEmailAnalysisService?: () => {
    analyzeNewEmails: (maxEmails?: number) => Promise<{ analyzed: number; suggestions: number; errors: number }>;
  } | null;
}

function resolveEmailAnalysis(ctx: ModuleContext | null) {
  if (!ctx?.getModule) return null;
  const comms = (ctx.getModule("ext:comms") ?? ctx.getModule("comms")) as CommsModuleLike | null;
  return comms?.getEmailAnalysisService?.() ?? null;
}

export function googleSyncAgentDrivers(deps: GoogleSyncDriverDeps): AgentDriver[] {
  return [
    // ── Contacts sync ────────────────────────────────────────────
    {
      handler: "gsync:contacts",
      name: "Google Contacts Sync",
      description: "Syncs Google Contacts + Other Contacts → CRM + Neo4j",
      cron: "0 */6 * * *",
      flow: "Communications",
      run: async () => {
        const googleSync = deps.service();
        if (!googleSync) return "Google Sync service not available.";
        if (!googleSync.isAuthenticated()) return "Google not authenticated. Run kernel_google_auth first.";

        try {
          const r1 = await googleSync.syncContacts();
          const r2 = await googleSync.syncOtherContacts();
          return `Contacts sync: ${r1.imported} contacts imported (${r1.skipped} skipped), ${r2.imported} other contacts imported (${r2.skipped} skipped)`;
        } catch (err) {
          await maybeAlertGoogleAuthExpired(deps.notifier(), "gsync:contacts", "Google Contacts Sync", err);
          return `Contacts sync failed: ${err}`;
        }
      },
    },

    // ── Gmail full sync ──────────────────────────────────────────
    {
      handler: "gsync:gmail",
      name: "Google Gmail Sync",
      description: "Fetches full Gmail emails → SQLite google_emails + Neo4j Email. Reports elapsed time, mailbox totals, and categorized errors. Notifies on 0-import+errors.",
      cron: "*/2 * * * *",
      flow: "Communications",
      run: async () => {
        const googleSync = deps.service();
        const db = deps.db();
        const notifier = deps.notifier();
        if (!googleSync || !db) return "Gmail sync — skipped (service unavailable).";
        if (!googleSync.isAuthenticated()) {
          return "Gmail sync — skipped (Google not authenticated). Run `kernel_google_auth` first.";
        }

        const startedAt = Date.now();
        let result: { imported: number; skipped: number; errors: unknown[] } | null = null;
        try {
          result = await googleSync.syncGmailFull();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const kind = classifyGmailErr(msg);
          await maybeAlertGoogleAuthExpired(notifier, "gsync:gmail", "Google Gmail Sync", err);
          return `Gmail sync FAILED (${kind}) after ${((Date.now() - startedAt) / 1000).toFixed(1)}s: ${msg.slice(0, 240)}`;
        }
        const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(1);

        const imported = result?.imported ?? 0;
        const skipped = result?.skipped ?? 0;
        const errors = Array.isArray(result?.errors) ? result!.errors : [];
        const errCount = errors.length;
        const errSample = errCount > 0
          ? errors.slice(0, 2).map((e) => String(e instanceof Error ? e.message : e).slice(0, 120)).join(" | ")
          : "";

        // Totals snapshot from SQLite for ops visibility.
        let totalEmails = 0;
        let unread = 0;
        let last24 = 0;
        try {
          const r1 = safeQueryOne<{ c: number }>(db, "SELECT COUNT(*) AS c FROM google_emails");
          const r2 = safeQueryOne<{ c: number }>(db, "SELECT COUNT(*) AS c FROM google_emails WHERE unread = 1");
          const r3 = safeQueryOne<{ c: number }>(
            db,
            "SELECT COUNT(*) AS c FROM google_emails WHERE date_received >= datetime('now','-24 hours')",
          );
          totalEmails = r1?.c ?? 0;
          unread = r2?.c ?? 0;
          last24 = r3?.c ?? 0;
        } catch {
          // Table may not exist yet on first sync; tolerate.
        }

        const parts: string[] = [
          `Gmail sync OK in ${elapsedS}s — ${imported} imported, ${skipped} skipped${errCount ? `, ${errCount} errors` : ""}.`,
          `Mailbox: ${totalEmails} emails (${unread} unread, ${last24} in last 24h).`,
        ];
        if (errSample) parts.push(`Last error: ${errSample}`);

        // Post-sync analysis (optional; don't fail the whole run if it errors).
        // Owned by the comms extension — resolved lazily so google-sync stays
        // functional without it.
        const emailAnalysis = resolveEmailAnalysis(deps.ctx());
        if (emailAnalysis && imported > 0) {
          try {
            const analysis = await emailAnalysis.analyzeNewEmails(Math.min(30, imported));
            if (analysis?.suggestions > 0) {
              parts.push(`Analysis: ${analysis.suggestions} new suggestion(s) from ${analysis.analyzed} email(s).`);
            }
          } catch (err) {
            parts.push(`Analysis skipped: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // Escalate persistent failures — if the sync imports nothing but
        // reports errors, notify so a human can check auth/quota.
        if (imported === 0 && errCount > 0 && notifier) {
          try {
            await notifier.send({
              title: "Gmail sync: import=0 with errors",
              body: `${errCount} error(s). Last: ${errSample || "n/a"}. Check Google auth / quota.`,
            });
          } catch {
            // Notifier failure shouldn't break the handler.
          }
        }

        return parts.join(" ");
      },
    },

    // ── Calendar full sync ───────────────────────────────────────
    {
      handler: "gsync:calendar",
      name: "Google Calendar Sync",
      description: "Fetches Calendar events + attendees → SQLite + Neo4j",
      cron: "0 */4 * * *",
      flow: "Communications",
      run: async () => {
        const googleSync = deps.service();
        if (!googleSync) return "Google Sync service not available.";
        if (!googleSync.isAuthenticated()) return "Google not authenticated. Run kernel_google_auth first.";

        try {
          const result = await googleSync.syncCalendarFull();
          return `Calendar full sync: ${result.imported} events stored, ${result.skipped} skipped${result.errors.length > 0 ? ` (${result.errors.length} errors)` : ""}`;
        } catch (err) {
          await maybeAlertGoogleAuthExpired(deps.notifier(), "gsync:calendar", "Google Calendar Sync", err);
          return `Calendar sync failed: ${err}`;
        }
      },
    },

    // ── Graph enrichment ─────────────────────────────────────────
    {
      handler: "gsync:graph-enrich",
      name: "Google Graph Enrichment",
      description: "Builds SENT/RECEIVED/ATTENDS/EMAILED/MET_WITH rels in Neo4j",
      cron: "0 3 * * *",
      flow: "Communications",
      run: async () => {
        const googleSync = deps.service();
        if (!googleSync) return "Google Sync service not available.";

        try {
          const result = await googleSync.enrichGraph();
          return `Graph enrichment: ${result.emailNodes} emails, ${result.threadNodes} threads, ${result.calendarNodes} cal events | Rels: ${result.sentRels} SENT, ${result.receivedRels} RECEIVED, ${result.emailedRels} EMAILED, ${result.metWithRels} MET_WITH`;
        } catch (err) {
          await maybeAlertGoogleAuthExpired(deps.notifier(), "gsync:graph-enrich", "Google Graph Enrichment", err);
          return `Graph enrichment failed: ${err}`;
        }
      },
    },
  ];
}
