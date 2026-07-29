import { readFileSync } from "node:fs";
import type { InboxMessage } from "../types.js";
import type { EmailProvider, ProviderCapabilities, SendEmailOptions, SendResult } from "./types.js";
import { log } from "../../../../../../src/core/logger.js";

const RESEND_API_URL = "https://api.resend.com";

export class ResendProvider implements EmailProvider {
  readonly name = "resend";
  readonly capabilities: ProviderCapabilities = {
    send: true,
    searchInbox: false,
    fetchEmail: false,
  };

  constructor(
    private apiKey: string,
    private fromAddress: string,
  ) {}

  async send(options: SendEmailOptions): Promise<SendResult> {
    const payload: Record<string, unknown> = {
      from: this.fromAddress,
      to: options.to.split(",").map((e) => e.trim()),
      subject: options.subject,
    };

    if (options.cc) {
      payload.cc = options.cc.split(",").map((e) => e.trim());
    }
    if (options.bcc) {
      payload.bcc = options.bcc.split(",").map((e) => e.trim());
    }

    // Prefer HTML if available, include text as fallback
    if (options.bodyHtml) {
      payload.html = options.bodyHtml;
      if (options.body) payload.text = options.body;
    } else {
      payload.text = options.body;
    }

    if (options.inReplyTo) {
      payload.headers = {
        "In-Reply-To": options.inReplyTo,
        "References": options.inReplyTo,
      };
    }

    // Attachments: read files and encode as base64
    if (options.attachments && options.attachments.length > 0) {
      payload.attachments = options.attachments.map((att) => ({
        filename: att.filename,
        content: readFileSync(att.path).toString("base64"),
        content_type: att.mimeType,
      }));
    }

    const response = await fetch(`${RESEND_API_URL}/emails`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      log.error(`Resend API error ${response.status}: ${text}`);
      throw new Error(`Resend send failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as { id: string };

    return {
      messageId: data.id,
      threadId: "",
    };
  }

  async searchInbox(): Promise<InboxMessage[]> {
    throw new Error("Resend does not support inbox search");
  }

  async fetchEmail(): Promise<never> {
    throw new Error("Resend does not support fetching emails");
  }
}
