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

import {
  type SqliteDb,
  type KernelConfig,
  newId,
  isoNow,
  log,
  stripReasoning,
  localDateTime,
  kernelTimezone,
} from "@kernl/extension-sdk";
import { type AgendaItem, AGENDA_PROMPT_RULES, parseAgendaItems } from "./agenda-extract.js";
import { mailLlmChat } from "./mail-llm.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type Urgency = "critical" | "high" | "normal" | "low";

export interface ClassificationResult {
  gmail_id: string;
  urgency: Urgency;
  attention_needed: boolean;
  summary: string;
  agenda_items: AgendaItem[];
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
  /** Conversation key the agenda writer dedups on (thread id, else the row id). */
  thread_key: string;
  /** What the classifier reads: the body, capped at 1 500 characters. */
  body_excerpt: string;
  /** communications rows only: their own thread_id (what kernel_comms_thread takes). */
  comm_thread_id?: string;
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

/** How far back getUnclassifiedComms looks for inbound mail to classify. */
export const TRIAGE_WINDOW_DAYS = 14;

// ── Answer parsing ───────────────────────────────────────────────────────────

/** Index just past the `]` closing the array that opens at `start`, or -1. */
function matchingBracket(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * The model's JSON answer, from a response that may wrap it in reasoning
 * prose, code fences or a draft. Reasoning text mentions brackets too
 * ("output a JSON array with [idx]"), so slicing from the first `[` to the
 * last `]` broke on exactly those models. Instead every array of objects that
 * parses is a candidate, and the answer is the one that ends last — the final
 * answer comes after the thinking and any draft — taking the outermost when
 * arrays nest (an item may carry an array of its own). Null when no
 * complete array is there (the response was cut off, or never answered).
 */
export function extractJsonArray(raw: string): unknown[] | null {
  const text = raw.replace(/```(?:json)?/gi, "");
  let best: { start: number; end: number; value: unknown[] } | null = null;
  for (const m of text.matchAll(/\[\s*(?=\{|\])/g)) {
    const start = m.index ?? 0;
    const end = matchingBracket(text, start);
    if (end === -1 || (best && end < best.end)) continue;
    if (best && end === best.end) continue; // same close, later start: nested inside best
    try {
      const value = JSON.parse(text.slice(start, end));
      if (Array.isArray(value)) best = { start, end, value };
    } catch {
      // a draft or an example in the reasoning — not the answer
    }
  }
  return best?.value ?? null;
}

// ── Service ──────────────────────────────────────────────────────────────────

export class EmailTriageService {
  constructor(
    private db: SqliteDb,
    private config: KernelConfig,
  ) {}

  /** LLM call on the mail model (see mail-llm.ts), else the default chain. */
  private async llmChat(system: string, user: string): Promise<string> {
    // Reasoning models think out loud before the JSON; with the default 2048
    // tokens a batch of 20 mails ran out mid-thought and returned no answer.
    return mailLlmChat(this.db, this.config, { system, user, caller: "email-triage", maxTokens: 8192 });
  }

  /** Get unclassified emails (attention_needed = -1), limited to inbox and
   *  to the last TRIAGE_WINDOW_DAYS days, so the first Gmail sync does not
   *  push months of old mail through the LLM (older rows stay unclassified).
   *  google_emails.date is stored as an ISO UTC instant (toISOString in the
   *  Gmail importer), so an ISO cutoff compares like with like. */
  getUnclassified(limit = 20): GoogleEmailRow[] {
    const cutoff = new Date(Date.now() - TRIAGE_WINDOW_DAYS * 86_400_000).toISOString();
    try {
      const rows = this.db.prepare(`
        SELECT gmail_id, thread_id, from_email, from_name, to_emails,
               subject, snippet, body_text, date, labels
        FROM google_emails
        WHERE attention_needed = -1
          AND labels LIKE '%"INBOX"%'
          AND date >= ?
          AND from_email NOT LIKE '%noreply%'
          AND from_email NOT LIKE '%no-reply%'
          AND from_email NOT LIKE '%notifications%'
          AND from_email NOT LIKE '%mailer-daemon%'
        ORDER BY date DESC
        LIMIT ?
      `).all(cutoff, limit) as Array<Omit<GoogleEmailRow, "thread_key" | "body_excerpt">>;
      return rows.map((r) => ({
        ...r,
        thread_key: r.thread_id || r.gmail_id,
        body_excerpt: (r.body_text || r.snippet || "").slice(0, 1500),
      }));
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
      body: e.body_excerpt,
      date: e.date,
    }));

    const systemPrompt = `You are an email triage assistant. Classify each email by urgency and whether it needs the user's attention/response.
NOW is ${localDateTime()} (${kernelTimezone()}).

Output ONLY valid JSON array. Each element:
{
  "idx": number,
  "urgency": "critical" | "high" | "normal" | "low",
  "attention_needed": boolean,
  "summary": "string — one sentence summary",
  "agenda_items": [ ... ]
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

${AGENDA_PROMPT_RULES}
Use an empty array for agenda_items when the email has no dated item.

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
      // Strip it first; extractJsonArray then finds the answer among the prose,
      // code fences and drafts a model may wrap it in.
      const parsed = extractJsonArray(stripReasoning(rawText)) as Array<{
        idx: number;
        urgency: Urgency;
        attention_needed: boolean;
        summary: string;
        agenda_items?: unknown;
      }> | null;
      if (!parsed) {
        log.warn(
          `EmailTriage: no JSON answer in the response (${emails.length} emails in batch) — ` +
            `raw response (first 500 chars): ${rawText.slice(0, 500)}`,
        );
        return [];
      }

      const nowLocal = localDateTime();
      return parsed.map((r) => ({
        gmail_id: emailSummaries[r.idx]?.gmail_id ?? "",
        urgency: r.urgency,
        attention_needed: r.attention_needed,
        summary: r.summary,
        agenda_items: parseAgendaItems(r.agenda_items, nowLocal),
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
   *  classified yet (no `metadata.triage` key), received in the last
   *  TRIAGE_WINDOW_DAYS days.
   *
   *  No status filter: CommsService stores every inbound row with
   *  status='archived' (for inbound it just means "received"), so filtering
   *  archived out left IMAP mail never classified. The age window keeps the
   *  first run after an upgrade from pushing months of old mail through the
   *  LLM. sent_at/created_at are ISO UTC instants ("…Z", from toISOString /
   *  isoNow), so an ISO cutoff compares like with like; an empty sent_at
   *  (provider without a Date header) falls back to created_at.
   *
   *  Rows the auto labeller has not tagged yet (no or empty
   *  metadata.auto_label) are left for a later tick, so the newsletter
   *  exclusion always has a label to act on. */
  getUnclassifiedComms(limit = 20): GoogleEmailRow[] {
    const cutoff = new Date(Date.now() - TRIAGE_WINDOW_DAYS * 86_400_000).toISOString();
    try {
      const rows = this.db.prepare(`
        SELECT id,
               COALESCE(NULLIF(json_extract(metadata, '$.from'), ''), '') as from_full,
               subject, body, recipients_to, gmail_thread_id, thread_id, sent_at, created_at,
               COALESCE(NULLIF(gmail_thread_id, ''), NULLIF(thread_id, ''), id) AS thread_key
        FROM communications
        WHERE channel = 'email'
          AND direction = 'inbound'
          AND COALESCE(NULLIF(sent_at, ''), created_at) >= ?
          AND COALESCE(json_extract(metadata, '$.auto_label'), '') NOT IN ('', 'newsletter')
          AND (
            json_extract(metadata, '$.triage') IS NULL
            OR json_extract(metadata, '$.triage') = ''
          )
        ORDER BY COALESCE(NULLIF(sent_at, ''), created_at) DESC
        LIMIT ?
      `).all(cutoff, limit) as Array<{
        id: string; from_full: string; subject: string; body: string;
        recipients_to: string; gmail_thread_id: string; thread_id: string;
        sent_at: string | null; created_at: string; thread_key: string;
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
          thread_key: r.thread_key,
          body_excerpt: (r.body ?? "").slice(0, 1500),
          comm_thread_id: r.thread_id || undefined,
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
