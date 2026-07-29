import type { SqliteDb } from "../../../../../../src/core/db/sqlite.js";
import type { CrmService } from "../../../../people/crm/_module/service.js";
import type { GoogleClient } from "../google-client.js";
import type { GoogleOtherContact, ImportResult } from "../../../../../../src/core/integrations/google-types.js";
import { newId, isoNow } from "../../../../../../src/core/helpers.js";
import { log } from "../../../../../../src/core/logger.js";

const OTHER_CONTACTS_URL = "https://people.googleapis.com/v1/otherContacts";

export function mapOtherContact(contact: GoogleOtherContact) {
  return {
    name: contact.names?.[0]?.displayName ?? "",
    email: contact.emailAddresses?.[0]?.value ?? "",
    phone: contact.phoneNumbers?.[0]?.value ?? "",
    relationship: "acquaintance" as const,
    notes: "Imported from Google Other Contacts (auto-saved)",
  };
}

export async function importOtherContacts(
  client: GoogleClient,
  db: SqliteDb,
  crmService: CrmService,
): Promise<ImportResult> {
  const result: ImportResult = { source: "other_contacts", imported: 0, skipped: 0, errors: [] };

  const contacts = await client.getPaginated<GoogleOtherContact>(
    OTHER_CONTACTS_URL,
    {
      readMask: "names,emailAddresses,phoneNumbers",
      pageSize: "100",
    },
    "otherContacts",
  );

  for (const contact of contacts) {
    const googleId = contact.resourceName;
    if (!googleId) {
      result.skipped++;
      continue;
    }

    const mapped = mapOtherContact(contact);

    // Skip contacts without a name or email (other contacts often have just an email)
    if (!mapped.name && !mapped.email) {
      result.skipped++;
      continue;
    }

    // Use email as name if name is missing
    if (!mapped.name) {
      mapped.name = mapped.email;
    }

    try {
      // Check if already synced
      const existing = db
        .prepare("SELECT local_id FROM google_sync_map WHERE source = 'other_contacts' AND google_id = ?")
        .get(googleId) as { local_id: string } | undefined;

      if (existing) {
        result.skipped++;
        continue;
      }

      // Also check if a CRM contact with the same email already exists (from contacts import)
      if (mapped.email) {
        const existingByEmail = crmService.find(mapped.email);
        if (existingByEmail.some((c) => c.email.toLowerCase() === mapped.email.toLowerCase())) {
          result.skipped++;
          // Record in sync_map to avoid re-processing
          db.prepare(
            `INSERT INTO google_sync_map (id, source, google_id, local_id, local_table, synced_at)
             VALUES (?, 'other_contacts', ?, '', 'contacts', ?)`,
          ).run(newId(), googleId, isoNow());
          continue;
        }
      }

      const created = crmService.addContact(mapped);

      db.prepare(
        `INSERT INTO google_sync_map (id, source, google_id, local_id, local_table, synced_at)
         VALUES (?, 'other_contacts', ?, ?, 'contacts', ?)`,
      ).run(newId(), googleId, created.id, isoNow());

      result.imported++;
    } catch (err) {
      result.errors.push(`Other contact "${mapped.name}": ${String(err)}`);
    }
  }

  db.prepare(
    `INSERT INTO google_sync_meta (source, last_sync_at, items_synced)
     VALUES ('other_contacts', ?, ?)
     ON CONFLICT(source) DO UPDATE SET last_sync_at = excluded.last_sync_at, items_synced = excluded.items_synced`,
  ).run(isoNow(), result.imported);

  log.info(`Other contacts sync: ${result.imported} imported, ${result.skipped} skipped`);
  return result;
}
