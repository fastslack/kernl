/**
 * The text of a message's PDF attachments, for the agenda: a ticket or booking often says the date only in the
 * attached document (07/11: a ferry e-ticket). At most three PDFs, each under MAX_PDF_ATTACHMENT_BYTES; one that
 * fails to download or to parse is skipped. The joined text is capped so a long invoice does not crowd the mail out.
 */
import type { GmailMessagePart } from "@kernl/extension-sdk";
import { pdfAttachmentRefs } from "../../../../people/comms/_module/gmail-helpers.js";

const GMAIL_MESSAGES_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
export const MAX_PDFS_PER_MAIL = 3;
export const MAX_ATTACHMENTS_TEXT = 8_000;

export interface AttachmentClient {
  get<T>(url: string, params?: Record<string, string>): Promise<T>;
}

export async function readPdfAttachments(
  client: AttachmentClient,
  messageId: string,
  payload: GmailMessagePart,
  extract: (bytes: Uint8Array) => Promise<string>,
): Promise<string> {
  const parts: string[] = [];
  for (const ref of pdfAttachmentRefs(payload).slice(0, MAX_PDFS_PER_MAIL)) {
    try {
      const att = await client.get<{ data?: string }>(`${GMAIL_MESSAGES_URL}/${messageId}/attachments/${ref.attachmentId}`);
      if (!att?.data) continue;
      const text = (await extract(new Uint8Array(Buffer.from(att.data, "base64url")))).trim();
      if (text) parts.push(`[Adjunto: ${ref.filename}]\n${text}`);
    } catch {
      // one unreadable attachment does not stop the others
    }
  }
  return parts.join("\n\n").slice(0, MAX_ATTACHMENTS_TEXT);
}
