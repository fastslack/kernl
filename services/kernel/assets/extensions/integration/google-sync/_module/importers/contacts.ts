import type { SqliteDb } from "../../../../../../src/core/db/sqlite.js";
import type { CrmService } from "../../../../people/crm/_module/service.js";
import type { GoogleClient } from "../google-client.js";
import type { GooglePerson, ImportResult } from "../../../../../../src/core/integrations/google-types.js";
import { newId, isoNow } from "../../../../../../src/core/helpers.js";
import { log } from "../../../../../../src/core/logger.js";

const PEOPLE_API_URL = "https://people.googleapis.com/v1/people/me/connections";

export function mapGoogleContact(person: GooglePerson) {
  return {
    name: person.names?.[0]?.displayName ?? "",
    email: person.emailAddresses?.[0]?.value ?? "",
    phone: person.phoneNumbers?.[0]?.value ?? "",
    company: person.organizations?.[0]?.name ?? "",
    notes: person.biographies?.[0]?.value ?? "",
    relationship: "acquaintance" as const,
  };
}

export async function importContacts(
  client: GoogleClient,
  db: SqliteDb,
  crmService: CrmService,
): Promise<ImportResult> {
  const result: ImportResult = { source: "contacts", imported: 0, skipped: 0, errors: [] };

  const people = await client.getPaginated<GooglePerson>(
    PEOPLE_API_URL,
    {
      personFields: "names,emailAddresses,phoneNumbers,organizations,biographies",
      pageSize: "100",
      sortOrder: "LAST_MODIFIED_DESCENDING",
    },
    "connections",
  );

  for (const person of people) {
    const googleId = person.resourceName;
    if (!googleId) {
      result.skipped++;
      continue;
    }

    // Skip contacts without a name
    const mapped = mapGoogleContact(person);
    if (!mapped.name) {
      result.skipped++;
      continue;
    }

    try {
      // Check if already synced
      const existing = db
        .prepare("SELECT local_id FROM google_sync_map WHERE source = 'contacts' AND google_id = ?")
        .get(googleId) as { local_id: string } | undefined;

      if (existing) {
        result.skipped++;
        continue;
      }

      const contact = crmService.addContact(mapped);

      db.prepare(
        `INSERT INTO google_sync_map (id, source, google_id, local_id, local_table, synced_at)
         VALUES (?, 'contacts', ?, ?, 'contacts', ?)`,
      ).run(newId(), googleId, contact.id, isoNow());

      result.imported++;
    } catch (err) {
      result.errors.push(`Contact "${mapped.name}": ${String(err)}`);
    }
  }

  // Update sync meta
  db.prepare(
    `INSERT INTO google_sync_meta (source, last_sync_at, items_synced)
     VALUES ('contacts', ?, ?)
     ON CONFLICT(source) DO UPDATE SET last_sync_at = excluded.last_sync_at, items_synced = excluded.items_synced`,
  ).run(isoNow(), result.imported);

  log.info(`Contacts sync: ${result.imported} imported, ${result.skipped} skipped`);
  return result;
}
