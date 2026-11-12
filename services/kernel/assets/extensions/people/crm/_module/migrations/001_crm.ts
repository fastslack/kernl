import type { Migration } from "@kernl/extension-sdk";

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
  {
    // Projects (kernel src/modules/projects): a lead/contact can belong to a
    // project. NULL = personal contact, as before.
    version: 3,
    sql: `
      ALTER TABLE contacts ADD COLUMN project_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_contacts_project ON contacts(project_id, lead_status);
    `,
  },
  {
    // Outbox channels: a contact can ask not to be contacted again (the
    // unsubscribe link, the operator's button). Every outbox channel checks
    // it when validating a draft and again right before sending.
    version: 4,
    sql: `ALTER TABLE contacts ADD COLUMN do_not_contact INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    // v5 — one person, many identities. A contact keeps every email, phone
    // and handle it is known by (contacts holds one of each); pairs judged
    // to be different people are remembered; merges keep what was merged.
    version: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS contact_identities (
        id          TEXT PRIMARY KEY,
        contact_id  TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        kind        TEXT NOT NULL CHECK(kind IN ('email','phone','linkedin','instagram','x','website')),
        value       TEXT NOT NULL,
        value_norm  TEXT NOT NULL,
        source      TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL,
        UNIQUE(contact_id, kind, value_norm)
      );
      CREATE INDEX IF NOT EXISTS idx_contact_identities_value ON contact_identities(kind, value_norm);

      CREATE TABLE IF NOT EXISTS contact_distinct (
        a           TEXT NOT NULL,
        b           TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        PRIMARY KEY (a, b)
      );

      CREATE TABLE IF NOT EXISTS contact_merges (
        id          TEXT PRIMARY KEY,
        kept_id     TEXT NOT NULL,
        merged_id   TEXT NOT NULL,
        snapshot    TEXT NOT NULL,
        moved       TEXT NOT NULL DEFAULT '{}',
        created_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_contact_merges_kept ON contact_merges(kept_id);
    `,
  },
];
