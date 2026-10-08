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
import { type ToolDefinition, bareAddress, defineTool, errorResult, structuredResult, textResult, wrapExternal } from "@kernl/extension-sdk";
import type { CommsService } from "./service.js";
import type { Communication } from "./types.js";

// ── Shared schemas ────────────────────────────────────────────

const CommSummarySchema = z.object({
  id: z.string(),
  channel: z.string(),
  direction: z.string(),
  status: z.string(),
  subject: z.string(),
  from_address: z.string().describe("Bare sender address (plain, validated; empty if none). Reply to this, never to a wrapped field."),
  recipients_to: z.string(),
  thread_id: z.string(),
  contact_id: z.string().nullable(),
  account_id: z.string().nullable(),
  sent_at: z.string().nullable(),
  created_at: z.string(),
});

/** Lives in the SDK (shared with every mail-reading tool); re-exported for existing callers. */
export { bareAddress };

/** Sender of a stored communication (inbound mail keeps it in metadata.from). */
function senderOf(c: Communication): string {
  try {
    return (JSON.parse(c.metadata || "{}") as { from?: string }).from ?? "";
  } catch {
    return "";
  }
}

/** Subject of an inbound message is third-party text; outbound is the user's own. */
function wrapSubject(c: Communication): string {
  return c.direction === "inbound" ? wrapExternal(c.subject, { source: "email", from: senderOf(c) }) : c.subject;
}

/** Body of an inbound message is third-party text; outbound is the user's own. */
function wrapBody(c: Communication): string {
  return c.direction === "inbound" ? wrapExternal(c.body, { source: "email", from: senderOf(c) }) : c.body;
}

function wrapPreview(c: Communication, max: number): string {
  const body = c.body || "";
  const text = `${body.slice(0, max)}${body.length > max ? "…" : ""}`;
  return c.direction === "inbound" ? wrapExternal(text, { source: "email", from: senderOf(c) }) : text;
}

function commSummary(c: Communication): z.infer<typeof CommSummarySchema> {
  return {
    id: c.id,
    channel: c.channel,
    direction: c.direction,
    status: c.status,
    subject: wrapSubject(c),
    from_address: c.direction === "inbound" ? bareAddress(senderOf(c)) : "",
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
  return defineTool({
    name: "kernel_email_send",
    // Publishes/sends outside Kernl — project runs draft through the outbox instead.
    outbound: true,
    description:
      "Compose and send an email in ONE call. Replaces the legacy create→send 2-step. " +
      "Pass `to` + `subject` + `body` for a fresh email, or `reply_to_id` to reply within an existing thread. " +
      "Returns the sent communication id, thread, and Gmail message id when applicable.",
    schema: EmailSendInput,
    outputSchema: EmailSendOutput,
    tags: ["email", "send", "compose", "comms"],
    async handler(input) {
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
  });
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
    from_address: z.string().describe("Bare sender address (plain, validated; empty if none). Reply to this."),
    to: z.string(),
    subject: z.string(),
    snippet: z.string(),
    date: z.string(),
    labels: z.array(z.string()),
  })),
});

function buildEmailSearch(service: CommsService): ToolDefinition {
  return defineTool({
    name: "kernel_email_search",
    description:
      "Search Gmail inbox. Returns structured message summaries (gmail_id, from, from_address, subject, snippet, labels). `from` is wrapped untrusted text; to reply or compare, use `from_address`. " +
      "Pair with `kernel_email_fetch` to materialize a hit as a stored Communication.",
    schema: EmailSearchInput,
    outputSchema: EmailSearchOutput,
    tags: ["email", "search", "inbox", "comms"],
    async handler({ query, max_results, account_id }) {
      try {
        const messages = await service.searchInbox(query, max_results, account_id);
        const wrapped = messages.map((m) => ({
          ...m,
          from: wrapExternal(m.from, { source: "email", from: m.from }),
          from_address: bareAddress(m.from),
          subject: wrapExternal(m.subject, { source: "email", from: m.from }),
          snippet: wrapExternal(m.snippet, { source: "email", from: m.from }),
        }));
        const out = { query, total: messages.length, messages: wrapped };
        if (messages.length === 0) {
          return { ...textResult(`No emails matched \`${query}\`.`), structuredContent: out };
        }
        const lines = [
          `Found ${messages.length} email(s) for \`${query}\`:`,
          ...messages.map((m, i) => {
            const snippet = `${m.snippet.slice(0, 120)}${m.snippet.length > 120 ? "…" : ""}`;
            const text = wrapExternal(`${m.subject} — ${m.from}\n${snippet}`, { source: "email", from: m.from });
            return `${i + 1}. ${text}\n   gmail:${m.gmail_id}`;
          }),
        ];
        return { ...textResult(lines.join("\n\n")), structuredContent: out };
      } catch (err) {
        return errorResult(`email_search failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });
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
  from_address: z.string().describe("Bare sender address (plain, validated; empty if none). Reply to this."),
  recipients_to: z.string(),
  subject: z.string(),
  body: z.string(),
  contact_id: z.string().nullable(),
  sent_at: z.string().nullable(),
});

function buildEmailFetch(service: CommsService): ToolDefinition {
  return defineTool({
    name: "kernel_email_fetch",
    description:
      "Fetch one Gmail message by id and persist it as an inbound Communication. Idempotent — re-fetching the same id returns the existing record. " +
      "Auto-matches sender against CRM contacts. `from` is wrapped untrusted text; reply using `from_address`.",
    schema: EmailFetchInput,
    outputSchema: EmailFetchOutput,
    tags: ["email", "fetch", "ingest", "comms"],
    async handler({ gmail_message_id, account_id }) {
      try {
        const comm = await service.fetchEmail(gmail_message_id, account_id);
        const meta = JSON.parse(comm.metadata || "{}") as { from?: string };
        const out = {
          id: comm.id,
          thread_id: comm.thread_id,
          gmail_message_id: comm.gmail_message_id,
          gmail_thread_id: comm.gmail_thread_id,
          from: wrapExternal(meta.from ?? "", { source: "email", from: meta.from }),
          from_address: bareAddress(meta.from),
          recipients_to: comm.recipients_to,
          subject: wrapExternal(comm.subject, { source: "email", from: meta.from }),
          body: wrapExternal(comm.body, { source: "email", from: meta.from }),
          contact_id: comm.contact_id,
          sent_at: comm.sent_at,
        };
        return structuredResult(
          out,
          `Stored email ${comm.id} — ${out.subject || "(no subject)"} from ${out.from || "(unknown)"}.`,
        );
      } catch (err) {
        return errorResult(`email_fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });
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
  return defineTool({
    name: "kernel_email_thread",
    description:
      "Return every Communication in a thread, chronologically. Use this when you need full conversation context before composing a reply. Reply to `from_address` (plain), never to wrapped text.",
    schema: EmailThreadInput,
    outputSchema: EmailThreadOutput,
    tags: ["email", "thread", "context", "comms"],
    async handler({ thread_id }) {
      const comms = service.getThread(thread_id);
      const out = {
        thread_id,
        count: comms.length,
        messages: comms.map((c) => ({ ...commSummary(c), body: wrapBody(c) })),
      };
      if (comms.length === 0) {
        return { ...textResult(`No messages in thread ${thread_id}.`), structuredContent: out };
      }
      const lines = [
        `Thread ${thread_id} — ${comms.length} message(s):`,
        ...comms.map((c, i) =>
          `${i + 1}. [${c.status}/${c.direction}] ${wrapSubject(c) || "(no subject)"}\n` +
          `   ${wrapPreview(c, 160)}\n` +
          `   ${c.sent_at ? `sent ${c.sent_at}` : `created ${c.created_at}`} · id ${c.id}`,
        ),
      ];
      return { ...textResult(lines.join("\n\n")), structuredContent: out };
    },
  });
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
  return defineTool({
    name: "kernel_email_classify",
    description:
      "Stamp provenance / importance / action_required / stakeholder / topic_tags on an inbound email. " +
      "Idempotent: re-classifying overwrites the previous block. Used downstream by triage and the office router.",
    schema: EmailClassifyInput,
    outputSchema: EmailClassifyOutput,
    tags: ["email", "classify", "triage", "comms"],
    async handler(a) {
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
  });
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
  return defineTool({
    name: "kernel_email_drafts",
    description:
      "List your unsent email drafts, newest first. Filterable by contact, task, or account. " +
      "Use `kernel_email_send` to dispatch a draft after reviewing.",
    schema: EmailDraftsInput,
    outputSchema: EmailListOutput,
    tags: ["email", "drafts", "list", "comms"],
    async handler({ contact_id, task_id, account_id, limit }) {
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
  });
}

// ── kernel_email_inbox_recent ─────────────────────────────────

const EmailInboxRecentInput = z.object({
  contact_id: z.string().optional(),
  account_id: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(20),
});

function buildEmailInboxRecent(service: CommsService): ToolDefinition {
  return defineTool({
    name: "kernel_email_inbox_recent",
    description:
      "List recent INBOUND emails already stored in the kernel (e.g. fetched via `kernel_email_fetch` or sync). " +
      "For live Gmail search use `kernel_email_search` instead. Reply using `from_address`.",
    schema: EmailInboxRecentInput,
    outputSchema: EmailListOutput,
    tags: ["email", "inbox", "list", "recent", "comms"],
    async handler({ contact_id, account_id, limit }) {
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
          `- ${c.id} · ${c.status} · ${wrapSubject(c) || "(no subject)"} · ${c.sent_at ?? c.created_at}`,
        ),
      ];
      return { ...textResult(lines.join("\n")), structuredContent: out };
    },
  });
}
