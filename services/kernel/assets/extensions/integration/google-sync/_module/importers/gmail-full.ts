import type { SqliteDb } from "../../../../../../src/core/db/sqlite.js";
import type { CrmService } from "../../../../people/crm/_module/service.js";
import type { GoogleClient } from "../google-client.js";
import type { GmailMessage, GmailMessageFull, ImportResult } from "../../../../../../src/core/integrations/google-types.js";
import type { Contact } from "../../../../people/crm/_module/types.js";
import { newId, isoNow } from "../../../../../../src/core/helpers.js";
import { log } from "../../../../../../src/core/logger.js";
import { extractGmailBody, stripHtml, extractHeader, parseEmailAddress, parseEmailName } from "../../../../people/comms/_module/gmail-helpers.js";

const GMAIL_MESSAGES_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const MAX_BODY_LENGTH = 10_240; // 10KB truncation
const BATCH_SIZE = 10;

interface EmailParticipant {
  email: string;
  name: string;
}

function parseParticipantList(headerValue: string): EmailParticipant[] {
  if (!headerValue) return [];
  // Split by comma, but respect quoted strings
  const parts = headerValue.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  return parts
    .map((p) => ({
      email: parseEmailAddress(p.trim()),
      name: parseEmailName(p.trim()),
    }))
    .filter((p) => p.email.includes("@"));
}

function buildEmailIndex(contacts: Contact[]): Map<string, Contact> {
  const index = new Map<string, Contact>();
  for (const c of contacts) {
    if (c.email) {
      index.set(c.email.toLowerCase(), c);
    }
  }
  return index;
}

export async function importGmailFull(
  client: GoogleClient,
  db: SqliteDb,
  crmService: CrmService,
  accountId = "",
): Promise<ImportResult> {
  const result: ImportResult = { source: "gmail" as any, imported: 0, skipped: 0, errors: [] };

  // Determine query — incremental via last_sync_at or first-time (90 days)
  const meta = db
    .prepare("SELECT last_sync_at FROM google_sync_meta WHERE source = 'gmail_full'")
    .get() as { last_sync_at: string } | undefined;

  let query: string;
  if (meta?.last_sync_at) {
    // Incremental: after last sync date
    const afterDate = meta.last_sync_at.split("T")[0].replace(/-/g, "/");
    query = `after:${afterDate}`;
  } else {
    query = "newer_than:90d";
  }

  // Fetch message IDs (paginated)
  const messages = await client.getPaginated<GmailMessage>(
    GMAIL_MESSAGES_URL,
    { q: query, maxResults: "500" },
    "messages",
  );

  log.info(`Gmail full sync: ${messages.length} message IDs fetched (query: ${query})`);

  // CRM contacts for interaction logging (backward compat)
  const contacts = crmService.listContacts();
  const emailIndex = buildEmailIndex(contacts);
  const loggedInteractions = new Set<string>();

  // Prepare insert statement
  const resolvedAccountId = accountId || resolveDefaultGmailAccountId(db);

  const insertEmail = db.prepare(
    `INSERT OR IGNORE INTO google_emails
     (id, gmail_id, thread_id, from_email, from_name, to_emails, cc_emails,
      subject, snippet, body_text, labels, date, size_bytes, has_attachments,
      is_read, is_starred, created_at, account_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const insertSyncMap = db.prepare(
    `INSERT OR IGNORE INTO google_sync_map (id, source, google_id, local_id, local_table, synced_at)
     VALUES (?, 'gmail', ?, ?, 'google_emails', ?)`,
  );

  // Process in batches
  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);

    // Fetch full details in parallel within batch
    const details = await Promise.allSettled(
      batch.map((msg) =>
        client.get<GmailMessageFull>(
          `${GMAIL_MESSAGES_URL}/${msg.id}?format=full`,
        ),
      ),
    );

    for (let j = 0; j < details.length; j++) {
      const settled = details[j];
      const msgId = batch[j].id;

      if (settled.status === "rejected") {
        result.errors.push(`Message ${msgId}: ${settled.reason}`);
        continue;
      }

      const msg = settled.value;

      try {
        // Check if already stored
        const existing = db
          .prepare("SELECT id FROM google_emails WHERE gmail_id = ?")
          .get(msg.id);
        if (existing) {
          result.skipped++;
          continue;
        }

        const headers = msg.payload?.headers ?? [];
        const fromRaw = extractHeader(headers, "From");
        const toRaw = extractHeader(headers, "To");
        const ccRaw = extractHeader(headers, "Cc");
        const subject = extractHeader(headers, "Subject") || "(no subject)";
        const dateStr = extractHeader(headers, "Date");

        const fromEmail = parseEmailAddress(fromRaw);
        const fromName = parseEmailName(fromRaw);
        const toList = parseParticipantList(toRaw);
        const ccList = parseParticipantList(ccRaw);

        // Extract body
        const body = extractGmailBody(msg.payload);
        let bodyText = body.text || (body.html ? stripHtml(body.html) : "");
        if (bodyText.length > MAX_BODY_LENGTH) {
          bodyText = bodyText.slice(0, MAX_BODY_LENGTH);
        }

        const date = dateStr
          ? new Date(dateStr).toISOString()
          : new Date(parseInt(msg.internalDate)).toISOString();

        const labelIds = msg.labelIds ?? [];
        const hasAttachments = msg.payload?.parts?.some(
          (p) => p.body?.size && p.body.size > 0 && p.mimeType !== "text/plain" && p.mimeType !== "text/html",
        ) ? 1 : 0;
        const isRead = labelIds.includes("UNREAD") ? 0 : 1;
        const isStarred = labelIds.includes("STARRED") ? 1 : 0;

        const emailId = newId();
        const now = isoNow();

        insertEmail.run(
          emailId,
          msg.id,
          msg.threadId,
          fromEmail,
          fromName,
          JSON.stringify(toList),
          JSON.stringify(ccList),
          subject,
          msg.snippet ?? "",
          bodyText,
          JSON.stringify(labelIds),
          date,
          msg.payload?.body?.size ?? 0,
          hasAttachments,
          isRead,
          isStarred,
          now,
          resolvedAccountId,
        );

        insertSyncMap.run(newId(), msg.id, emailId, now);

        // Backward compat: log CRM interaction for matched contacts
        const matchedContact = emailIndex.get(fromEmail) ?? toList.find((t) => emailIndex.has(t.email)) ? emailIndex.get(toList.find((t) => emailIndex.has(t.email))?.email ?? "") : undefined;
        if (matchedContact) {
          const dateOnly = date.split("T")[0];
          const dedupeKey = `${matchedContact.id}:${dateOnly}`;
          if (!loggedInteractions.has(dedupeKey)) {
            crmService.logInteraction({
              contact_id: matchedContact.id,
              type: "email",
              summary: subject,
              date: dateOnly,
            });
            loggedInteractions.add(dedupeKey);
          }
        }

        result.imported++;
      } catch (err) {
        result.errors.push(`Message ${msgId}: ${String(err)}`);
      }
    }
  }

  // Aggregate threads
  aggregateThreads(db);

  // Update sync meta
  db.prepare(
    `INSERT INTO google_sync_meta (source, last_sync_at, items_synced)
     VALUES ('gmail_full', ?, ?)
     ON CONFLICT(source) DO UPDATE SET last_sync_at = excluded.last_sync_at, items_synced = excluded.items_synced`,
  ).run(isoNow(), result.imported);

  log.info(`Gmail full sync: ${result.imported} emails stored, ${result.skipped} skipped, ${result.errors.length} errors`);
  return result;
}

/** Aggregate google_emails into google_email_threads */
function aggregateThreads(db: SqliteDb): void {
  const now = isoNow();

  // Get distinct thread IDs from emails
  const threads = db.prepare(
    `SELECT thread_id,
            MIN(subject) as subject,
            COUNT(*) as message_count,
            MAX(date) as last_message_date
     FROM google_emails
     WHERE thread_id <> ''
     GROUP BY thread_id`,
  ).all() as Array<{
    thread_id: string;
    subject: string;
    message_count: number;
    last_message_date: string;
  }>;

  const upsert = db.prepare(
    `INSERT INTO google_email_threads (id, gmail_thread_id, subject, message_count, participants, last_message_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(gmail_thread_id) DO UPDATE SET
       message_count = excluded.message_count,
       participants = excluded.participants,
       last_message_date = excluded.last_message_date,
       updated_at = excluded.updated_at`,
  );

  for (const thread of threads) {
    // Gather participants for this thread
    const participants = db.prepare(
      `SELECT DISTINCT from_email FROM google_emails WHERE thread_id = ? AND from_email <> ''`,
    ).all(thread.thread_id) as Array<{ from_email: string }>;

    const participantEmails = participants.map((p) => p.from_email);

    upsert.run(
      newId(),
      thread.thread_id,
      thread.subject,
      thread.message_count,
      JSON.stringify(participantEmails),
      thread.last_message_date,
      now,
      now,
    );
  }

  log.info(`Thread aggregation: ${threads.length} threads upserted`);
}

function resolveDefaultGmailAccountId(db: SqliteDb): string {
  try {
    const row = db
      .prepare(
        `SELECT id FROM email_accounts
         WHERE provider = 'gmail'
         ORDER BY is_default DESC, created_at ASC
         LIMIT 1`,
      )
      .get() as { id: string } | undefined;
    return row?.id ?? "";
  } catch {
    return "";
  }
}
