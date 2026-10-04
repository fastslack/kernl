import { readFileSync } from "node:fs";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { log } from "@kernl/extension-sdk";
import type { InboxMessage } from "../types.js";
import type { EmailProvider, ProviderCapabilities, SendEmailOptions, SendResult } from "./types.js";
import { stripHtml } from "../gmail-helpers.js";
import { extractBodies } from "./mime-decode.js";

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
  /** Saved after a connect where IMAP worked and SMTP did not: receive-only. */
  read_only?: boolean;
}

export interface VerifyResult {
  imap: boolean;
  smtp: boolean;
  error?: string;
  imapError?: unknown;
  smtpError?: unknown;
}

export interface VerifyOptions {
  timeoutMs?: number;
  /** Default false: every existing caller still gets both protocols tested. */
  skipSmtpOnImapFailure?: boolean;
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

  /**
   * A server that drops packets (a firewall, a fail2ban ban) never answers, and
   * an IMAP call with no timeout then waits forever — stalling the inbox
   * fetcher for every account behind it. Search and fetch get socket timeouts
   * plus a hard deadline on the whole operation.
   */
  private readonly opTimeoutMs: number;

  constructor(
    private config: ImapSmtpConfig,
    private fromAddress: string,
    opts: { opTimeoutMs?: number } = {},
  ) {
    this.opTimeoutMs = opts.opTimeoutMs ?? 60_000;
  }

  /** Run `op` on a fresh IMAP connection; past the deadline the socket is torn down and the call rejects. */
  private async withImap<T>(op: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = this.buildImap(this.opTimeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        client.close();
        reject(new Error(`IMAP ${this.config.imap_host} did not answer within ${Math.round((this.opTimeoutMs * 2) / 1000)}s`));
      }, this.opTimeoutMs * 2);
    });
    const run = (async () => {
      await client.connect();
      try {
        return await op(client);
      } finally {
        await client.logout().catch(() => {});
      }
    })();
    run.catch(() => {}); // the deadline may win; its loser must not surface as unhandled
    try {
      return await Promise.race([run, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  private buildImap(timeoutMs?: number): ImapFlow {
    const client = new ImapFlow({
      host: this.config.imap_host,
      port: this.config.imap_port ?? 993,
      secure: this.config.imap_secure ?? true,
      auth: { user: this.config.user, pass: this.config.pass },
      logger: false,
      ...(timeoutMs ? { connectionTimeout: timeoutMs, greetingTimeout: timeoutMs, socketTimeout: timeoutMs } : {}),
    });
    // imapflow emits 'error' on a socket timeout or a dropped connection. With
    // no listener that is an uncaught exception that ends the process; the
    // pending connect()/command still rejects on its own, so a note is enough.
    client.on("error", (err: unknown) => {
      let text = err instanceof Error ? `${(err as { code?: string }).code ?? ""} ${err.message}`.trim() : String(err);
      if (this.config.pass) text = text.split(this.config.pass).join("***");
      log.debug(`Comms: IMAP connection to ${this.config.imap_host} errored: ${text}`);
    });
    return client;
  }

  private buildSmtp(timeoutMs?: number) {
    return nodemailer.createTransport({
      host: this.config.smtp_host,
      port: this.config.smtp_port ?? 465,
      secure: this.config.smtp_secure ?? true,
      auth: { user: this.config.user, pass: this.config.pass },
      ...(timeoutMs ? { connectionTimeout: timeoutMs, greetingTimeout: timeoutMs, socketTimeout: timeoutMs } : {}),
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
    return this.withImap(async (client) => {
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
    });
  }

  async fetchEmail(messageId: string): Promise<{
    from: string; fromName: string; to: string; cc: string; subject: string;
    body: string; bodyHtml: string; date: string; messageIdHeader: string; threadId: string;
    rawHeaders: Record<string, string>;
  }> {
    return this.withImap(async (client) => {
      const lock = await client.getMailboxLock("INBOX");
      try {
        const uid = Number(messageId);
        if (!Number.isFinite(uid)) throw new Error(`IMAP expects a numeric UID, got: ${messageId}`);

        const msg = await client.fetchOne(String(uid), { source: true, envelope: true, uid: true }, { uid: true });
        if (!msg) throw new Error(`IMAP message not found: ${uid}`);

        const env = msg.envelope;
        const sourceBytes = msg.source ?? Buffer.alloc(0);
        const source = sourceBytes.toString("utf-8"); // header parsing only
        // Bodies come from the bytes: each part has its own transfer encoding
        // and charset, which a UTF-8 string of the whole message cannot honour.
        const { text, html } = extractBodies(sourceBytes);
        const rawHeaders = parseHeaderBlock(source);

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
          messageIdHeader: env?.messageId ?? rawHeaders["message-id"] ?? "",
          threadId: "",
          rawHeaders,
        };
      } finally {
        lock.release();
      }
    });
  }

  /**
   * Try IMAP, then SMTP. `skipSmtpOnImapFailure` leaves SMTP untested when IMAP
   * already failed (a connect that is going to be refused anyway should not
   * wait out a second timeout).
   */
  async verify(opts: VerifyOptions = {}): Promise<VerifyResult> {
    const result: VerifyResult = { imap: false, smtp: false };

    try {
      const client = this.buildImap(opts.timeoutMs);
      await client.connect();
      await client.logout();
      result.imap = true;
    } catch (err) {
      result.imapError = err;
      result.error = `IMAP: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (!result.imap && opts.skipSmtpOnImapFailure) return result;

    try {
      const transporter = this.buildSmtp(opts.timeoutMs);
      await transporter.verify();
      result.smtp = true;
    } catch (err) {
      result.smtpError = err;
      const msg = `SMTP: ${err instanceof Error ? err.message : String(err)}`;
      result.error = result.error ? `${result.error}; ${msg}` : msg;
    }

    return result;
  }
}

// Headers the thread-safety checks (findThreadIdFromReferences, checkAutoSend)
// need. Anything else in the header block is dropped — this mailbox is not a
// place to stash arbitrary header data.
const WANTED_RAW_HEADERS = [
  "message-id",
  "in-reply-to",
  "references",
  "auto-submitted",
  "precedence",
  "list-id",
  "list-unsubscribe",
];

/**
 * Pull a handful of named headers out of a raw RFC 5322 message source
 * (as returned by IMAP's `source: true` fetch option). Unfolds continuation
 * lines (a header value that wraps onto the next line, which starts with
 * whitespace, per RFC 5322 §2.2.3) before matching, so a long References
 * header spread across several lines still parses as one value. Keys come
 * back lower-cased; only WANTED_RAW_HEADERS are kept.
 */
export function parseHeaderBlock(source: string): Record<string, string> {
  if (!source) return {};
  const headerBlock = source.split(/\r?\n\r?\n/)[0] ?? "";
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, " ");
  const wanted = new Set(WANTED_RAW_HEADERS);
  const result: Record<string, string> = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    if (!wanted.has(name)) continue;
    result[name] = line.slice(idx + 1).trim();
  }
  return result;
}

