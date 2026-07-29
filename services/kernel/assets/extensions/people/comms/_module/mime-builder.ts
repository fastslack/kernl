import { readFileSync } from "node:fs";

export interface MimeOptions {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  bodyHtml?: string;
  inReplyTo?: string;
  attachments?: Array<{
    filename: string;
    mimeType: string;
    path: string;
  }>;
}

/**
 * Build an RFC 2822 MIME message and return it as a base64url-encoded string
 * suitable for the Gmail API `messages.send` endpoint.
 */
export function buildMimeMessage(options: MimeOptions): string {
  const boundary = `Kernl_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const hasHtml = !!options.bodyHtml;
  const hasAttachments = options.attachments && options.attachments.length > 0;

  const lines: string[] = [];

  // Headers
  lines.push(`To: ${options.to}`);
  if (options.cc) lines.push(`Cc: ${options.cc}`);
  if (options.bcc) lines.push(`Bcc: ${options.bcc}`);
  lines.push(`Subject: ${encodeSubject(options.subject)}`);
  lines.push("MIME-Version: 1.0");
  if (options.inReplyTo) {
    lines.push(`In-Reply-To: ${options.inReplyTo}`);
    lines.push(`References: ${options.inReplyTo}`);
  }

  if (hasAttachments) {
    // multipart/mixed wraps everything
    lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    lines.push("");

    // Body part
    lines.push(`--${boundary}`);
    if (hasHtml) {
      const altBoundary = `${boundary}_alt`;
      lines.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
      lines.push("");

      // Plain text
      lines.push(`--${altBoundary}`);
      lines.push("Content-Type: text/plain; charset=UTF-8");
      lines.push("Content-Transfer-Encoding: base64");
      lines.push("");
      lines.push(toBase64(options.body));
      lines.push("");

      // HTML
      lines.push(`--${altBoundary}`);
      lines.push("Content-Type: text/html; charset=UTF-8");
      lines.push("Content-Transfer-Encoding: base64");
      lines.push("");
      lines.push(toBase64(options.bodyHtml!));
      lines.push("");

      lines.push(`--${altBoundary}--`);
    } else {
      lines.push("Content-Type: text/plain; charset=UTF-8");
      lines.push("Content-Transfer-Encoding: base64");
      lines.push("");
      lines.push(toBase64(options.body));
    }

    // Attachments
    for (const att of options.attachments!) {
      lines.push("");
      lines.push(`--${boundary}`);
      lines.push(`Content-Type: ${att.mimeType}; name="${att.filename}"`);
      lines.push("Content-Transfer-Encoding: base64");
      lines.push(`Content-Disposition: attachment; filename="${att.filename}"`);
      lines.push("");
      const fileData = readFileSync(att.path);
      lines.push(fileData.toString("base64"));
    }

    lines.push("");
    lines.push(`--${boundary}--`);
  } else if (hasHtml) {
    // multipart/alternative for text + html
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    lines.push("");

    lines.push(`--${boundary}`);
    lines.push("Content-Type: text/plain; charset=UTF-8");
    lines.push("Content-Transfer-Encoding: base64");
    lines.push("");
    lines.push(toBase64(options.body));
    lines.push("");

    lines.push(`--${boundary}`);
    lines.push("Content-Type: text/html; charset=UTF-8");
    lines.push("Content-Transfer-Encoding: base64");
    lines.push("");
    lines.push(toBase64(options.bodyHtml!));
    lines.push("");

    lines.push(`--${boundary}--`);
  } else {
    // Simple text/plain
    lines.push("Content-Type: text/plain; charset=UTF-8");
    lines.push("Content-Transfer-Encoding: base64");
    lines.push("");
    lines.push(toBase64(options.body));
  }

  const raw = lines.join("\r\n");
  return toBase64Url(raw);
}

function toBase64(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64");
}

function toBase64Url(text: string): string {
  return Buffer.from(text, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function encodeSubject(subject: string): string {
  // RFC 2047: encode if non-ASCII
  if (/^[\x20-\x7E]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${toBase64(subject)}?=`;
}
