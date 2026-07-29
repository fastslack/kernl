import type { SqliteDb } from "../../../../../../src/core/db/sqlite.js";
import type { CrmService } from "../../../../people/crm/_module/service.js";
import type { GoogleClient } from "../google-client.js";
import type { GmailMessage, GmailMessageDetail, ImportResult } from "../../../../../../src/core/integrations/google-types.js";
import type { Contact } from "../../../../people/crm/_module/types.js";
import { newId, isoNow } from "../../../../../../src/core/helpers.js";
import { log } from "../../../../../../src/core/logger.js";

const GMAIL_MESSAGES_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";

function extractHeader(msg: GmailMessageDetail, name: string): string {
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/**
 * Extract email address from a header value like "John Doe <john@example.com>"
 */
function parseEmailAddress(headerValue: string): string {
  const match = headerValue.match(/<([^>]+)>/);
  return (match ? match[1] : headerValue).trim().toLowerCase();
}

/**
 * Build a lookup map of email → Contact for efficient matching.
 */
function buildEmailIndex(contacts: Contact[]): Map<string, Contact> {
  const index = new Map<string, Contact>();
  for (const c of contacts) {
    if (c.email) {
      index.set(c.email.toLowerCase(), c);
    }
  }
  return index;
}

export async function importGmail(
  client: GoogleClient,
  db: SqliteDb,
  crmService: CrmService,
): Promise<ImportResult> {
  const result: ImportResult = { source: "gmail", imported: 0, skipped: 0, errors: [] };

  // Get all CRM contacts with emails
  const contacts = crmService.listContacts();
  const emailIndex = buildEmailIndex(contacts);

  if (emailIndex.size === 0) {
    result.errors.push("No CRM contacts with email addresses found. Import contacts first.");
    return result;
  }

  // Fetch recent messages (last 30 days)
  const messages = await client.getPaginated<GmailMessage>(
    GMAIL_MESSAGES_URL,
    { q: "newer_than:30d", maxResults: "200" },
    "messages",
  );

  // Track which contact+date combos we've already logged to avoid flooding
  const loggedInteractions = new Set<string>();

  for (const msg of messages) {
    try {
      // Check if already synced
      const existing = db
        .prepare("SELECT local_id FROM google_sync_map WHERE source = 'gmail' AND google_id = ?")
        .get(msg.id) as { local_id: string } | undefined;

      if (existing) {
        result.skipped++;
        continue;
      }

      // Fetch message metadata (metadataHeaders must be repeated params)
      const detail = await client.get<GmailMessageDetail>(
        `${GMAIL_MESSAGES_URL}/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
      );

      const from = parseEmailAddress(extractHeader(detail, "From"));
      const to = parseEmailAddress(extractHeader(detail, "To"));
      const subject = extractHeader(detail, "Subject") || "(no subject)";
      const dateStr = extractHeader(detail, "Date");
      const date = dateStr ? new Date(dateStr).toISOString().split("T")[0] : isoNow().split("T")[0];

      // Match against CRM contacts
      const matchedContact = emailIndex.get(from) ?? emailIndex.get(to);
      if (!matchedContact) {
        result.skipped++;
        // Still record in sync_map to avoid re-fetching
        db.prepare(
          `INSERT INTO google_sync_map (id, source, google_id, local_id, local_table, synced_at)
           VALUES (?, 'gmail', ?, '', 'interactions', ?)`,
        ).run(newId(), msg.id, isoNow());
        continue;
      }

      // Avoid logging multiple interactions for the same contact on the same day
      const dedupeKey = `${matchedContact.id}:${date}`;
      if (loggedInteractions.has(dedupeKey)) {
        result.skipped++;
        db.prepare(
          `INSERT INTO google_sync_map (id, source, google_id, local_id, local_table, synced_at)
           VALUES (?, 'gmail', ?, '', 'interactions', ?)`,
        ).run(newId(), msg.id, isoNow());
        continue;
      }

      const interaction = crmService.logInteraction({
        contact_id: matchedContact.id,
        type: "email",
        summary: subject,
        date,
      });

      if (interaction) {
        loggedInteractions.add(dedupeKey);
        db.prepare(
          `INSERT INTO google_sync_map (id, source, google_id, local_id, local_table, synced_at)
           VALUES (?, 'gmail', ?, ?, 'interactions', ?)`,
        ).run(newId(), msg.id, interaction.id, isoNow());
        result.imported++;
      } else {
        result.skipped++;
      }
    } catch (err) {
      result.errors.push(`Message ${msg.id}: ${String(err)}`);
    }
  }

  db.prepare(
    `INSERT INTO google_sync_meta (source, last_sync_at, items_synced)
     VALUES ('gmail', ?, ?)
     ON CONFLICT(source) DO UPDATE SET last_sync_at = excluded.last_sync_at, items_synced = excluded.items_synced`,
  ).run(isoNow(), result.imported);

  log.info(`Gmail sync: ${result.imported} interactions logged, ${result.skipped} skipped`);
  return result;
}
