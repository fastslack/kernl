/**
 * EmailTriageService
 *
 * Classifies emails by urgency and attention_needed, then auto-generates
 * draft replies for emails requiring user response. Uses LLM for both
 * classification and draft generation.
 *
 * Flow:
 *   1. gsync:gmail syncs new emails → google_emails table
 *   2. email:triage handler calls classifyBatch() → urgency + attention_needed + ai_summary
 *   3. For attention_needed emails, generateDraft() creates a communications record
 *   4. User reviews/approves/edits drafts from /mail dashboard
 */

import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { KernelConfig } from "../../../../../src/core/config.js";
import { newId, isoNow } from "../../../../../src/core/helpers.js";
import { log } from "../../../../../src/core/logger.js";
import { stripReasoning } from "../../../../../src/core/llm/strip-reasoning.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type Urgency = "critical" | "high" | "normal" | "low";

export interface ClassificationResult {
  gmail_id: string;
  urgency: Urgency;
  attention_needed: boolean;
  summary: string;
}

export interface GoogleEmailRow {
  gmail_id: string;
  thread_id: string;
  from_email: string;
  from_name: string;
  to_emails: string;
  subject: string;
  snippet: string;
  body_text: string;
  date: string;
  labels: string;
}

export interface AttentionItem {
  gmail_id: string;
  thread_id: string;
  from_email: string;
  from_name: string;
  subject: string;
  snippet: string;
  date: string;
  urgency: Urgency;
  ai_summary: string;
  draft_comm_id: string;
  draft_body: string;
  draft_status: string;
}

// ── Service ──────────────────────────────────────────────────────────────────

export class EmailTriageService {
  constructor(
    private db: SqliteDb,
    private config: KernelConfig,
  ) {}

  /** LLM call via global singleton (routes through mtwRequest) */
  private async llmChat(system: string, user: string): Promise<string> {
    const { llm } = await import("../../../../../src/core/llm/client.js");
    const result = await llm().chat({ system, user, caller: "email-triage" });
    return result.text;
  }

  /** Get unclassified emails (attention_needed = -1), limited to inbox */
  getUnclassified(limit = 20): GoogleEmailRow[] {
    try {
      return this.db.prepare(`
        SELECT gmail_id, thread_id, from_email, from_name, to_emails,
               subject, snippet, body_text, date, labels
        FROM google_emails
        WHERE attention_needed = -1
          AND labels LIKE '%"INBOX"%'
          AND from_email NOT LIKE '%noreply%'
          AND from_email NOT LIKE '%no-reply%'
          AND from_email NOT LIKE '%notifications%'
          AND from_email NOT LIKE '%mailer-daemon%'
        ORDER BY date DESC
        LIMIT ?
      `).all(limit) as GoogleEmailRow[];
    } catch {
      return [];
    }
  }

  /** Classify a batch of emails using LLM */
  async classifyBatch(emails: GoogleEmailRow[]): Promise<ClassificationResult[]> {
    if (emails.length === 0) return [];

    // Build a compact representation for the LLM
    const emailSummaries = emails.map((e, i) => ({
      idx: i,
      gmail_id: e.gmail_id,
      from: e.from_name ? `${e.from_name} <${e.from_email}>` : e.from_email,
      subject: e.subject,
      snippet: e.snippet.slice(0, 200),
      date: e.date,
    }));

    const today = new Date().toISOString().slice(0, 10);

    const systemPrompt = `You are an email triage assistant. Classify each email by urgency and whether it needs the user's attention/response.
Today is ${today}.

Output ONLY valid JSON array. Each element:
{
  "idx": number,
  "urgency": "critical" | "high" | "normal" | "low",
  "attention_needed": boolean,
  "summary": "string — one sentence summary"
}

Classification rules:
- **critical**: Urgent deadlines (today/tomorrow), security alerts, payment failures, legal matters, health emergencies
- **high**: Action required within days, important business emails, meeting requests, invoices, personal messages needing response
- **normal**: Regular correspondence, newsletters with relevant content, social updates
- **low**: Marketing, promotions, automated notifications, social media digests, subscription receipts

attention_needed = true when:
- The email asks a direct question to the user
- The email requests an action, decision, or response
- The email contains a meeting/event invitation needing RSVP
- The email is from a known contact and expects a reply

attention_needed = false when:
- Newsletters, digests, marketing emails
- Automated notifications (order confirmations, shipping updates)
- No-reply or system-generated emails
- FYI emails that don't require action

Be conservative: only mark attention_needed=true when a response is clearly expected.
Respond ONLY with the JSON array.`;

    const userMessage = JSON.stringify(emailSummaries, null, 2);

    let rawText = "";
    try {
      rawText = await this.llmChat(systemPrompt, userMessage);
    } catch (err) {
      const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
      log.warn(`EmailTriage: LLM call failed — ${msg}`);
      return [];
    }

    try {
      // Reasoning models (minimax/MiniMax-M2.x, DeepSeek-R1, Kimi…) prepend a
      // <think>…</think> block that breaks JSON.parse ("Unrecognized token '<'").
      // Strip it first, then drop code fences, then slice to the JSON array in
      // case the model wrapped it in prose ("Here is the result: [...]").
      let cleaned = stripReasoning(rawText).replace(/```(?:json)?/gi, "").trim();
      const lb = cleaned.indexOf("[");
      const rb = cleaned.lastIndexOf("]");
      if (lb !== -1 && rb > lb) cleaned = cleaned.slice(lb, rb + 1);
      if (!cleaned) {
        log.warn(`EmailTriage: LLM returned empty/answerless response (${emails.length} emails in batch)`);
        return [];
      }

      const parsed = JSON.parse(cleaned) as Array<{
        idx: number;
        urgency: Urgency;
        attention_needed: boolean;
        summary: string;
      }>;

      return parsed.map((r) => ({
        gmail_id: emailSummaries[r.idx]?.gmail_id ?? "",
        urgency: r.urgency,
        attention_needed: r.attention_needed,
        summary: r.summary,
      })).filter((r) => r.gmail_id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`EmailTriage: parse failed — ${msg} — raw response (first 500 chars): ${rawText.slice(0, 500)}`);
      return [];
    }
  }

  /** Update google_emails with classification results */
  applyClassification(results: ClassificationResult[]): void {
    const stmt = this.db.prepare(`
      UPDATE google_emails
      SET urgency = ?, attention_needed = ?, ai_summary = ?
      WHERE gmail_id = ?
    `);

    for (const r of results) {
      stmt.run(r.urgency, r.attention_needed ? 1 : 0, r.summary, r.gmail_id);
    }
  }

  // ─── IMAP / communications path ──────────────────────────────────────────
  //
  // Mirror of the google_emails path, but for inbound rows in the
  // `communications` table (channel='email', direction='inbound'). These
  // rows come from the IMAP Fetcher and never see Gmail's
  // classification columns. We piggy-back on classifyBatch() — the LLM
  // call is the expensive part and works on a generic shape — and persist
  // the result inside `metadata.triage` instead of adding columns.

  /** Pull inbound IMAP/email rows from `communications` that haven't been
   *  classified yet (no `metadata.triage` key). */
  getUnclassifiedComms(limit = 20): GoogleEmailRow[] {
    try {
      const rows = this.db.prepare(`
        SELECT id,
               COALESCE(NULLIF(json_extract(metadata, '$.from'), ''), '') as from_full,
               subject, body, recipients_to, gmail_thread_id, thread_id, sent_at, created_at
        FROM communications
        WHERE channel = 'email'
          AND direction = 'inbound'
          AND status NOT IN ('archived')
          AND (
            json_extract(metadata, '$.triage') IS NULL
            OR json_extract(metadata, '$.triage') = ''
          )
        ORDER BY COALESCE(sent_at, created_at) DESC
        LIMIT ?
      `).all(limit) as Array<{
        id: string; from_full: string; subject: string; body: string;
        recipients_to: string; gmail_thread_id: string; thread_id: string;
        sent_at: string | null; created_at: string;
      }>;

      // Map to GoogleEmailRow shape so classifyBatch() can consume both sources.
      // We treat `id` as the gmail_id key; the apply step routes back to the
      // correct table based on whether the id matches a google_emails row.
      return rows.map((r) => {
        const fromMatch = /<([^>]+)>/.exec(r.from_full);
        const from_email = fromMatch?.[1] ?? r.from_full;
        const from_name = fromMatch ? r.from_full.replace(/<[^>]+>\s*$/, "").trim().replace(/^"|"$/g, "") : "";
        return {
          gmail_id: r.id,
          thread_id: r.gmail_thread_id || r.thread_id,
          from_email,
          from_name,
          to_emails: r.recipients_to,
          subject: r.subject,
          snippet: (r.body ?? "").slice(0, 240),
          body_text: r.body ?? "",
          date: r.sent_at ?? r.created_at,
          labels: '["INBOX"]',
        };
      });
    } catch {
      return [];
    }
  }

  /** Persist classification into `communications.metadata.triage` (JSON). */
  applyClassificationComms(results: ClassificationResult[]): void {
    const stmt = this.db.prepare(`
      UPDATE communications
      SET metadata = json_set(metadata,
            '$.triage', json_object(
              'urgency', ?,
              'attention_needed', ?,
              'summary', ?,
              'classified_at', datetime('now')
            )),
          updated_at = datetime('now')
      WHERE id = ?
    `);
    for (const r of results) {
      stmt.run(r.urgency, r.attention_needed ? 1 : 0, r.summary, r.gmail_id);
    }
  }

  /** Same idea as generateDraft() but the source row lives in
   *  `communications` (not `google_emails`). The reply is created as a new
   *  outbound comm linked back via metadata.in_reply_to_comm_id. */
  async generateDraftForComm(email: GoogleEmailRow): Promise<string> {
    const bodyPreview = email.body_text.slice(0, 3000);

    const systemPrompt = `You are a professional email assistant drafting a reply on behalf of the user.
Write a concise, polite reply that addresses the sender's key points or questions.
Keep the tone professional but friendly. Be direct and helpful.
Do NOT include subject line, greetings like "Dear...", or sign-off — the user will add those.
Output ONLY the reply body text, nothing else.
If the email doesn't clearly need a reply (just informational), write a brief acknowledgment.`;

    const userMessage = `Original email:
From: ${email.from_name ? `${email.from_name} <${email.from_email}>` : email.from_email}
Subject: ${email.subject}
Date: ${email.date}

${bodyPreview}`;

    const draftBody = await this.llmChat(systemPrompt, userMessage);

    const commId = newId();
    const now = isoNow();
    const reSubject = email.subject.startsWith("Re:") ? email.subject : `Re: ${email.subject}`;

    this.db.prepare(`
      INSERT INTO communications (
        id, channel, direction, status, subject, body, body_html,
        recipients_to, thread_id, in_reply_to, metadata, created_at, updated_at
      ) VALUES (?, 'email', 'outbound', 'draft', ?, ?, '',
        ?, ?, ?, ?, ?, ?)
    `).run(
      commId,
      reSubject,
      draftBody,
      email.from_email,
      email.thread_id,
      email.gmail_id,
      JSON.stringify({
        auto_draft: true,
        source_comm_id: email.gmail_id,
        from_name: email.from_name,
      }),
      now,
      now,
    );

    log.debug(`EmailTriage: comm-draft ${commId} created for source ${email.gmail_id}`);
    return commId;
  }

  /** Generate a draft reply for an email that needs attention */
  async generateDraft(email: GoogleEmailRow): Promise<string> {
    // LLM client handles key validation

    const bodyPreview = email.body_text.slice(0, 3000);

    const systemPrompt = `You are a professional email assistant drafting a reply on behalf of the user.
Write a concise, polite reply that addresses the sender's key points or questions.
Keep the tone professional but friendly. Be direct and helpful.
Do NOT include subject line, greetings like "Dear...", or sign-off — the user will add those.
Output ONLY the reply body text, nothing else.
If the email doesn't clearly need a reply (just informational), write a brief acknowledgment.`;

    const userMessage = `Original email:
From: ${email.from_name ? `${email.from_name} <${email.from_email}>` : email.from_email}
Subject: ${email.subject}
Date: ${email.date}

${bodyPreview}`;

    const draftBody = await this.llmChat(systemPrompt, userMessage);

    // Create a communications draft record
    const commId = newId();
    const now = isoNow();
    const reSubject = email.subject.startsWith("Re:") ? email.subject : `Re: ${email.subject}`;

    this.db.prepare(`
      INSERT INTO communications (
        id, channel, direction, status, subject, body, body_html,
        recipients_to, gmail_thread_id, metadata, created_at, updated_at
      ) VALUES (?, 'email', 'outbound', 'draft', ?, ?, '',
        ?, ?, ?, ?, ?)
    `).run(
      commId,
      reSubject,
      draftBody,
      email.from_email,
      email.thread_id,
      JSON.stringify({
        auto_draft: true,
        source_gmail_id: email.gmail_id,
        from_name: email.from_name,
      }),
      now,
      now,
    );

    // Link draft to the google_email
    this.db.prepare(`
      UPDATE google_emails SET draft_comm_id = ? WHERE gmail_id = ?
    `).run(commId, email.gmail_id);

    log.debug(`EmailTriage: draft ${commId} created for email ${email.gmail_id}`);
    return commId;
  }

  /** Get emails needing attention with their draft info */
  getAttentionQueue(limit = 50): AttentionItem[] {
    try {
      return this.db.prepare(`
        SELECT e.gmail_id, e.thread_id, e.from_email, e.from_name,
               e.subject, e.snippet, e.date, e.urgency, e.ai_summary,
               e.draft_comm_id,
               COALESCE(c.body, '') as draft_body,
               COALESCE(c.status, '') as draft_status
        FROM google_emails e
        LEFT JOIN communications c ON c.id = e.draft_comm_id AND e.draft_comm_id <> ''
        WHERE e.attention_needed = 1
        ORDER BY
          CASE e.urgency
            WHEN 'critical' THEN 1
            WHEN 'high' THEN 2
            WHEN 'normal' THEN 3
            WHEN 'low' THEN 4
            ELSE 5
          END,
          e.date DESC
        LIMIT ?
      `).all(limit) as AttentionItem[];
    } catch {
      return [];
    }
  }

  /** Get triage stats for dashboard */
  getTriageStats(): {
    unclassified: number;
    attention_needed: number;
    critical: number;
    high: number;
    drafts_pending: number;
  } {
    try {
      const unclassified = (this.db.prepare(
        "SELECT COUNT(*) as c FROM google_emails WHERE attention_needed = -1 AND labels LIKE '%\"INBOX\"%'"
      ).get() as { c: number })?.c ?? 0;

      const attention_needed = (this.db.prepare(
        "SELECT COUNT(*) as c FROM google_emails WHERE attention_needed = 1"
      ).get() as { c: number })?.c ?? 0;

      const critical = (this.db.prepare(
        "SELECT COUNT(*) as c FROM google_emails WHERE urgency = 'critical' AND attention_needed = 1"
      ).get() as { c: number })?.c ?? 0;

      const high = (this.db.prepare(
        "SELECT COUNT(*) as c FROM google_emails WHERE urgency = 'high' AND attention_needed = 1"
      ).get() as { c: number })?.c ?? 0;

      const drafts_pending = (this.db.prepare(
        `SELECT COUNT(*) as c FROM google_emails e
         JOIN communications c ON c.id = e.draft_comm_id
         WHERE e.draft_comm_id <> '' AND c.status = 'draft'`
      ).get() as { c: number })?.c ?? 0;

      return { unclassified, attention_needed, critical, high, drafts_pending };
    } catch {
      return { unclassified: 0, attention_needed: 0, critical: 0, high: 0, drafts_pending: 0 };
    }
  }
}
