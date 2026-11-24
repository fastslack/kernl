import type { MailPart } from "./mime-decode.js";
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
  /** Extra headers (e.g. List-Unsubscribe). Values must be header-safe: no CR/LF. */
  headers?: Record<string, string>;
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
  /** Can move a message between folders (moveMessage). */
  move?: boolean;
}

/** A message to move: its UID in `from`, or its Message-ID header when the UID is unknown. */
export interface MoveRef {
  uid?: string;
  messageId?: string;
}

/** Where a moved message landed. `uid` is "" when the server could not say. */
export interface MoveResult {
  folder: string;
  uid: string;
}

export interface EmailProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;

  send(options: SendEmailOptions): Promise<SendResult>;
  searchInbox(query: string, maxResults: number): Promise<InboxMessage[]>;
  /**
   * Move one message from `from` (default INBOX) to `to`. `to` is a folder
   * path, or "junk" for the server's spam folder and "inbox" for INBOX.
   */
  moveMessage?(ref: MoveRef, to: string, from?: string): Promise<MoveResult>;
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
    /** Attachments and inline images with their bytes. Only the IMAP provider decodes them today. */
    attachments?: MailPart[];
  }>;
}
