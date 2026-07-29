import { z } from "zod";
import type { ToolDefinition } from "../../../../../src/core/types.js";
import type { CommsService } from "./service.js";
import { textResult, errorResult } from "../../../../../src/core/helpers.js";

const channelEnum = z.enum(["email", "whatsapp", "mattermost", "x", "instagram", "linkedin"]);
const statusEnum = z.enum(["draft", "ready", "sending", "sent", "failed", "archived"]);
const accountTypeEnum = z.enum(["personal", "work", "transactional", "marketing"]);
const providerEnum = z.enum(["gmail", "resend", "imap_smtp"]);

export function commsTools(service: CommsService): ToolDefinition[] {
  return [
    {
      name: "kernel_comms_create",
      description:
        "Create a new communication draft. If contact_id is provided, auto-fills recipients from contact email. Supports email, WhatsApp, Mattermost, X, Instagram, and LinkedIn channels. " +
        "[legacy CRUD] For email send-flows prefer the agent-shaped `kernel_email_send` (one-step compose+send). Keep this tool for non-email channels or when you need a draft that won't be sent immediately.",
      inputSchema: z.object({
        channel: channelEnum.optional().describe("Communication channel (default: email)"),
        direction: z.enum(["inbound", "outbound"]).optional().describe("Direction (default: outbound)"),
        subject: z.string().optional().describe("Subject line"),
        body: z.string().optional().describe("Message body (plain text)"),
        body_html: z.string().optional().describe("Message body (HTML)"),
        contact_id: z.string().optional().describe("Contact ID — auto-fills recipient email"),
        task_id: z.string().optional().describe("Link to a task"),
        account_id: z.string().optional().describe("Email account ID to send from (uses default if omitted)"),
        in_reply_to: z.string().optional().describe("Communication ID this replies to (inherits thread)"),
        recipients_to: z.string().optional().describe("To recipients (comma-separated emails)"),
        recipients_cc: z.string().optional().describe("CC recipients"),
        recipients_bcc: z.string().optional().describe("BCC recipients"),
      }),
      handler: async (args) => {
        const input = args as {
          channel?: "email" | "whatsapp" | "mattermost" | "x" | "instagram" | "linkedin";
          direction?: "inbound" | "outbound";
          subject?: string;
          body?: string;
          body_html?: string;
          contact_id?: string;
          task_id?: string;
          account_id?: string;
          in_reply_to?: string;
          recipients_to?: string;
          recipients_cc?: string;
          recipients_bcc?: string;
        };
        const comm = service.create(input);
        return textResult(
          `Communication created:\n  ID: ${comm.id}\n  Channel: ${comm.channel}\n  Status: ${comm.status}\n  To: ${comm.recipients_to || "(none)"}\n  Subject: ${comm.subject || "(none)"}\n  Thread: ${comm.thread_id}`,
        );
      },
    },

    {
      name: "kernel_comms_classify",
      description:
        "Persist rich classification metadata on an inbound email (provenance, importance, action_required, stakeholder, topic tags). Bypasses the draft-only edit guard — only writes to metadata.classification, leaves body/status/recipients alone. Idempotent: re-classifying overwrites the previous classification block. " +
        "[legacy] Prefer `kernel_email_classify` — identical args, structured output.",
      inputSchema: z.object({
        id: z.string().describe("Communication ID (the inbound email)"),
        provenance: z.enum(["vendor", "client", "personal", "automated", "unknown"])
          .describe("Where the email comes from. 'vendor': supplier/SaaS billing/marketing; 'client': existing customer or prospect; 'personal': friends/family; 'automated': transactional/notifications/no-reply; 'unknown' when nothing else fits."),
        importance: z.enum(["critical", "high", "normal", "low"])
          .describe("Business impact. 'critical': legal/security/payment-failure/health-emergency; 'high': time-sensitive client request, contract, urgent decision; 'normal': regular correspondence; 'low': newsletters, marketing, FYI."),
        action_required: z.enum(["reply", "read", "file", "escalate", "schedule", "none"])
          .describe("What the user should do. 'reply': respond; 'read': just review (no response); 'file': archive without further action; 'escalate': hand off to another office or person; 'schedule': calendar event/RSVP; 'none': no action."),
        stakeholder_id: z.string().optional()
          .describe("CRM contact_id when the sender matches a known contact (use kernel_crm_find first). Empty when no match."),
        topic_tags: z.array(z.string()).optional()
          .describe("1-3 short tag(s) like 'client-a', 'infra', 'billing', 'newsletter-tech'. Used by the Capitán to route handoffs."),
        rationale: z.string().optional()
          .describe("One short sentence explaining your call — for audit and future re-classification."),
      }),
      handler: async (args) => {
        const a = args as {
          id: string;
          provenance?: "vendor" | "client" | "personal" | "automated" | "unknown";
          importance?: "critical" | "high" | "normal" | "low";
          action_required?: "reply" | "read" | "file" | "escalate" | "schedule" | "none";
          stakeholder_id?: string;
          topic_tags?: string[];
          rationale?: string;
        };
        const ok = service.setClassification(a.id, a);
        if (!ok) return errorResult(`Communication not found: ${a.id}`);
        return textResult(
          `Classification stored for ${a.id}:\n  provenance=${a.provenance}\n  importance=${a.importance}\n  action=${a.action_required}\n  stakeholder=${a.stakeholder_id || "(none)"}\n  topics=[${(a.topic_tags ?? []).join(", ")}]`,
        );
      },
    },

    {
      name: "kernel_comms_update",
      description:
        "Update a communication draft. Use for progressive composition: add subject, body, recipients, or change status. Only drafts and failed messages can be edited.",
      inputSchema: z.object({
        id: z.string().describe("Communication ID"),
        subject: z.string().optional().describe("Update subject"),
        body: z.string().optional().describe("Update body (plain text)"),
        body_html: z.string().optional().describe("Update body (HTML)"),
        status: statusEnum.optional().describe("Change status (e.g., draft → ready)"),
        recipients_to: z.string().optional().describe("Update To recipients"),
        recipients_cc: z.string().optional().describe("Update CC recipients"),
        recipients_bcc: z.string().optional().describe("Update BCC recipients"),
        scheduled_at: z.string().optional().describe("Schedule for later (ISO datetime)"),
        contact_id: z.string().optional().describe("Link to a contact"),
        task_id: z.string().optional().describe("Link to a task"),
        account_id: z.string().optional().describe("Change email account"),
      }),
      handler: async (args) => {
        const { id, ...changes } = args as {
          id: string;
          subject?: string;
          body?: string;
          body_html?: string;
          status?: "draft" | "ready" | "sending" | "sent" | "failed" | "archived";
          recipients_to?: string;
          recipients_cc?: string;
          recipients_bcc?: string;
          scheduled_at?: string;
          contact_id?: string;
          task_id?: string;
          account_id?: string;
        };
        const comm = service.update(id, changes);
        if (!comm) return errorResult(`Communication not found or not editable: ${id}`);
        return textResult(
          `Communication updated:\n  ID: ${comm.id}\n  Status: ${comm.status}\n  Subject: ${comm.subject || "(none)"}\n  To: ${comm.recipients_to || "(none)"}`,
        );
      },
    },

    {
      name: "kernel_comms_get",
      description:
        "Get a communication with attachments and linked contact/task details.",
      inputSchema: z.object({
        id: z.string().describe("Communication ID"),
      }),
      handler: async (args) => {
        const { id } = args as { id: string };
        const details = service.getWithDetails(id);
        if (!details) return errorResult(`Communication not found: ${id}`);

        const { comm, attachments, contact, task } = details;
        const attLines = attachments.length > 0
          ? attachments.map((a) => `  - ${a.filename} (${formatBytes(a.size_bytes)}, ${a.mime_type})`).join("\n")
          : "  (none)";

        return textResult(
          `${comm.channel.toUpperCase()} — ${comm.status}\n` +
          `  ID: ${comm.id}\n` +
          `  Direction: ${comm.direction}\n` +
          `  Subject: ${comm.subject || "(none)"}\n` +
          `  To: ${comm.recipients_to || "(none)"}\n` +
          (comm.recipients_cc ? `  CC: ${comm.recipients_cc}\n` : "") +
          (comm.recipients_bcc ? `  BCC: ${comm.recipients_bcc}\n` : "") +
          `  Contact: ${contact ? `${contact.name} (${contact.email})` : "(none)"}\n` +
          `  Task: ${task ? task.title : "(none)"}\n` +
          `  Thread: ${comm.thread_id}\n` +
          (comm.in_reply_to ? `  Reply to: ${comm.in_reply_to}\n` : "") +
          (comm.sent_at ? `  Sent: ${comm.sent_at}\n` : "") +
          (comm.error_message ? `  Error: ${comm.error_message}\n` : "") +
          `\nBody:\n${comm.body || "(empty)"}\n` +
          `\nAttachments:\n${attLines}`,
        );
      },
    },

    {
      name: "kernel_comms_list",
      description:
        "List communications with optional filters by channel, status, contact, or task. " +
        "[legacy CRUD] For email-specific listing prefer `kernel_email_drafts` (drafts) or `kernel_email_inbox_recent` (inbound emails) — they return typed results.",
      inputSchema: z.object({
        channel: channelEnum.optional().describe("Filter by channel"),
        status: statusEnum.optional().describe("Filter by status"),
        contact_id: z.string().optional().describe("Filter by contact"),
        task_id: z.string().optional().describe("Filter by task"),
        limit: z.number().optional().describe("Max results (default 50)"),
      }),
      handler: async (args) => {
        const filters = args as {
          channel?: "email" | "whatsapp" | "mattermost" | "x" | "instagram" | "linkedin";
          status?: "draft" | "ready" | "sending" | "sent" | "failed" | "archived";
          contact_id?: string;
          task_id?: string;
          limit?: number;
        };
        const comms = service.list(filters);
        if (comms.length === 0) return textResult("No communications found.");

        const lines = comms.map(
          (c) =>
            `[${c.status}] ${c.channel} — ${c.subject || "(no subject)"}\n` +
            `  To: ${c.recipients_to || "(none)"} | ${c.updated_at}\n` +
            `  ID: ${c.id}`,
        );
        return textResult(`${comms.length} communication(s):\n\n${lines.join("\n\n")}`);
      },
    },

    {
      name: "kernel_comms_attach",
      description:
        "Attach a file to a communication draft. Copies the file to ./data/attachments/{comm-id}/. Only works on drafts.",
      inputSchema: z.object({
        comm_id: z.string().describe("Communication ID"),
        file_path: z.string().describe("Absolute path to the file to attach"),
      }),
      handler: async (args) => {
        const { comm_id, file_path } = args as { comm_id: string; file_path: string };
        try {
          const att = service.attach(comm_id, file_path);
          if (!att) return errorResult(`Communication not found or not editable: ${comm_id}`);
          return textResult(
            `Attachment added:\n  File: ${att.filename}\n  Size: ${formatBytes(att.size_bytes)}\n  Type: ${att.mime_type}\n  ID: ${att.id}`,
          );
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },

    {
      name: "kernel_comms_remove_attachment",
      description: "Remove an attachment from a communication.",
      inputSchema: z.object({
        id: z.string().describe("Attachment ID"),
      }),
      handler: async (args) => {
        const { id } = args as { id: string };
        const removed = service.removeAttachment(id);
        if (!removed) return errorResult(`Attachment not found: ${id}`);
        return textResult("Attachment removed.");
      },
    },

    {
      name: "kernel_comms_send",
      description:
        "Send an existing communication draft (by id). Supports email (Gmail/Resend) and WhatsApp channels. " +
        "For email: requires configured email provider. For WhatsApp: requires WHATSAPP_ENABLED and QR pairing. " +
        "Recipients_to must contain email addresses (email) or phone number (WhatsApp). " +
        "Automatically logs interaction in CRM. " +
        "[legacy CRUD] For email, prefer `kernel_email_send` — it composes + sends in one call without needing a pre-created draft id.",
      inputSchema: z.object({
        id: z.string().describe("Communication ID to send"),
      }),
      handler: async (args) => {
        const { id } = args as { id: string };
        try {
          const comm = service.getById(id);
          if (!comm) return errorResult(`Communication not found: ${id}`);

          if (comm.channel === "whatsapp") {
            const sent = await service.sendWhatsApp(id);
            return textResult(
              `WhatsApp sent!\n  ID: ${sent.id}\n  To: ${sent.recipients_to}\n  Sent at: ${sent.sent_at}`,
            );
          }

          if (comm.channel === "email") {
            const sent = await service.sendEmail(id);
            return textResult(
              `Email sent!\n  ID: ${sent.id}\n  Gmail ID: ${sent.gmail_message_id}\n  Sent at: ${sent.sent_at}`,
            );
          }

          return errorResult(`Channel "${comm.channel}" does not support sending yet. Supported: email, whatsapp.`);
        } catch (err) {
          return errorResult(`Send failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },

    {
      name: "kernel_comms_thread",
      description:
        "View all messages in a communication thread, ordered chronologically. " +
        "[legacy] Prefer `kernel_email_thread` — structured output (messages[].body) lets `kernel_code_run` walk the thread programmatically.",
      inputSchema: z.object({
        thread_id: z.string().describe("Thread ID (same as the first message's ID in the thread)"),
      }),
      handler: async (args) => {
        const { thread_id } = args as { thread_id: string };
        const comms = service.getThread(thread_id);
        if (comms.length === 0) return textResult("No messages in this thread.");

        const lines = comms.map(
          (c, i) =>
            `${i + 1}. [${c.status}] ${c.direction} — ${c.subject || "(no subject)"}\n` +
            `   To: ${c.recipients_to || "(none)"}\n` +
            `   ${c.body ? c.body.slice(0, 100) + (c.body.length > 100 ? "..." : "") : "(empty)"}\n` +
            `   ${c.sent_at ? `Sent: ${c.sent_at}` : `Created: ${c.created_at}`}\n` +
            `   ID: ${c.id}`,
        );
        return textResult(`Thread ${thread_id} — ${comms.length} message(s):\n\n${lines.join("\n\n")}`);
      },
    },

    // ── Gmail Inbox ──────────────────────────────────

    {
      name: "kernel_comms_search_inbox",
      description:
        "Search Gmail inbox using Gmail query syntax. Returns message summaries with sender, subject, date, and snippet. " +
        "Examples: 'is:important newer_than:7d', 'from:john subject:invoice', 'is:unread label:important'. " +
        "[legacy] Prefer the agent-shaped `kernel_email_search` — same capability with structured (typed) output for code_run composition.",
      inputSchema: z.object({
        query: z.string().describe("Gmail search query (same syntax as Gmail search bar)"),
        max_results: z.number().optional().describe("Max results to return (default 10, max 20)"),
        account_id: z.string().optional().describe("Email account ID to search (uses default if omitted)"),
      }),
      handler: async (args) => {
        const { query, max_results, account_id } = args as { query: string; max_results?: number; account_id?: string };
        try {
          const messages = await service.searchInbox(query, Math.min(max_results ?? 10, 20), account_id);
          if (messages.length === 0) return textResult("No emails found matching the query.");

          const lines = messages.map(
            (m, i) =>
              `${i + 1}. ${m.subject}\n` +
              `   From: ${m.from}\n` +
              `   Date: ${m.date}\n` +
              `   ${m.snippet.slice(0, 120)}${m.snippet.length > 120 ? "..." : ""}\n` +
              `   Gmail ID: ${m.gmail_id} | Thread: ${m.gmail_thread_id}` +
              (m.labels.length > 0 ? `\n   Labels: ${m.labels.join(", ")}` : ""),
          );
          return textResult(`Found ${messages.length} email(s):\n\n${lines.join("\n\n")}`);
        } catch (err) {
          return errorResult(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },

    {
      name: "kernel_comms_fetch_email",
      description:
        "Fetch a specific email from Gmail and store it as an inbound communication. " +
        "Extracts full body text, HTML, headers, and matches sender to CRM contacts. " +
        "Use the Gmail ID from search_inbox results. Deduplicates automatically. " +
        "[legacy] Prefer `kernel_email_fetch` — same behavior with structured output.",
      inputSchema: z.object({
        gmail_message_id: z.string().describe("Gmail message ID (from search_inbox results)"),
        account_id: z.string().optional().describe("Email account ID (uses default if omitted)"),
      }),
      handler: async (args) => {
        const { gmail_message_id, account_id } = args as { gmail_message_id: string; account_id?: string };
        try {
          const comm = await service.fetchEmail(gmail_message_id, account_id);
          const meta = JSON.parse(comm.metadata || "{}");
          return textResult(
            `Email fetched and stored:\n` +
            `  ID: ${comm.id}\n` +
            `  From: ${meta.from_name || meta.from || "(unknown)"} <${meta.from || ""}>\n` +
            `  To: ${comm.recipients_to}\n` +
            `  Subject: ${comm.subject}\n` +
            `  Date: ${comm.sent_at}\n` +
            `  Contact: ${comm.contact_id || "(no CRM match)"}\n` +
            `  Gmail Thread: ${comm.gmail_thread_id}\n` +
            `\nBody:\n${comm.body || "(empty)"}`,
          );
        } catch (err) {
          return errorResult(`Fetch failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },

    {
      name: "kernel_comms_reply",
      description:
        "Create a reply draft from an existing communication. Automatically sets up: " +
        "Re: subject, correct recipients (sender for inbound, same recipients for outbound), " +
        "Gmail thread ID for proper threading, and optional quoted original text. " +
        "After creating, use kernel_comms_update to refine the body, then kernel_comms_send to send.",
      inputSchema: z.object({
        comm_id: z.string().describe("Communication ID to reply to (from fetch_email or existing comm)"),
        body: z.string().optional().describe("Initial reply body text (can be refined later with update)"),
        include_quote: z.boolean().optional().describe("Include quoted original in body (default: true)"),
        cc: z.string().optional().describe("CC recipients (comma-separated)"),
        reply_all: z.boolean().optional().describe("Include original CC recipients (default: false)"),
      }),
      handler: async (args) => {
        const { comm_id, body, include_quote, cc, reply_all } = args as {
          comm_id: string;
          body?: string;
          include_quote?: boolean;
          cc?: string;
          reply_all?: boolean;
        };
        try {
          const reply = service.createReply(comm_id, { body, include_quote, cc, reply_all });
          const parent = service.getById(comm_id);
          const parentMeta = JSON.parse(parent?.metadata || "{}");

          let output =
            `Reply draft created:\n` +
            `  ID: ${reply.id}\n` +
            `  To: ${reply.recipients_to || "(none)"}\n` +
            (reply.recipients_cc ? `  CC: ${reply.recipients_cc}\n` : "") +
            `  Subject: ${reply.subject}\n` +
            `  Thread: ${reply.thread_id}\n` +
            `  Gmail Thread: ${reply.gmail_thread_id}\n` +
            `  Status: draft`;

          if (parent) {
            output +=
              `\n\nOriginal message:\n` +
              `  From: ${parentMeta.from_name || parentMeta.from || parent.recipients_to}\n` +
              `  Date: ${parent.sent_at || parent.created_at}\n` +
              `  Subject: ${parent.subject}\n` +
              `  Body preview: ${(parent.body || "").slice(0, 300)}${(parent.body || "").length > 300 ? "..." : ""}`;
          }

          output += `\n\nNext: use kernel_comms_update to set/refine the reply body, then kernel_comms_send to send.`;
          return textResult(output);
        } catch (err) {
          return errorResult(`Reply failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },

    // ── Email Accounts ──────────────────────────────

    {
      name: "kernel_comms_add_account",
      description:
        "Add an email account for sending/receiving. Supports Gmail (OAuth) and Resend (API key) providers. " +
        "First account added is automatically set as default.",
      inputSchema: z.object({
        label: z.string().describe("Display label (e.g., 'Personal Gmail', 'Work Resend')"),
        email: z.string().describe("Email address for this account"),
        type: accountTypeEnum.optional().describe("Account type (default: personal)"),
        provider: providerEnum.optional().describe("Email provider (default: gmail)"),
        company: z.string().optional().describe("Company name for signature"),
        signature: z.string().optional().describe("Email signature text"),
        provider_config: z.record(z.unknown()).optional().describe("Provider-specific config (e.g., { api_key: '...' } for Resend)"),
        is_default: z.boolean().optional().describe("Set as default account"),
      }),
      handler: async (args) => {
        const input = args as {
          label: string;
          email: string;
          type?: "personal" | "work" | "transactional" | "marketing";
          provider?: "gmail" | "resend" | "imap_smtp";
          company?: string;
          signature?: string;
          provider_config?: Record<string, unknown>;
          is_default?: boolean;
        };
        try {
          const account = service.addAccount(input);
          return textResult(
            `Email account added:\n` +
            `  ID: ${account.id}\n` +
            `  Label: ${account.label}\n` +
            `  Email: ${account.email}\n` +
            `  Provider: ${account.provider}\n` +
            `  Type: ${account.type}\n` +
            `  Default: ${account.is_default ? "yes" : "no"}`,
          );
        } catch (err) {
          return errorResult(`Add account failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },

    {
      name: "kernel_comms_list_accounts",
      description: "List all configured email accounts with their provider and default status.",
      inputSchema: z.object({}),
      handler: async () => {
        const accounts = service.listAccounts();
        if (accounts.length === 0) return textResult("No email accounts configured.");

        const lines = accounts.map(
          (a) =>
            `${a.is_default ? "[DEFAULT] " : ""}${a.label}\n` +
            `  Email: ${a.email}\n` +
            `  Provider: ${a.provider} | Type: ${a.type}\n` +
            (a.company ? `  Company: ${a.company}\n` : "") +
            `  ID: ${a.id}`,
        );
        return textResult(`${accounts.length} email account(s):\n\n${lines.join("\n\n")}`);
      },
    },

    {
      name: "kernel_comms_update_account",
      description: "Update an email account's settings.",
      inputSchema: z.object({
        id: z.string().describe("Account ID"),
        label: z.string().optional().describe("Update display label"),
        email: z.string().optional().describe("Update email address"),
        type: accountTypeEnum.optional().describe("Update account type"),
        company: z.string().optional().describe("Update company name"),
        signature: z.string().optional().describe("Update email signature"),
        provider_config: z.string().optional().describe("Update provider config (JSON string)"),
        is_default: z.boolean().optional().describe("Set as default account"),
      }),
      handler: async (args) => {
        const { id, is_default, provider_config, ...rest } = args as {
          id: string;
          label?: string;
          email?: string;
          type?: "personal" | "work" | "transactional" | "marketing";
          company?: string;
          signature?: string;
          provider_config?: string;
          is_default?: boolean;
        };
        const changes: Record<string, unknown> = { ...rest };
        if (is_default !== undefined) changes.is_default = is_default ? 1 : 0;
        if (provider_config !== undefined) changes.provider_config = provider_config;

        const account = service.updateAccount(id, changes as Parameters<typeof service.updateAccount>[1]);
        if (!account) return errorResult(`Account not found: ${id}`);
        return textResult(
          `Account updated:\n` +
          `  ID: ${account.id}\n` +
          `  Label: ${account.label}\n` +
          `  Email: ${account.email}\n` +
          `  Default: ${account.is_default ? "yes" : "no"}`,
        );
      },
    },

    {
      name: "kernel_comms_delete_account",
      description: "Delete an email account. Communications linked to this account will be unlinked.",
      inputSchema: z.object({
        id: z.string().describe("Account ID to delete"),
      }),
      handler: async (args) => {
        const { id } = args as { id: string };
        const deleted = service.deleteAccount(id);
        if (!deleted) return errorResult(`Account not found: ${id}`);
        return textResult("Email account deleted. Linked communications have been unlinked.");
      },
    },

    {
      name: "kernel_comms_test_account",
      description:
        "Probe an email account's credentials to confirm they work. " +
        "Gmail: runs a 1-item inbox search against the OAuth session. " +
        "Resend: hits GET /domains with the API key. " +
        "IMAP/SMTP: connects to both servers and verifies the handshake.",
      inputSchema: z.object({
        id: z.string().describe("Account ID to test"),
      }),
      handler: async (args) => {
        const { id } = args as { id: string };
        try {
          const result = await service.testAccount(id);
          const detailStr = Object.entries(result.details)
            .filter(([, v]) => v !== "" && v !== undefined)
            .map(([k, v]) => `  ${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
            .join("\n");
          return textResult(
            `Account test — ${result.ok ? "OK" : "FAILED"}\n` +
            `  Provider: ${result.provider}\n` +
            (detailStr ? `${detailStr}\n` : ""),
          );
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ── Templates ──────────────────────────────────

    {
      name: "kernel_comms_create_template",
      description:
        "Create an email template with {{variable}} placeholders. " +
        "Built-in variables: {{name}}, {{first_name}}, {{email}}, {{company}}. " +
        "Variables are auto-detected from subject and body.",
      inputSchema: z.object({
        name: z.string().describe("Template name"),
        subject: z.string().optional().describe("Email subject (supports {{variables}})"),
        body: z.string().optional().describe("Email body plain text (supports {{variables}})"),
        body_html: z.string().optional().describe("Email body HTML (supports {{variables}})"),
        category: z.string().optional().describe("Category (default: general)"),
        account_id: z.string().optional().describe("Default account for this template"),
      }),
      handler: async (args) => {
        const input = args as {
          name: string; subject?: string; body?: string; body_html?: string;
          category?: string; account_id?: string;
        };
        const template = service.createTemplate(input);
        const vars = JSON.parse(template.variables) as string[];
        return textResult(
          `Template created:\n` +
          `  ID: ${template.id}\n` +
          `  Name: ${template.name}\n` +
          `  Category: ${template.category}\n` +
          `  Variables: ${vars.length > 0 ? vars.join(", ") : "(none)"}`,
        );
      },
    },

    {
      name: "kernel_comms_list_templates",
      description: "List email templates, optionally filtered by category.",
      inputSchema: z.object({
        category: z.string().optional().describe("Filter by category"),
      }),
      handler: async (args) => {
        const { category } = args as { category?: string };
        const templates = service.listTemplates(category);
        if (templates.length === 0) return textResult("No templates found.");

        const lines = templates.map((t) => {
          const vars = JSON.parse(t.variables) as string[];
          return `${t.name} [${t.category}]\n` +
            `  Subject: ${t.subject || "(empty)"}\n` +
            `  Variables: ${vars.length > 0 ? vars.join(", ") : "(none)"}\n` +
            `  ID: ${t.id}`;
        });
        return textResult(`${templates.length} template(s):\n\n${lines.join("\n\n")}`);
      },
    },

    {
      name: "kernel_comms_get_template",
      description: "Get a template with full content and detected variables.",
      inputSchema: z.object({
        id: z.string().describe("Template ID"),
      }),
      handler: async (args) => {
        const { id } = args as { id: string };
        const template = service.getTemplate(id);
        if (!template) return errorResult(`Template not found: ${id}`);

        const vars = JSON.parse(template.variables) as string[];
        return textResult(
          `Template: ${template.name}\n` +
          `  Category: ${template.category}\n` +
          `  Variables: ${vars.length > 0 ? vars.join(", ") : "(none)"}\n` +
          `  Account: ${template.account_id || "(default)"}\n` +
          `\nSubject: ${template.subject}\n` +
          `\nBody:\n${template.body || "(empty)"}\n` +
          (template.body_html ? `\nHTML:\n${template.body_html}` : ""),
        );
      },
    },

    {
      name: "kernel_comms_update_template",
      description: "Update a template's content or settings.",
      inputSchema: z.object({
        id: z.string().describe("Template ID"),
        name: z.string().optional().describe("Update name"),
        subject: z.string().optional().describe("Update subject"),
        body: z.string().optional().describe("Update body"),
        body_html: z.string().optional().describe("Update HTML body"),
        category: z.string().optional().describe("Update category"),
        account_id: z.string().optional().describe("Update default account"),
      }),
      handler: async (args) => {
        const { id, ...changes } = args as {
          id: string; name?: string; subject?: string; body?: string;
          body_html?: string; category?: string; account_id?: string;
        };
        const template = service.updateTemplate(id, changes);
        if (!template) return errorResult(`Template not found: ${id}`);
        return textResult(`Template updated: ${template.name} (${template.id})`);
      },
    },

    {
      name: "kernel_comms_delete_template",
      description: "Delete an email template.",
      inputSchema: z.object({
        id: z.string().describe("Template ID"),
      }),
      handler: async (args) => {
        const { id } = args as { id: string };
        const deleted = service.deleteTemplate(id);
        if (!deleted) return errorResult(`Template not found: ${id}`);
        return textResult("Template deleted.");
      },
    },

    {
      name: "kernel_comms_preview_template",
      description:
        "Preview a template rendered with sample data. " +
        "Provide variable values to see how the email will look for a specific recipient.",
      inputSchema: z.object({
        template_id: z.string().describe("Template ID"),
        variables: z.record(z.string()).optional().describe("Variable values, e.g. { name: 'Alice', company: 'Acme' }"),
      }),
      handler: async (args) => {
        const { template_id, variables } = args as { template_id: string; variables?: Record<string, string> };
        const preview = service.previewTemplate(template_id, variables ?? {});
        if (!preview) return errorResult(`Template not found: ${template_id}`);
        return textResult(
          `Preview:\n\nSubject: ${preview.subject}\n\nBody:\n${preview.body}` +
          (preview.bodyHtml ? `\n\nHTML:\n${preview.bodyHtml}` : ""),
        );
      },
    },

    // ── Campaigns ──────────────────────────────────

    {
      name: "kernel_comms_create_campaign",
      description:
        "Create an email campaign from a template. " +
        "After creating, add recipients with kernel_comms_add_recipients, then send with kernel_comms_send_campaign.",
      inputSchema: z.object({
        name: z.string().describe("Campaign name"),
        template_id: z.string().optional().describe("Template ID to use"),
        account_id: z.string().optional().describe("Email account to send from"),
        subject_override: z.string().optional().describe("Override template subject"),
        scheduled_at: z.string().optional().describe("Schedule for later (ISO datetime)"),
      }),
      handler: async (args) => {
        const input = args as {
          name: string; template_id?: string; account_id?: string;
          subject_override?: string; scheduled_at?: string;
        };
        const campaign = service.createCampaign(input);
        return textResult(
          `Campaign created:\n` +
          `  ID: ${campaign.id}\n` +
          `  Name: ${campaign.name}\n` +
          `  Status: ${campaign.status}\n` +
          `  Template: ${campaign.template_id || "(none)"}\n` +
          `  Account: ${campaign.account_id || "(default)"}\n` +
          `\nNext: add recipients, then send.`,
        );
      },
    },

    {
      name: "kernel_comms_list_campaigns",
      description: "List email campaigns with status and send progress.",
      inputSchema: z.object({
        status: z.enum(["draft", "sending", "sent", "paused", "cancelled"]).optional().describe("Filter by status"),
      }),
      handler: async (args) => {
        const { status } = args as { status?: string };
        const campaigns = service.listCampaigns(status);
        if (campaigns.length === 0) return textResult("No campaigns found.");

        const lines = campaigns.map((c) =>
          `[${c.status}] ${c.name}\n` +
          `  Recipients: ${c.total_recipients} | Sent: ${c.sent_count} | Failed: ${c.failed_count}\n` +
          (c.completed_at ? `  Completed: ${c.completed_at}\n` : "") +
          `  ID: ${c.id}`,
        );
        return textResult(`${campaigns.length} campaign(s):\n\n${lines.join("\n\n")}`);
      },
    },

    {
      name: "kernel_comms_get_campaign",
      description: "Get campaign details with recipient list and send progress.",
      inputSchema: z.object({
        id: z.string().describe("Campaign ID"),
      }),
      handler: async (args) => {
        const { id } = args as { id: string };
        const campaign = service.getCampaign(id);
        if (!campaign) return errorResult(`Campaign not found: ${id}`);

        const recipients = service.getCampaignRecipients(id);
        const recipientLines = recipients.slice(0, 50).map((r) =>
          `  [${r.status}] ${r.name || r.email} <${r.email}>${r.error_message ? ` — ${r.error_message}` : ""}`,
        );
        const moreCount = recipients.length > 50 ? `\n  ... and ${recipients.length - 50} more` : "";

        return textResult(
          `Campaign: ${campaign.name}\n` +
          `  Status: ${campaign.status}\n` +
          `  Template: ${campaign.template_id || "(none)"}\n` +
          `  Account: ${campaign.account_id || "(default)"}\n` +
          `  Subject: ${campaign.subject_override || "(from template)"}\n` +
          `  Total: ${campaign.total_recipients} | Sent: ${campaign.sent_count} | Failed: ${campaign.failed_count}\n` +
          (campaign.started_at ? `  Started: ${campaign.started_at}\n` : "") +
          (campaign.completed_at ? `  Completed: ${campaign.completed_at}\n` : "") +
          `\nRecipients (${recipients.length}):\n${recipientLines.join("\n")}${moreCount}`,
        );
      },
    },

    {
      name: "kernel_comms_add_recipients",
      description:
        "Add recipients to a draft campaign. Can add by email list or from CRM contacts. " +
        "Duplicates are automatically skipped.",
      inputSchema: z.object({
        campaign_id: z.string().describe("Campaign ID"),
        recipients: z.array(z.object({
          email: z.string().describe("Recipient email"),
          name: z.string().optional().describe("Recipient name"),
          contact_id: z.string().optional().describe("CRM contact ID"),
          variables: z.record(z.string()).optional().describe("Per-recipient template variables"),
        })).optional().describe("List of recipients to add"),
        from_contacts: z.object({
          relationship: z.string().optional().describe("Filter by relationship (personal, professional, family, acquaintance)"),
          company: z.string().optional().describe("Filter by company name"),
        }).optional().describe("Add recipients from CRM contacts matching filters"),
      }),
      handler: async (args) => {
        const { campaign_id, recipients, from_contacts } = args as {
          campaign_id: string;
          recipients?: Array<{ email: string; name?: string; contact_id?: string; variables?: Record<string, string> }>;
          from_contacts?: { relationship?: string; company?: string };
        };
        try {
          let result = { added: 0, skipped: 0 };

          if (recipients && recipients.length > 0) {
            result = service.addRecipients(campaign_id, recipients);
          } else if (from_contacts) {
            result = service.addRecipientsFromContacts(campaign_id, from_contacts);
          } else {
            return errorResult("Provide either 'recipients' list or 'from_contacts' filter");
          }

          const campaign = service.getCampaign(campaign_id);
          return textResult(
            `Recipients added: ${result.added} | Skipped (duplicate): ${result.skipped}\n` +
            `Total campaign recipients: ${campaign?.total_recipients ?? 0}`,
          );
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },

    {
      name: "kernel_comms_send_campaign",
      description:
        "Send a campaign to all pending recipients. " +
        "Each recipient gets a personalized email via the campaign's template. " +
        "Creates individual communication records for tracking. " +
        "Can be resumed if paused — only sends to pending recipients.",
      inputSchema: z.object({
        campaign_id: z.string().describe("Campaign ID to send"),
      }),
      handler: async (args) => {
        const { campaign_id } = args as { campaign_id: string };
        try {
          const result = await service.sendCampaign(campaign_id);
          const campaign = service.getCampaign(campaign_id);
          return textResult(
            `Campaign "${campaign?.name}" ${campaign?.status === "sent" ? "completed" : "in progress"}:\n` +
            `  Sent: ${result.sent}\n` +
            `  Failed: ${result.failed}\n` +
            `  Total: ${result.total}`,
          );
        } catch (err) {
          return errorResult(`Campaign send failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },
  ];
}

export function commsTriageTools(service: CommsService, db: import("../../../../../src/core/db/sqlite.js").SqliteDb, config: { openaiApiKey: string; anthropicApiKey: string; defaultProvider?: string }): ToolDefinition[] {
  return [
    {
      name: "kernel_comms_enrich_draft",
      description:
        "Enrich an email draft with additional data. The AI will intelligently incorporate " +
        "the provided content into the draft body. Use this when the user wants to add data, " +
        "images, or context to an auto-generated or manual draft reply.",
      inputSchema: z.object({
        comm_id: z.string().describe("Draft communication ID"),
        content: z.string().describe("Content to incorporate (text, data, instructions)"),
        instruction: z.string().optional().describe("How to incorporate the content (e.g., 'add as bullet points', 'weave into second paragraph')"),
      }),
      handler: async (args) => {
        const { comm_id, content, instruction } = args as {
          comm_id: string; content: string; instruction?: string;
        };

        if (!config.openaiApiKey && !config.anthropicApiKey) return errorResult("No LLM API key configured (set OpenAI or Anthropic key)");

        const details = service.getWithDetails(comm_id);
        if (!details) return errorResult(`Communication not found: ${comm_id}`);
        if (details.comm.status !== "draft") return errorResult("Only drafts can be enriched");

        // Get original email context if this is a reply
        let originalContext = "";
        if (details.comm.gmail_thread_id) {
          try {
            const meta = JSON.parse(details.comm.metadata || "{}");
            if (meta.source_gmail_id) {
              const original = db.prepare(
                "SELECT subject, from_email, from_name, body_text FROM google_emails WHERE gmail_id = ?"
              ).get(meta.source_gmail_id) as { subject: string; from_email: string; from_name: string; body_text: string } | undefined;
              if (original) {
                originalContext = `\n\nOriginal email (for context):\nFrom: ${original.from_name || original.from_email}\nSubject: ${original.subject}\n${original.body_text.slice(0, 1000)}`;
              }
            }
          } catch { /* ignore */ }
        }

        const systemPrompt = `You are an email drafting assistant. The user wants to enrich an existing email draft with new content.
Update the draft body to naturally incorporate the new content. Keep the existing tone and structure.
Output ONLY the complete updated draft body text. No explanations, no markdown fences.`;

        const userMessage = `Current draft body:
${details.comm.body}

---
New content to incorporate:
${content}
${instruction ? `\nInstruction: ${instruction}` : ""}${originalContext}`;

        try {
          const { llm } = await import("../../../../../src/core/llm/client.js");
          const result = await llm().chat({ system: systemPrompt, user: userMessage, caller: "comms:draft-update" });
          const newBody = result.text;
          if (!newBody) return errorResult("LLM returned empty response");

          service.update(comm_id, { body: newBody });

          return textResult(
            `Draft enriched successfully.\n\nUpdated body:\n${newBody}`,
          );
        } catch (err) {
          return errorResult(`Enrichment failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },
  ];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
