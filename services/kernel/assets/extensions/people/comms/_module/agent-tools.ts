/**
 * Agent-shaped comms tools.
 *
 * The original `commsTools(...)` set is REST-style CRUD (29 tools — create,
 * list, get, update, delete on every entity), exactly the antipattern David
 * Soria Parra calls out in the MCP keynote. This file adds a smaller set of
 * intent-verbs designed for an LLM:
 *
 *   - `kernel_email_send`         — atomic compose+send (replaces create→send)
 *   - `kernel_email_search`       — Gmail inbox search with structured output
 *   - `kernel_email_fetch`        — fetch one Gmail message and store it
 *   - `kernel_email_thread`       — full thread view, structured
 *   - `kernel_email_classify`     — set provenance/importance/action on inbound
 *   - `kernel_email_drafts`       — list drafts (filterable)
 *   - `kernel_email_inbox_recent` — list recent inbound emails (local store)
 *
 * Each carries `tags` (so kernel_tool_search ranks them) and `outputSchema`
 * (so kernel_code_run gets typed returns). The legacy `kernel_comms_*` tools
 * remain for back-compat — agents that already reference them keep working.
 */
import { z } from "zod";
import type { ToolDefinition } from "../../../../../src/core/types.js";
import type { CommsService } from "./service.js";
import type { Communication } from "./types.js";
import { errorResult, structuredResult, textResult } from "../../../../../src/core/helpers.js";

// ── Shared schemas ────────────────────────────────────────────

const CommSummarySchema = z.object({
  id: z.string(),
  channel: z.string(),
  direction: z.string(),
  status: z.string(),
  subject: z.string(),
  recipients_to: z.string(),
  thread_id: z.string(),
  contact_id: z.string().nullable(),
  account_id: z.string().nullable(),
  sent_at: z.string().nullable(),
  created_at: z.string(),
});

function commSummary(c: Communication): z.infer<typeof CommSummarySchema> {
  return {
    id: c.id,
    channel: c.channel,
    direction: c.direction,
    status: c.status,
    subject: c.subject,
    recipients_to: c.recipients_to,
    thread_id: c.thread_id,
    contact_id: c.contact_id,
    account_id: c.account_id,
    sent_at: c.sent_at,
    created_at: c.created_at,
  };
}

// ── Tool builders ─────────────────────────────────────────────

export function agentCommsTools(service: CommsService): ToolDefinition[] {
  return [
    buildEmailSend(service),
    buildEmailSearch(service),
    buildEmailFetch(service),
    buildEmailThread(service),
    buildEmailClassify(service),
    buildEmailDrafts(service),
    buildEmailInboxRecent(service),
  ];
}

// ── kernel_email_send ─────────────────────────────────────────

const EmailSendInput = z.object({
  to: z.string().describe("Recipient email(s), comma-separated."),
  subject: z.string().describe("Subject line."),
  body: z.string().describe("Plain-text body. Use `body_html` for rich HTML."),
  body_html: z.string().optional().describe("Optional HTML body."),
  cc: z.string().optional(),
  bcc: z.string().optional(),
  account_id: z.string().optional().describe("Email account to send from. Omit to use the default account."),
  reply_to_id: z.string().optional().describe("Communication ID to reply to. Inherits thread + In-Reply-To headers."),
  contact_id: z.string().optional().describe("Optional CRM contact id — auto-fills `to` if empty."),
});

const EmailSendOutput = z.object({
  id: z.string(),
  thread_id: z.string(),
  account_id: z.string().nullable(),
  recipients_to: z.string(),
  sent_at: z.string().nullable(),
  gmail_message_id: z.string(),
});

function buildEmailSend(service: CommsService): ToolDefinition {
  return {
    name: "kernel_email_send",
    description:
      "Compose and send an email in ONE call. Replaces the legacy create→send 2-step. " +
      "Pass `to` + `subject` + `body` for a fresh email, or `reply_to_id` to reply within an existing thread. " +
      "Returns the sent communication id, thread, and Gmail message id when applicable.",
    inputSchema: EmailSendInput,
    outputSchema: EmailSendOutput,
    tags: ["email", "send", "compose", "comms"],
    async handler(args) {
      const input = EmailSendInput.parse(args);
      try {
        const draft = service.create({
          channel: "email",
          direction: "outbound",
          subject: input.subject,
          body: input.body,
          body_html: input.body_html,
          contact_id: input.contact_id,
          account_id: input.account_id,
          in_reply_to: input.reply_to_id,
          recipients_to: input.to,
          recipients_cc: input.cc,
          recipients_bcc: input.bcc,
        });
        const sent = await service.sendEmail(draft.id);
        return structuredResult(
          {
            id: sent.id,
            thread_id: sent.thread_id,
            account_id: sent.account_id,
            recipients_to: sent.recipients_to,
            sent_at: sent.sent_at,
            gmail_message_id: sent.gmail_message_id,
          },
          `Email sent (id ${sent.id}) to ${sent.recipients_to} — gmail:${sent.gmail_message_id || "—"}.`,
        );
      } catch (err) {
        return errorResult(`email_send failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

// ── kernel_email_search ───────────────────────────────────────

const EmailSearchInput = z.object({
  query: z.string().describe("Gmail query syntax. Examples: 'is:unread newer_than:7d', 'from:invoice subject:receipt', 'label:important'."),
  max_results: z.number().int().min(1).max(50).default(10),
  account_id: z.string().optional().describe("Email account to search. Omit for default."),
});

const EmailSearchOutput = z.object({
  query: z.string(),
  total: z.number().int(),
  messages: z.array(z.object({
    gmail_id: z.string(),
    gmail_thread_id: z.string(),
    from: z.string(),
    to: z.string(),
    subject: z.string(),
    snippet: z.string(),
    date: z.string(),
    labels: z.array(z.string()),
  })),
});

function buildEmailSearch(service: CommsService): ToolDefinition {
  return {
    name: "kernel_email_search",
    description:
      "Search Gmail inbox. Returns structured message summaries (gmail_id, from, subject, snippet, labels). " +
      "Pair with `kernel_email_fetch` to materialize a hit as a stored Communication.",
    inputSchema: EmailSearchInput,
    outputSchema: EmailSearchOutput,
    tags: ["email", "search", "inbox", "comms"],
    async handler(args) {
      const { query, max_results, account_id } = EmailSearchInput.parse(args);
      try {
        const messages = await service.searchInbox(query, max_results, account_id);
        const out = { query, total: messages.length, messages };
        if (messages.length === 0) {
          return { ...textResult(`No emails matched \`${query}\`.`), structuredContent: out };
        }
        const lines = [
          `Found ${messages.length} email(s) for \`${query}\`:`,
          ...messages.map((m, i) =>
            `${i + 1}. **${m.subject}** — ${m.from}\n   ${m.snippet.slice(0, 120)}${m.snippet.length > 120 ? "…" : ""}\n   gmail:${m.gmail_id}`,
          ),
        ];
        return { ...textResult(lines.join("\n\n")), structuredContent: out };
      } catch (err) {
        return errorResult(`email_search failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

// ── kernel_email_fetch ────────────────────────────────────────

const EmailFetchInput = z.object({
  gmail_message_id: z.string().describe("Gmail message id (from email_search results)."),
  account_id: z.string().optional(),
});

const EmailFetchOutput = z.object({
  id: z.string(),
  thread_id: z.string(),
  gmail_message_id: z.string(),
  gmail_thread_id: z.string(),
  from: z.string(),
  recipients_to: z.string(),
  subject: z.string(),
  body: z.string(),
  contact_id: z.string().nullable(),
  sent_at: z.string().nullable(),
});

function buildEmailFetch(service: CommsService): ToolDefinition {
  return {
    name: "kernel_email_fetch",
    description:
      "Fetch one Gmail message by id and persist it as an inbound Communication. Idempotent — re-fetching the same id returns the existing record. " +
      "Auto-matches sender against CRM contacts.",
    inputSchema: EmailFetchInput,
    outputSchema: EmailFetchOutput,
    tags: ["email", "fetch", "ingest", "comms"],
    async handler(args) {
      const { gmail_message_id, account_id } = EmailFetchInput.parse(args);
      try {
        const comm = await service.fetchEmail(gmail_message_id, account_id);
        const meta = JSON.parse(comm.metadata || "{}") as { from?: string };
        const out = {
          id: comm.id,
          thread_id: comm.thread_id,
          gmail_message_id: comm.gmail_message_id,
          gmail_thread_id: comm.gmail_thread_id,
          from: meta.from ?? "",
          recipients_to: comm.recipients_to,
          subject: comm.subject,
          body: comm.body,
          contact_id: comm.contact_id,
          sent_at: comm.sent_at,
        };
        return structuredResult(
          out,
          `Stored email ${comm.id} — ${comm.subject || "(no subject)"} from ${out.from || "(unknown)"}.`,
        );
      } catch (err) {
        return errorResult(`email_fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

// ── kernel_email_thread ───────────────────────────────────────

const EmailThreadInput = z.object({
  thread_id: z.string().describe("Thread id (same as the first message id in the thread)."),
});

const EmailThreadOutput = z.object({
  thread_id: z.string(),
  count: z.number().int(),
  messages: z.array(CommSummarySchema.extend({
    body: z.string(),
  })),
});

function buildEmailThread(service: CommsService): ToolDefinition {
  return {
    name: "kernel_email_thread",
    description:
      "Return every Communication in a thread, chronologically. Use this when you need full conversation context before composing a reply.",
    inputSchema: EmailThreadInput,
    outputSchema: EmailThreadOutput,
    tags: ["email", "thread", "context", "comms"],
    async handler(args) {
      const { thread_id } = EmailThreadInput.parse(args);
      const comms = service.getThread(thread_id);
      const out = {
        thread_id,
        count: comms.length,
        messages: comms.map((c) => ({ ...commSummary(c), body: c.body })),
      };
      if (comms.length === 0) {
        return { ...textResult(`No messages in thread ${thread_id}.`), structuredContent: out };
      }
      const lines = [
        `Thread ${thread_id} — ${comms.length} message(s):`,
        ...comms.map((c, i) =>
          `${i + 1}. [${c.status}/${c.direction}] ${c.subject || "(no subject)"}\n` +
          `   ${(c.body || "").slice(0, 160)}${(c.body || "").length > 160 ? "…" : ""}\n` +
          `   ${c.sent_at ? `sent ${c.sent_at}` : `created ${c.created_at}`} · id ${c.id}`,
        ),
      ];
      return { ...textResult(lines.join("\n\n")), structuredContent: out };
    },
  };
}

// ── kernel_email_classify ─────────────────────────────────────

const EmailClassifyInput = z.object({
  id: z.string().describe("Communication id (the inbound email)."),
  provenance: z.enum(["vendor", "client", "personal", "automated", "unknown"]),
  importance: z.enum(["critical", "high", "normal", "low"]),
  action_required: z.enum(["reply", "read", "file", "escalate", "schedule", "none"]),
  stakeholder_id: z.string().optional(),
  topic_tags: z.array(z.string()).optional(),
  rationale: z.string().optional(),
});

const EmailClassifyOutput = z.object({
  id: z.string(),
  provenance: z.string(),
  importance: z.string(),
  action_required: z.string(),
  stakeholder_id: z.string(),
  topic_tags: z.array(z.string()),
});

function buildEmailClassify(service: CommsService): ToolDefinition {
  return {
    name: "kernel_email_classify",
    description:
      "Stamp provenance / importance / action_required / stakeholder / topic_tags on an inbound email. " +
      "Idempotent: re-classifying overwrites the previous block. Used downstream by triage and the office router.",
    inputSchema: EmailClassifyInput,
    outputSchema: EmailClassifyOutput,
    tags: ["email", "classify", "triage", "comms"],
    async handler(args) {
      const a = EmailClassifyInput.parse(args);
      const ok = service.setClassification(a.id, a);
      if (!ok) return errorResult(`Communication not found: ${a.id}`);
      const out = {
        id: a.id,
        provenance: a.provenance,
        importance: a.importance,
        action_required: a.action_required,
        stakeholder_id: a.stakeholder_id ?? "",
        topic_tags: a.topic_tags ?? [],
      };
      return structuredResult(
        out,
        `Classified ${a.id}: ${a.importance}/${a.provenance} → ${a.action_required}.`,
      );
    },
  };
}

// ── kernel_email_drafts ───────────────────────────────────────

const EmailDraftsInput = z.object({
  contact_id: z.string().optional().describe("Filter to drafts for a specific CRM contact."),
  task_id: z.string().optional().describe("Filter to drafts linked to a task."),
  account_id: z.string().optional().describe("Filter by sending account."),
  limit: z.number().int().min(1).max(100).default(20),
});

const EmailListOutput = z.object({
  total: z.number().int(),
  messages: z.array(CommSummarySchema),
});

function buildEmailDrafts(service: CommsService): ToolDefinition {
  return {
    name: "kernel_email_drafts",
    description:
      "List your unsent email drafts, newest first. Filterable by contact, task, or account. " +
      "Use `kernel_email_send` to dispatch a draft after reviewing.",
    inputSchema: EmailDraftsInput,
    outputSchema: EmailListOutput,
    tags: ["email", "drafts", "list", "comms"],
    async handler(args) {
      const { contact_id, task_id, account_id, limit } = EmailDraftsInput.parse(args);
      const rows = service.list({
        status: "draft",
        channel: "email",
        contact_id,
        task_id,
        account_id,
        limit,
      });
      const out = { total: rows.length, messages: rows.map(commSummary) };
      if (rows.length === 0) {
        return { ...textResult("No drafts."), structuredContent: out };
      }
      const lines = [
        `${rows.length} draft(s):`,
        ...rows.map((c) =>
          `- ${c.id} → ${c.recipients_to || "(no recipient)"} · ${c.subject || "(no subject)"} · ${c.created_at}`,
        ),
      ];
      return { ...textResult(lines.join("\n")), structuredContent: out };
    },
  };
}

// ── kernel_email_inbox_recent ─────────────────────────────────

const EmailInboxRecentInput = z.object({
  contact_id: z.string().optional(),
  account_id: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(20),
});

function buildEmailInboxRecent(service: CommsService): ToolDefinition {
  return {
    name: "kernel_email_inbox_recent",
    description:
      "List recent INBOUND emails already stored in the kernel (e.g. fetched via `kernel_email_fetch` or sync). " +
      "For live Gmail search use `kernel_email_search` instead.",
    inputSchema: EmailInboxRecentInput,
    outputSchema: EmailListOutput,
    tags: ["email", "inbox", "list", "recent", "comms"],
    async handler(args) {
      const { contact_id, account_id, limit } = EmailInboxRecentInput.parse(args);
      const rows = service.list({
        direction: "inbound",
        channel: "email",
        contact_id,
        account_id,
        limit,
      });
      const out = { total: rows.length, messages: rows.map(commSummary) };
      if (rows.length === 0) {
        return { ...textResult("No inbound emails stored."), structuredContent: out };
      }
      const lines = [
        `${rows.length} inbound email(s):`,
        ...rows.map((c) =>
          `- ${c.id} · ${c.status} · ${c.subject || "(no subject)"} · ${c.sent_at ?? c.created_at}`,
        ),
      ];
      return { ...textResult(lines.join("\n")), structuredContent: out };
    },
  };
}
