import { readFileSync } from "node:fs";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import type { InboxMessage } from "../types.js";
import type { EmailProvider, ProviderCapabilities, SendEmailOptions, SendResult } from "./types.js";
import { stripHtml } from "../gmail-helpers.js";

export interface ImapSmtpConfig {
  imap_host: string;
  imap_port?: number;
  imap_secure?: boolean;
  smtp_host: string;
  smtp_port?: number;
  smtp_secure?: boolean;
  user: string;
  pass: string;
  from?: string;
}

/**
 * Generic IMAP + SMTP provider. Works with any provider that speaks the standard
 * protocols (Fastmail, Zoho, ProtonMail Bridge, self-hosted docker-mailserver, etc).
 * Credentials live in email_accounts.provider_config as ImapSmtpConfig JSON.
 */
export class ImapSmtpProvider implements EmailProvider {
  readonly name = "imap_smtp";
  readonly capabilities: ProviderCapabilities = {
    send: true,
    searchInbox: true,
    fetchEmail: true,
  };

  constructor(
    private config: ImapSmtpConfig,
    private fromAddress: string,
  ) {}

  private buildImap(): ImapFlow {
    return new ImapFlow({
      host: this.config.imap_host,
      port: this.config.imap_port ?? 993,
      secure: this.config.imap_secure ?? true,
      auth: { user: this.config.user, pass: this.config.pass },
      logger: false,
    });
  }

  private buildSmtp() {
    return nodemailer.createTransport({
      host: this.config.smtp_host,
      port: this.config.smtp_port ?? 465,
      secure: this.config.smtp_secure ?? true,
      auth: { user: this.config.user, pass: this.config.pass },
    });
  }

  async send(options: SendEmailOptions): Promise<SendResult> {
    const transporter = this.buildSmtp();
    const mail: Parameters<typeof transporter.sendMail>[0] = {
      from: this.config.from || this.fromAddress,
      to: options.to,
      subject: options.subject,
      text: options.body,
    };
    if (options.cc) mail.cc = options.cc;
    if (options.bcc) mail.bcc = options.bcc;
    if (options.bodyHtml) mail.html = options.bodyHtml;
    if (options.inReplyTo) {
      mail.inReplyTo = options.inReplyTo;
      mail.references = [options.inReplyTo];
    }
    if (options.attachments?.length) {
      mail.attachments = options.attachments.map((a) => ({
        filename: a.filename,
        content: readFileSync(a.path),
        contentType: a.mimeType,
      }));
    }

    const info = await transporter.sendMail(mail);
    return { messageId: info.messageId ?? "", threadId: "" };
  }

  async searchInbox(query: string, maxResults: number): Promise<InboxMessage[]> {
    const client = this.buildImap();
    await client.connect();
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        const trimmed = query.trim();
        const search = trimmed
          ? { or: [{ subject: trimmed }, { from: trimmed }, { body: trimmed }] }
          : { all: true };
        const searchResult = await client.search(search, { uid: true });
        const uids = Array.isArray(searchResult) ? searchResult : [];
        const take = uids.slice(-Math.max(1, maxResults));

        const results: InboxMessage[] = [];
        for await (const msg of client.fetch(take, { envelope: true, uid: true, flags: true }, { uid: true })) {
          const env = msg.envelope;
          if (!env) continue;
          const from = env.from?.[0];
          const to = env.to?.[0];
          results.push({
            gmail_id: String(msg.uid),
            gmail_thread_id: "",
            from: from ? `${from.name ?? ""} <${from.address ?? ""}>`.trim() : "",
            to: to ? `${to.name ?? ""} <${to.address ?? ""}>`.trim() : "",
            subject: env.subject ?? "(no subject)",
            snippet: "",
            date: env.date ? new Date(env.date).toISOString() : "",
            labels: [...(msg.flags ?? [])],
          });
        }
        return results.reverse();
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {});
    }
  }

  async fetchEmail(messageId: string): Promise<{
    from: string; fromName: string; to: string; cc: string; subject: string;
    body: string; bodyHtml: string; date: string; messageIdHeader: string; threadId: string;
  }> {
    const client = this.buildImap();
    await client.connect();
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        const uid = Number(messageId);
        if (!Number.isFinite(uid)) throw new Error(`IMAP expects a numeric UID, got: ${messageId}`);

        const msg = await client.fetchOne(String(uid), { source: true, envelope: true, uid: true }, { uid: true });
        if (!msg) throw new Error(`IMAP message not found: ${uid}`);

        const env = msg.envelope;
        const source = msg.source ? msg.source.toString("utf-8") : "";
        const { text, html } = splitMime(source);

        const fromEntry = env?.from?.[0];
        return {
          from: fromEntry?.address ?? "",
          fromName: fromEntry?.name ?? fromEntry?.address ?? "",
          to: (env?.to ?? []).map((a) => a.address ?? "").filter(Boolean).join(", "),
          cc: (env?.cc ?? []).map((a) => a.address ?? "").filter(Boolean).join(", "),
          subject: env?.subject ?? "(no subject)",
          body: text || stripHtml(html),
          bodyHtml: html,
          date: env?.date ? new Date(env.date).toISOString() : new Date().toISOString(),
          messageIdHeader: env?.messageId ?? "",
          threadId: "",
        };
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {});
    }
  }

  async verify(): Promise<{ imap: boolean; smtp: boolean; error?: string }> {
    const result = { imap: false, smtp: false, error: undefined as string | undefined };

    try {
      const client = this.buildImap();
      await client.connect();
      await client.logout();
      result.imap = true;
    } catch (err) {
      result.error = `IMAP: ${err instanceof Error ? err.message : String(err)}`;
    }

    try {
      const transporter = this.buildSmtp();
      await transporter.verify();
      result.smtp = true;
    } catch (err) {
      const msg = `SMTP: ${err instanceof Error ? err.message : String(err)}`;
      result.error = result.error ? `${result.error}; ${msg}` : msg;
    }

    return result;
  }
}

function splitMime(raw: string): { text: string; html: string } {
  if (!raw) return { text: "", html: "" };

  const parts = raw.split(/\r?\n\r?\n/);
  if (parts.length < 2) return { text: raw, html: "" };

  const body = parts.slice(1).join("\n\n");
  const boundaryMatch = parts[0].match(/boundary="?([^";\r\n]+)"?/i);
  if (!boundaryMatch) {
    const isHtml = /content-type:\s*text\/html/i.test(parts[0]);
    return isHtml ? { text: "", html: body } : { text: body, html: "" };
  }

  const boundary = `--${boundaryMatch[1]}`;
  const segments = body.split(boundary).filter((s) => s.trim() && !s.trim().startsWith("--"));
  let text = "";
  let html = "";
  for (const seg of segments) {
    const segParts = seg.split(/\r?\n\r?\n/);
    if (segParts.length < 2) continue;
    const header = segParts[0];
    const content = segParts.slice(1).join("\n\n").trim();
    if (/content-type:\s*text\/html/i.test(header)) html = content;
    else if (/content-type:\s*text\/plain/i.test(header)) text = content;
  }
  return { text, html };
}
