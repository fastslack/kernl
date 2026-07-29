import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { GraphDriver } from "../../../../../src/core/db-drivers/graph-driver.js";
import type { Contact, Interaction, LeadStatus } from "./types.js";
import { newId, isoNow } from "../../../../../src/core/helpers.js";

const LEAD_STATUSES: ReadonlyArray<LeadStatus> = ["", "new", "drafted", "contacted", "qualified", "won", "lost"];

/** Strip everything but `+` and digits — turns "+54 9 11 1234-5678" into
 *  "+5491112345678" so two records of the same person stop slipping through
 *  exact-match dedup. Returns "" when the input has no digits.
 *
 *  Additionally strips the leading "9" Argentinian mobile routing flag so
 *  the same number entered with and without it dedupes correctly. Add
 *  similar country-specific quirks here if you need them. */
function normalizePhone(raw: string): string {
  if (!raw) return "";
  let s = raw.trim();
  s = s.replace(/[^+\d]/g, "");
  if (s.startsWith("+549")) s = "+54" + s.slice(4);
  return s;
}

export class CrmService {
  constructor(
    private db: SqliteDb,
    private getGraph: () => GraphDriver | null,
  ) {}

  /** Find a contact by normalized phone or by email — used by addContact for
   *  idempotent dedup. Returns the first match (most recent). */
  findExisting(phone?: string, email?: string): Contact | undefined {
    const normalized = normalizePhone(phone ?? "");
    if (normalized) {
      const rows = this.db
        .prepare("SELECT * FROM contacts WHERE phone <> '' ORDER BY created_at DESC")
        .all() as Contact[];
      const hit = rows.find((c) => normalizePhone(c.phone) === normalized);
      if (hit) return hit;
    }
    const e = (email ?? "").trim().toLowerCase();
    if (e) {
      const hit = this.db
        .prepare("SELECT * FROM contacts WHERE LOWER(email) = ? ORDER BY created_at DESC LIMIT 1")
        .get(e) as Contact | undefined;
      if (hit) return hit;
    }
    return undefined;
  }

  addContact(input: {
    name: string;
    email?: string;
    phone?: string;
    company?: string;
    relationship?: Contact["relationship"];
    notes?: string;
    // ── Lead pipeline + social (v2) ─────────
    lead_status?: LeadStatus;
    lead_source?: string;
    instagram_handle?: string;
    linkedin_url?: string;
    x_handle?: string;
    website?: string;
    /** When true (default), check phone/email and merge into the existing
     *  row instead of creating a duplicate. Exact-string matching of e.g.
     *  "+1 415 555-0142" vs "+14155550142" produces two contacts otherwise
     *  — normalized dedup closes that hole. */
    dedup?: boolean;
  }): Contact {
    const now = isoNow();
    const dedup = input.dedup !== false;

    if (dedup) {
      const existing = this.findExisting(input.phone, input.email);
      if (existing) {
        // Merge: only fill empty fields and append to notes — never overwrite
        // human-curated data. Updates last_interaction so it shows up at the
        // top of "recent" views.
        const merged: Partial<Contact> = {};
        if (!existing.email && input.email) merged.email = input.email;
        if (!existing.phone && input.phone) merged.phone = input.phone;
        if (!existing.company && input.company) merged.company = input.company;
        if (!existing.instagram_handle && input.instagram_handle) merged.instagram_handle = input.instagram_handle;
        if (!existing.linkedin_url && input.linkedin_url) merged.linkedin_url = input.linkedin_url;
        if (!existing.x_handle && input.x_handle) merged.x_handle = input.x_handle;
        if (!existing.website && input.website) merged.website = input.website;
        if (!existing.lead_source && input.lead_source) merged.lead_source = input.lead_source;
        if (!existing.lead_status && input.lead_status) merged.lead_status = input.lead_status;
        if (input.notes && !existing.notes.includes(input.notes)) {
          merged.notes = (existing.notes ? existing.notes + "\n\n" : "") + input.notes;
        }
        if (Object.keys(merged).length > 0) {
          this.updateContact(existing.id, merged);
          return this.getById(existing.id) ?? existing;
        }
        return existing;
      }
    }

    const contact: Contact = {
      id: newId(),
      name: input.name,
      email: input.email ?? "",
      phone: input.phone ?? "",
      company: input.company ?? "",
      relationship: input.relationship ?? "acquaintance",
      notes: input.notes ?? "",
      last_interaction: null,
      lead_status: input.lead_status ?? "",
      lead_source: input.lead_source ?? "",
      instagram_handle: input.instagram_handle ?? "",
      linkedin_url: input.linkedin_url ?? "",
      x_handle: input.x_handle ?? "",
      website: input.website ?? "",
      created_at: now,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO contacts (id, name, email, phone, company, relationship, notes, last_interaction,
          lead_status, lead_source, instagram_handle, linkedin_url, x_handle, website, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        contact.id, contact.name, contact.email, contact.phone,
        contact.company, contact.relationship, contact.notes,
        contact.last_interaction,
        contact.lead_status, contact.lead_source,
        contact.instagram_handle, contact.linkedin_url, contact.x_handle, contact.website,
        contact.created_at, contact.updated_at,
      );

    const graph = this.getGraph();
    if (graph?.capabilities.cypher) {
      graph
        .run(
          `MERGE (p:Person {id: $id})
           SET p.name = $name, p.email = $email, p.company = $company, p.relationship = $relationship`,
          {
            id: contact.id,
            name: contact.name,
            email: contact.email,
            company: contact.company,
            relationship: contact.relationship,
          },
        )
        .catch(() => {});
    }

    return contact;
  }

  find(query: string): Contact[] {
    return this.db
      .prepare(
        `SELECT * FROM contacts
         WHERE name LIKE ? OR email LIKE ? OR company LIKE ? OR notes LIKE ?
         ORDER BY name`,
      )
      .all(`%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`) as Contact[];
  }

  getById(id: string): Contact | undefined {
    return this.db.prepare("SELECT * FROM contacts WHERE id = ?").get(id) as
      | Contact
      | undefined;
  }

  listContacts(filters?: { relationship?: Contact["relationship"] }): Contact[] {
    let sql = "SELECT * FROM contacts WHERE 1=1";
    const params: unknown[] = [];

    if (filters?.relationship) {
      sql += " AND relationship = ?";
      params.push(filters.relationship);
    }

    sql += " ORDER BY name";
    return this.db.prepare(sql).all(...params) as Contact[];
  }

  /** Patch a contact in place. Only writes the fields actually supplied. */
  updateContact(id: string, patch: Partial<Omit<Contact, "id" | "created_at">>): boolean {
    const allowed: Array<keyof typeof patch> = [
      "name", "email", "phone", "company", "relationship", "notes",
      "last_interaction", "lead_status", "lead_source",
      "instagram_handle", "linkedin_url", "x_handle", "website",
    ];
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const k of allowed) {
      if (patch[k] === undefined) continue;
      sets.push(`${k} = ?`);
      params.push(patch[k]);
    }
    if (sets.length === 0) return false;
    sets.push("updated_at = ?");
    params.push(isoNow());
    params.push(id);
    const r = this.db.prepare(`UPDATE contacts SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return (r?.changes ?? 0) > 0;
  }

  /** List leads — contacts with a non-empty lead_status, optionally filtered. */
  listLeads(filters?: {
    status?: LeadStatus | "any";
    source?: string;
    limit?: number;
  }): Contact[] {
    const status = filters?.status ?? "any";
    let sql = "SELECT * FROM contacts WHERE lead_status <> ''";
    const params: unknown[] = [];
    if (status !== "any" && status !== "") {
      sql += " AND lead_status = ?";
      params.push(status);
    }
    if (filters?.source) {
      sql += " AND lead_source = ?";
      params.push(filters.source);
    }
    sql += " ORDER BY updated_at DESC LIMIT ?";
    params.push(filters?.limit ?? 100);
    return this.db.prepare(sql).all(...params) as Contact[];
  }

  /** Move a lead through the pipeline. Sets lead_status='new' on first touch
   *  if a contact has no status yet. Returns the post-update contact. */
  setLeadStatus(id: string, status: LeadStatus): Contact | undefined {
    if (!LEAD_STATUSES.includes(status)) return undefined;
    this.db
      .prepare("UPDATE contacts SET lead_status = ?, updated_at = ? WHERE id = ?")
      .run(status, isoNow(), id);
    return this.getById(id);
  }

  /** Lead pipeline counters, useful for the /crm/leads page header. */
  leadCounts(source?: string): Record<LeadStatus, number> {
    let sql = "SELECT lead_status AS s, COUNT(*) AS n FROM contacts WHERE lead_status <> ''";
    const params: unknown[] = [];
    if (source) {
      sql += " AND lead_source = ?";
      params.push(source);
    }
    sql += " GROUP BY lead_status";
    const rows = this.db.prepare(sql).all(...params) as Array<{ s: LeadStatus; n: number }>;
    const out: Record<LeadStatus, number> = { "": 0, new: 0, drafted: 0, contacted: 0, qualified: 0, won: 0, lost: 0 };
    for (const r of rows) out[r.s] = r.n;
    return out;
  }

  logInteraction(input: {
    contact_id: string;
    type: Interaction["type"];
    summary: string;
    date?: string;
  }): Interaction | null {
    const contact = this.getById(input.contact_id);
    if (!contact) return null;

    const now = isoNow();
    const interaction: Interaction = {
      id: newId(),
      contact_id: input.contact_id,
      type: input.type,
      summary: input.summary,
      date: input.date ?? now.split("T")[0],
      created_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO interactions (id, contact_id, type, summary, date, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        interaction.id, interaction.contact_id, interaction.type,
        interaction.summary, interaction.date, interaction.created_at,
      );

    // Update last interaction date
    this.db
      .prepare("UPDATE contacts SET last_interaction = ?, updated_at = ? WHERE id = ?")
      .run(interaction.date, now, input.contact_id);

    const graph = this.getGraph();
    if (graph?.capabilities.cypher) {
      graph
        .run(
          `MATCH (p:Person {id: $contactId})
           SET p.lastInteraction = $date`,
          { contactId: input.contact_id, date: interaction.date },
        )
        .catch(() => {});
    }

    return interaction;
  }

  getInteractions(contactId: string): Interaction[] {
    return this.db
      .prepare(
        "SELECT * FROM interactions WHERE contact_id = ? ORDER BY date DESC LIMIT 20",
      )
      .all(contactId) as Interaction[];
  }

  async addRelationship(
    fromId: string,
    toId: string,
    relType: string,
  ): Promise<boolean> {
    const graph = this.getGraph();
    if (!graph?.capabilities.cypher) return false;

    await graph.run(
      `MATCH (a:Person {id: $fromId}), (b:Person {id: $toId})
       MERGE (a)-[:KNOWS {type: $relType}]->(b)`,
      { fromId, toId, relType },
    );

    return true;
  }
}
