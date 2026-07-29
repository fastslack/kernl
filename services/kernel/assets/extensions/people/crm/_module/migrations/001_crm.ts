import type { Migration } from "../../../../../../src/core/db/migrations.js";

export const crmMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS contacts (
        id                TEXT PRIMARY KEY,
        name              TEXT NOT NULL,
        email             TEXT NOT NULL DEFAULT '',
        phone             TEXT NOT NULL DEFAULT '',
        company           TEXT NOT NULL DEFAULT '',
        relationship      TEXT NOT NULL DEFAULT 'acquaintance'
                          CHECK(relationship IN ('personal','professional','family','acquaintance')),
        notes             TEXT NOT NULL DEFAULT '',
        last_interaction  TEXT,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);
      CREATE INDEX IF NOT EXISTS idx_contacts_relationship ON contacts(relationship);

      CREATE TABLE IF NOT EXISTS interactions (
        id          TEXT PRIMARY KEY,
        contact_id  TEXT NOT NULL REFERENCES contacts(id),
        type        TEXT NOT NULL DEFAULT 'other'
                    CHECK(type IN ('email','call','meeting','message','social','other')),
        summary     TEXT NOT NULL DEFAULT '',
        date        TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_interactions_contact ON interactions(contact_id);
      CREATE INDEX IF NOT EXISTS idx_interactions_date ON interactions(date);
    `,
  },
  {
    // v2 — lead pipeline + social handles.
    //
    // Contacts can now double as leads. `lead_status` is empty for ordinary
    // CRM contacts (back-compat) and one of the named stages otherwise.
    // `lead_source` lets us filter by origin (e.g. 'web-prospector', 'linkedin-export').
    // The four social/web columns let prospector agents persist outreach
    // surfaces alongside email + phone — same row, no extra join.
    version: 2,
    sql: `
      ALTER TABLE contacts ADD COLUMN lead_status TEXT NOT NULL DEFAULT '';
      ALTER TABLE contacts ADD COLUMN lead_source TEXT NOT NULL DEFAULT '';
      ALTER TABLE contacts ADD COLUMN instagram_handle TEXT NOT NULL DEFAULT '';
      ALTER TABLE contacts ADD COLUMN linkedin_url TEXT NOT NULL DEFAULT '';
      ALTER TABLE contacts ADD COLUMN x_handle TEXT NOT NULL DEFAULT '';
      ALTER TABLE contacts ADD COLUMN website TEXT NOT NULL DEFAULT '';
      CREATE INDEX IF NOT EXISTS idx_contacts_lead_status
        ON contacts(lead_status) WHERE lead_status <> '';
      CREATE INDEX IF NOT EXISTS idx_contacts_lead_source
        ON contacts(lead_source) WHERE lead_source <> '';
    `,
  },
];
