import type { GoogleClient } from "../../../../integration/google-sync/_module/google-client.js";
import type { GmailMessageFull, GmailMessageDetail } from "../../../../../../src/core/integrations/google-types.js";
import type { InboxMessage } from "../types.js";
import type { EmailProvider, ProviderCapabilities, SendEmailOptions, SendResult } from "./types.js";
import { buildMimeMessage } from "../mime-builder.js";
import {
  parseEmailAddress,
  parseEmailName,
  extractHeader,
  extractGmailBody,
  stripHtml,
} from "../gmail-helpers.js";

const GMAIL_MESSAGES_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";

export class GmailProvider implements EmailProvider {
  readonly name = "gmail";
  readonly capabilities: ProviderCapabilities = {
    send: true,
    searchInbox: true,
    fetchEmail: true,
  };

  constructor(private client: GoogleClient) {}

  async send(options: SendEmailOptions): Promise<SendResult> {
    const raw = buildMimeMessage({
      to: options.to,
      cc: options.cc,
      bcc: options.bcc,
      subject: options.subject,
      body: options.body,
      bodyHtml: options.bodyHtml,
      inReplyTo: options.inReplyTo,
      attachments: options.attachments,
    });

    const sendPayload: { raw: string; threadId?: string } = { raw };
    if (options.threadId) {
      sendPayload.threadId = options.threadId;
    }

    const response = await this.client.post<{ id: string; threadId: string }>(
      GMAIL_MESSAGES_URL + "/send",
      sendPayload,
    );

    return {
      messageId: response.id ?? "",
      threadId: response.threadId ?? "",
    };
  }

  async searchInbox(query: string, maxResults: number): Promise<InboxMessage[]> {
    const listResponse = await this.client.get<{
      messages?: Array<{ id: string; threadId: string }>;
    }>(GMAIL_MESSAGES_URL, {
      q: query,
      maxResults: String(maxResults),
    });

    const messages = listResponse.messages ?? [];
    if (messages.length === 0) return [];

    const results = await Promise.allSettled(
      messages.map(async (msg) => {
        const detail = await this.client.get<GmailMessageDetail & { snippet?: string; labelIds?: string[] }>(
          `${GMAIL_MESSAGES_URL}/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
        );

        const headers = detail.payload?.headers ?? [];
        const dateStr = extractHeader(headers, "Date");

        return {
          gmail_id: msg.id,
          gmail_thread_id: msg.threadId,
          from: extractHeader(headers, "From"),
          to: extractHeader(headers, "To"),
          subject: extractHeader(headers, "Subject") || "(no subject)",
          snippet: (detail as { snippet?: string }).snippet ?? "",
          date: dateStr ? new Date(dateStr).toISOString() : "",
          labels: (detail as { labelIds?: string[] }).labelIds ?? [],
        } satisfies InboxMessage;
      }),
    );

    return results
      .filter((r): r is PromiseFulfilledResult<InboxMessage> => r.status === "fulfilled")
      .map((r) => r.value);
  }

  async fetchEmail(messageId: string): Promise<{
    from: string;
    fromName: string;
    to: string;
    cc: string;
    subject: string;
    body: string;
    bodyHtml: string;
    date: string;
    messageIdHeader: string;
    threadId: string;
  }> {
    const msg = await this.client.get<GmailMessageFull>(
      `${GMAIL_MESSAGES_URL}/${messageId}?format=full`,
    );

    const headers = msg.payload?.headers ?? [];
    const fromHeader = extractHeader(headers, "From");
    const toHeader = extractHeader(headers, "To");
    const ccHeader = extractHeader(headers, "Cc");
    const subject = extractHeader(headers, "Subject") || "(no subject)";
    const dateStr = extractHeader(headers, "Date");
    const messageIdHeader = extractHeader(headers, "Message-ID") || extractHeader(headers, "Message-Id");

    const fromEmail = parseEmailAddress(fromHeader);
    const fromName = parseEmailName(fromHeader) || fromEmail;

    const { text, html } = extractGmailBody(msg.payload);
    const bodyText = text || stripHtml(html);

    const date = dateStr ? new Date(dateStr).toISOString() : new Date().toISOString();

    return {
      from: fromEmail,
      fromName,
      to: toHeader,
      cc: ccHeader,
      subject,
      body: bodyText,
      bodyHtml: html,
      date,
      messageIdHeader,
      threadId: msg.threadId,
    };
  }
}
