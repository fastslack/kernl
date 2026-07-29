/**
 * EmailAnalysisService
 *
 * Analyzes fetched emails via LLM and produces pending suggestions
 * (tasks, reminders, contacts, shopping items) that require user approval
 * before being created in the kernel.
 *
 * Flow:
 *   1. Scheduler calls analyzeNewEmails() every N hours
 *   2. Fetches unanalyzed inbound communications
 *   3. LLM extracts structured suggestions
 *   4. Suggestions saved to email_analysis_suggestions (status=pending)
 *   5. User approves/dismisses from dashboard or via MCP tools
 *   6. On approve: creates task/reminder/contact/shopping item
 */

import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { KernelConfig } from "../../../../../src/core/config.js";
import { newId, isoNow } from "../../../../../src/core/helpers.js";
import { log } from "../../../../../src/core/logger.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type SuggestionType = "task" | "reminder" | "contact" | "shopping";
export type SuggestionStatus = "pending" | "approved" | "dismissed";

export interface TaskPayload {
  title: string;
  description?: string;
  priority: "low" | "medium" | "high" | "urgent";
  context?: string;  // GTD context e.g. @work, @home
  due_date?: string; // ISO date
}

export interface ReminderPayload {
  title: string;
  body?: string;
  trigger_at: string; // ISO datetime
  repeat?: "none" | "daily" | "weekly" | "monthly";
}

export interface ContactPayload {
  name: string;
  email: string;
  company?: string;
  relationship?: "personal" | "professional" | "family" | "acquaintance";
  notes?: string;
}

export interface ShoppingPayload {
  name: string;
  quantity?: number;
  unit?: string;
  notes?: string;
}

export type SuggestionPayload = TaskPayload | ReminderPayload | ContactPayload | ShoppingPayload;

export interface EmailSuggestion {
  id: string;
  comm_id: string;
  type: SuggestionType;
  status: SuggestionStatus;
  payload: SuggestionPayload;
  created_at: string;
  reviewed_at: string | null;
  // Joined from communications
  subject?: string;
  from_email?: string;
}

// LLM structured output
interface LlmAnalysisResult {
  suggestions: Array<{
    type: SuggestionType;
    payload: SuggestionPayload;
    reason: string; // short explanation of why this was detected
  }>;
  summary: string; // 1-sentence email summary
}

// ── Service ──────────────────────────────────────────────────────────────────

export class EmailAnalysisService {
  constructor(
    private db: SqliteDb,
    private config: KernelConfig,
  ) {}

  /** LLM call via global singleton */
  private async llmChat(system: string, user: string): Promise<string> {
    const { llm } = await import("../../../../../src/core/llm/client.js");
    const result = await llm().chat({ system, user, caller: "email-analysis" });
    return result.text;
  }

  /** Called by the scheduler — analyzes up to maxEmails unanalyzed inbound emails */
  async analyzeNewEmails(maxEmails = 15): Promise<{ analyzed: number; suggestions: number; errors: number }> {
    try { const { llm: getLlm } = await import("../../../../../src/core/llm/client.js"); if (!getLlm().hasKey) { log.debug("EmailAnalysis: no LLM API key configured"); return { analyzed: 0, suggestions: 0, errors: 0 }; } } catch { return { analyzed: 0, suggestions: 0, errors: 0 }; }

    // Get inbound emails not yet analyzed (metadata.email_analyzed != true)
    const rows = this.db.prepare(`
      SELECT id, subject, body, metadata, recipients_to
      FROM communications
      WHERE direction = 'inbound'
        AND channel = 'email'
        AND body != ''
        AND json_extract(metadata, '$.email_analyzed') IS NULL
      ORDER BY created_at DESC
      LIMIT ?
    `).all(maxEmails) as Array<{ id: string; subject: string; body: string; metadata: string; recipients_to: string }>;

    if (rows.length === 0) {
      log.debug("EmailAnalysis: no new emails to analyze");
      return { analyzed: 0, suggestions: 0, errors: 0 };
    }

    let analyzed = 0;
    let suggestions = 0;
    let errors = 0;

    for (const row of rows) {
      try {
        const result = await this.analyzeEmail(row.id, row.subject, row.body);
        analyzed++;

        // Save suggestions
        for (const s of result.suggestions) {
          this.db.prepare(`
            INSERT INTO email_analysis_suggestions (id, comm_id, type, status, payload, created_at)
            VALUES (?, ?, ?, 'pending', ?, ?)
          `).run(newId(), row.id, s.type, JSON.stringify(s.payload), isoNow());
          suggestions++;
        }

        // Mark email as analyzed with summary
        const meta = JSON.parse(row.metadata || "{}");
        meta.email_analyzed = true;
        meta.email_analysis_summary = result.summary;
        meta.email_analysis_suggestions = result.suggestions.length;
        this.db.prepare("UPDATE communications SET metadata = ? WHERE id = ?")
          .run(JSON.stringify(meta), row.id);

        log.debug(`EmailAnalysis: ${row.id} → ${result.suggestions.length} suggestions`);
      } catch (err) {
        errors++;
        log.warn(`EmailAnalysis: failed to analyze ${row.id}`, err);
        // Mark as analyzed with error so we don't retry in a loop
        try {
          const meta = JSON.parse(row.metadata || "{}");
          meta.email_analyzed = true;
          meta.email_analysis_error = String(err);
          this.db.prepare("UPDATE communications SET metadata = ? WHERE id = ?")
            .run(JSON.stringify(meta), row.id);
        } catch { /* ignore */ }
      }
    }

    if (analyzed > 0) {
      log.info(`EmailAnalysis: analyzed ${analyzed} emails → ${suggestions} suggestions (${errors} errors)`);
    }

    return { analyzed, suggestions, errors };
  }

  /** Analyze a single email by comm_id (on-demand, public) */
  async analyzeById(commId: string): Promise<{ suggestions: EmailSuggestion[]; summary: string }> {
    const row = this.db.prepare(`
      SELECT id, subject, body, metadata FROM communications WHERE id = ?
    `).get(commId) as { id: string; subject: string; body: string; metadata: string } | undefined;

    if (!row) throw new Error(`Communication ${commId} not found`);

    const result = await this.analyzeEmail(row.id, row.subject, row.body);

    // Upsert suggestions
    const newSuggestions: EmailSuggestion[] = [];
    for (const s of result.suggestions) {
      const id = newId();
      const now = isoNow();
      this.db.prepare(`
        INSERT INTO email_analysis_suggestions (id, comm_id, type, status, payload, created_at)
        VALUES (?, ?, ?, 'pending', ?, ?)
      `).run(id, commId, s.type, JSON.stringify(s.payload), now);
      newSuggestions.push({ id, comm_id: commId, type: s.type, status: "pending", payload: s.payload, created_at: now, reviewed_at: null });
    }

    // Update metadata
    const meta = JSON.parse(row.metadata || "{}");
    meta.email_analyzed = true;
    meta.email_analysis_summary = result.summary;
    meta.email_analysis_suggestions = result.suggestions.length;
    this.db.prepare("UPDATE communications SET metadata = ? WHERE id = ?")
      .run(JSON.stringify(meta), commId);

    return { suggestions: newSuggestions, summary: result.summary };
  }

  /** Get pending suggestions (with email context) */
  getPendingSuggestions(limit = 50): EmailSuggestion[] {
    const rows = this.db.prepare(`
      SELECT s.*, c.subject, json_extract(c.metadata, '$.from') as from_email
      FROM email_analysis_suggestions s
      JOIN communications c ON c.id = s.comm_id
      WHERE s.status = 'pending'
      ORDER BY s.created_at DESC
      LIMIT ?
    `).all(limit) as Array<EmailSuggestion & { payload: string }>;

    return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload as unknown as string) }));
  }

  /** Approve a suggestion → creates the entity in the kernel */
  async approveSuggestion(
    suggestionId: string,
    overrides: Partial<SuggestionPayload> = {},
    services: {
      createTask?: (payload: TaskPayload) => Promise<string>;
      createReminder?: (payload: ReminderPayload) => Promise<string>;
      createContact?: (payload: ContactPayload) => Promise<string>;
      addShoppingItem?: (payload: ShoppingPayload) => Promise<string>;
    },
  ): Promise<{ created_id: string; type: SuggestionType }> {
    const row = this.db.prepare(
      "SELECT * FROM email_analysis_suggestions WHERE id = ?"
    ).get(suggestionId) as { id: string; comm_id: string; type: SuggestionType; payload: string } | undefined;

    if (!row) throw new Error(`Suggestion ${suggestionId} not found`);

    const payload = { ...JSON.parse(row.payload), ...overrides };
    let createdId = "";

    switch (row.type) {
      case "task":
        if (!services.createTask) throw new Error("Task service not provided");
        createdId = await services.createTask(payload as TaskPayload);
        break;
      case "reminder":
        if (!services.createReminder) throw new Error("Reminder service not provided");
        createdId = await services.createReminder(payload as ReminderPayload);
        break;
      case "contact":
        if (!services.createContact) throw new Error("Contact service not provided");
        createdId = await services.createContact(payload as ContactPayload);
        break;
      case "shopping":
        if (!services.addShoppingItem) throw new Error("Shopping service not provided");
        createdId = await services.addShoppingItem(payload as ShoppingPayload);
        break;
    }

    this.db.prepare(
      "UPDATE email_analysis_suggestions SET status = 'approved', reviewed_at = ? WHERE id = ?"
    ).run(isoNow(), suggestionId);

    return { created_id: createdId, type: row.type };
  }

  /** Dismiss a suggestion */
  dismissSuggestion(suggestionId: string): void {
    const result = this.db.prepare(
      "UPDATE email_analysis_suggestions SET status = 'dismissed', reviewed_at = ? WHERE id = ?"
    ).run(isoNow(), suggestionId);
    if (result.changes === 0) throw new Error(`Suggestion ${suggestionId} not found`);
  }

  /** Get all suggestions for a specific email */
  getSuggestionsForEmail(commId: string): EmailSuggestion[] {
    const rows = this.db.prepare(`
      SELECT * FROM email_analysis_suggestions WHERE comm_id = ? ORDER BY created_at DESC
    `).all(commId) as Array<EmailSuggestion & { payload: string }>;
    return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload as unknown as string) }));
  }

  /** Hot-reload API keys — no-op, LLM client is global singleton */
  setApiKey(_key: string): void {}
  reloadConfig(): void {}

  // ── Private: LLM call ──────────────────────────────────────────────────────

  private async analyzeEmail(commId: string, subject: string, body: string): Promise<LlmAnalysisResult> {
    // Truncate body to ~3000 chars to save tokens
    const truncatedBody = body.length > 3000 ? body.slice(0, 3000) + "\n[...truncated]" : body;
    const today = new Date().toISOString().slice(0, 10);

    const systemPrompt = `You are an assistant that analyzes emails and extracts actionable items.
Today's date is ${today}.
Output ONLY valid JSON matching the schema below. No markdown, no explanation outside the JSON.

Schema:
{
  "summary": "string — one sentence summary of the email",
  "suggestions": [
    {
      "type": "task" | "reminder" | "contact" | "shopping",
      "reason": "string — brief explanation of why this was detected",
      "payload": <type-specific object>
    }
  ]
}

Payload schemas by type:
- task: { "title": string, "description"?: string, "priority": "low"|"medium"|"high"|"urgent", "context"?: string (GTD like @work @home @errands), "due_date"?: "YYYY-MM-DD" }
- reminder: { "title": string, "body"?: string, "trigger_at": "ISO datetime", "repeat"?: "none"|"daily"|"weekly"|"monthly" }
- contact: { "name": string, "email": string, "company"?: string, "relationship"?: "personal"|"professional"|"family"|"acquaintance", "notes"?: string }
- shopping: { "name": string, "quantity"?: number, "unit"?: string, "notes"?: string }

Rules:
- Only create suggestions if there is CLEAR intent. Do not over-extract.
- For due dates/times: if relative (e.g. "tomorrow", "next Friday"), convert to absolute ISO date based on today=${today}.
- For contacts: only suggest if the sender is clearly a person (not a newsletter/noreply).
- For shopping: only if the email explicitly asks to buy something.
- Return empty suggestions array if nothing actionable is found.
- Respond only with the JSON object, nothing else.`;

    const userMessage = `Email subject: ${subject}\n\n---\n${truncatedBody}`;

    const rawText = await this.llmChat(systemPrompt, userMessage);

    // Strip any accidental markdown code fences
    const cleaned = rawText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();

    try {
      const parsed = JSON.parse(cleaned) as LlmAnalysisResult;
      return {
        summary: parsed.summary ?? "",
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
      };
    } catch {
      log.warn(`EmailAnalysis: could not parse LLM response for ${commId}: ${cleaned.slice(0, 200)}`);
      return { summary: "", suggestions: [] };
    }
  }
}
