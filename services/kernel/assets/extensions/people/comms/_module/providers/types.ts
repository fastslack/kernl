import type { InboxMessage, Communication } from "../types.js";

export interface SendEmailOptions {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  bodyHtml?: string;
  inReplyTo?: string;
  threadId?: string;
  attachments?: Array<{
    filename: string;
    mimeType: string;
    path: string;
  }>;
}

export interface SendResult {
  messageId: string;
  threadId: string;
}

export interface ProviderCapabilities {
  send: boolean;
  searchInbox: boolean;
  fetchEmail: boolean;
}

export interface EmailProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;

  send(options: SendEmailOptions): Promise<SendResult>;
  searchInbox(query: string, maxResults: number): Promise<InboxMessage[]>;
  fetchEmail(messageId: string): Promise<{
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
    /**
     * Raw headers relevant to threading and auto-send safety checks
     * (Message-ID, In-Reply-To, References, Auto-Submitted, Precedence,
     * List-Id, List-Unsubscribe), lower-cased keys. Optional so a provider
     * that doesn't expose them cheaply (or at all) keeps compiling —
     * CommsService.fetchEmail treats a missing value as "no headers".
     */
    rawHeaders?: Record<string, string>;
  }>;
}
