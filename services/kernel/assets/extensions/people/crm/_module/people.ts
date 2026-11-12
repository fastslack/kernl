/**
 * One person, everywhere they show up.
 *
 * Everything Kernl learns about people funnels into CRM contacts — Google
 * contacts, mail senders, WhatsApp, LinkedIn imports — but a contact holds one
 * email and one phone, and the same person arriving twice under different
 * addresses became two contacts. This file adds:
 *
 *   identities   every email, phone and handle a contact is known by,
 *                normalised (contact_identities)
 *   duplicates   contacts that share an identity, or a name (and company);
 *                pairs judged to be different people are remembered
 *   merge        one contact absorbs another: references in every table,
 *                facts, and graph relationships move over; the absorbed row
 *                is kept as a snapshot (contact_merges)
 *   person 360   what Kernl knows about someone across modules, in one view
 *
 * Other modules' tables are read and repointed by column name (`contact_id`,
 * `organizer_contact_id`) and every such step is best-effort: a module that
 * is not installed simply has no table.
 */

import { type SqliteDb, type GraphDriver, type GraphRunner, inGraphTransaction, newId, isoNow } from "@kernl/extension-sdk";
import type { Contact } from "./types.js";

export type IdentityKind = "email" | "phone" | "linkedin" | "instagram" | "x" | "website";

export interface Identity {
  id: string;
  contact_id: string;
  kind: IdentityKind;
  value: string;
  value_norm: string;
  source: string;
  created_at: string;
}

/** Strip everything but `+` and digits; the AR mobile "9" is dropped (as CrmService does). */
export function normPhone(raw: string): string {
  let s = (raw ?? "").trim().replace(/[^+\d]/g, "");
  if (s.startsWith("+549")) s = "+54" + s.slice(4);
  return s.replace(/\D/g, "").length >= 7 ? s : "";
}

/** A canonical form per kind; "" when the value is not one. */
export function normIdentity(kind: IdentityKind, raw: string): string {
  const v = (raw ?? "").trim();
  if (!v) return "";
  switch (kind) {
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v.toLowerCase() : "";
    case "phone":
      return normPhone(v);
    case "linkedin": {
      const m = /linkedin\.com\/(in|company)\/([^/?#\s]+)/i.exec(v);
      return m ? `${m[1].toLowerCase()}/${decodeURIComponent(m[2]).toLowerCase()}` : "";
    }
    case "instagram":
    case "x": {
      const m = /(?:instagram\.com|twitter\.com|x\.com)\/([^/?#\s]+)/i.exec(v);
      const handle = (m ? m[1] : v).replace(/^@/, "").toLowerCase();
      return /^[a-z0-9._]+$/.test(handle) ? handle : "";
    }
    case "website": {
      try {
        const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
        return u.hostname.toLowerCase().replace(/^www\./, "");
      } catch {
        return "";
      }
    }
  }
}

/** Name for comparison: lower case, no accents, single spaces. */
export function normName(name: string): string {
  return (name ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const CONTACT_COLUMNS: Array<[keyof Contact, IdentityKind]> = [
  ["email", "email"],
  ["phone", "phone"],
  ["linkedin_url", "linkedin"],
  ["instagram_handle", "instagram"],
  ["x_handle", "x"],
  ["website", "website"],
];

/** Record one identity for a contact; returns false when it is not valid. */
export function addIdentity(db: SqliteDb, contactId: string, kind: IdentityKind, value: string, source = ""): boolean {
  const norm = normIdentity(kind, value);
  if (!norm) return false;
  db.prepare(
    `INSERT OR IGNORE INTO contact_identities (id, contact_id, kind, value, value_norm, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(newId(), contactId, kind, value.trim(), norm, source, isoNow());
  return true;
}

/** Make sure the contact's own columns are among its identities. */
export function syncContactIdentities(db: SqliteDb, contact: Contact | undefined, source = "contact"): void {
  if (!contact) return;
  for (const [col, kind] of CONTACT_COLUMNS) {
    const v = contact[col];
    if (typeof v === "string" && v) addIdentity(db, contact.id, kind, v, source);
  }
}

/** The contact an identity belongs to, if any (oldest first). */
export function contactByIdentity(db: SqliteDb, kind: IdentityKind, value: string): string | null {
  const norm = normIdentity(kind, value);
  if (!norm) return null;
  const r = db
    .prepare(
      `SELECT i.contact_id FROM contact_identities i JOIN contacts c ON c.id = i.contact_id
       WHERE i.kind = ? AND i.value_norm = ? ORDER BY c.created_at LIMIT 1`,
    )
    .get(kind, norm) as { contact_id: string } | undefined;
  return r?.contact_id ?? null;
}

export interface DuplicatePair {
  a: { id: string; name: string; company: string };
  b: { id: string; name: string; company: string };
  score: number;
  reasons: string[];
}

const tableExists = (db: SqliteDb, name: string): boolean =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

/** Tables with a column pointing at contacts, found by name. */
function referencingColumns(db: SqliteDb): Array<{ table: string; column: string }> {
  const out: Array<{ table: string; column: string }> = [];
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  for (const { name } of tables) {
    if (!/^[A-Za-z0-9_]+$/.test(name) || name === "contacts" || name === "contact_identities" || name === "contact_distinct" || name === "contact_merges") continue;
    let cols: Array<{ name: string }> = [];
    try {
      cols = db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>;
    } catch {
      continue; // virtual tables whose module is missing
    }
    for (const c of cols) {
      if (c.name === "contact_id" || c.name === "organizer_contact_id") out.push({ table: name, column: c.name });
    }
  }
  return out;
}

export class PeopleService {
  constructor(
    private db: SqliteDb,
    private getGraph: () => GraphDriver | null,
  ) {}

  /** Identities for every contact's own columns — run once at boot; cheap when nothing changed. */
  syncAll(): number {
    const contacts = this.db.prepare("SELECT * FROM contacts").all() as Contact[];
    this.db.transaction(() => {
      for (const c of contacts) syncContactIdentities(this.db, c);
    })();
    return contacts.length;
  }

  identities(contactId: string): Identity[] {
    return this.db
      .prepare("SELECT * FROM contact_identities WHERE contact_id = ? ORDER BY kind, created_at")
      .all(contactId) as Identity[];
  }

  /** Mark two contacts as different people, so they stop showing as duplicates. */
  markDistinct(a: string, b: string): void {
    const [x, y] = a < b ? [a, b] : [b, a];
    this.db.prepare("INSERT OR IGNORE INTO contact_distinct (a, b, created_at) VALUES (?, ?, ?)").run(x, y, isoNow());
  }

  /**
   * Contacts that look like the same person. A shared email, phone or handle
   * is near-certain; the same name is a hint, stronger with the same company.
   */
  duplicates(opts: { contactId?: string; limit?: number } = {}): DuplicatePair[] {
    const pairs = new Map<string, DuplicatePair>();
    const info = new Map<string, { id: string; name: string; company: string }>();
    const contacts = this.db.prepare("SELECT id, name, company FROM contacts").all() as Array<{ id: string; name: string; company: string }>;
    for (const c of contacts) info.set(c.id, c);
    const distinct = new Set(
      (this.db.prepare("SELECT a, b FROM contact_distinct").all() as Array<{ a: string; b: string }>).map((r) => `${r.a}|${r.b}`),
    );
    const add = (x: string, y: string, score: number, reason: string) => {
      if (x === y || !info.has(x) || !info.has(y)) return;
      const [a, b] = x < y ? [x, y] : [y, x];
      if (distinct.has(`${a}|${b}`)) return;
      if (opts.contactId && a !== opts.contactId && b !== opts.contactId) return;
      const key = `${a}|${b}`;
      const cur = pairs.get(key) ?? { a: info.get(a)!, b: info.get(b)!, score: 0, reasons: [] };
      cur.score = Math.min(1, Math.max(cur.score, score) + (cur.score > 0 ? 0.1 : 0));
      if (!cur.reasons.includes(reason)) cur.reasons.push(reason);
      pairs.set(key, cur);
    };

    const shared = this.db
      .prepare(
        `SELECT x.contact_id AS a, y.contact_id AS b, x.kind, x.value
         FROM contact_identities x JOIN contact_identities y
           ON y.kind = x.kind AND y.value_norm = x.value_norm AND y.contact_id > x.contact_id`,
      )
      .all() as Array<{ a: string; b: string; kind: string; value: string }>;
    for (const s of shared) add(s.a, s.b, 0.95, `same ${s.kind}: ${s.value}`);

    const byName = new Map<string, string[]>();
    for (const c of contacts) {
      const n = normName(c.name);
      // A single word ("Juan") is too common to mean anything on its own.
      if (n.split(" ").length < 2) continue;
      byName.set(n, [...(byName.get(n) ?? []), c.id]);
    }
    // Where each person has worked, from the facts Kernl keeps (also past
    // employers): a new contact whose company is one the other record already
    // moved to is the same person who changed jobs, not a namesake.
    const employers = new Map<string, Set<string>>();
    if (tableExists(this.db, "facts")) {
      const rows = this.db
        .prepare("SELECT subject, object FROM facts WHERE predicate = 'works_at' AND superseded_at IS NULL AND subject LIKE 'Person:%'")
        .all() as Array<{ subject: string; object: string }>;
      for (const r of rows) {
        const id = r.subject.slice("Person:".length);
        employers.set(id, (employers.get(id) ?? new Set()).add(normName(r.object)));
      }
    }
    for (const ids of byName.values()) {
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const ca = normName(info.get(ids[i])!.company);
          const cb = normName(info.get(ids[j])!.company);
          if (ca && cb && ca === cb) add(ids[i], ids[j], 0.8, "same name and company");
          else if (ca && cb && (employers.get(ids[i])?.has(cb) || employers.get(ids[j])?.has(ca))) {
            const [who, other] = employers.get(ids[i])?.has(cb) ? [ids[i], ids[j]] : [ids[j], ids[i]];
            add(ids[i], ids[j], 0.85, `same name; ${info.get(other)!.company} is where ${info.get(who)!.name} works, per the facts`);
          } else if (ca && cb) add(ids[i], ids[j], 0.4, "same name, different company");
          else add(ids[i], ids[j], 0.6, "same name");
        }
      }
    }
    return [...pairs.values()].sort((x, y) => y.score - x.score).slice(0, opts.limit ?? 50);
  }

  /**
   * `keepId` absorbs `mergeId`: empty fields are filled, notes appended,
   * identities, references in other tables and facts move over, and in the
   * graph every relationship of the absorbed Person moves to the kept one.
   * The absorbed contact is deleted after a snapshot is stored.
   */
  async merge(keepId: string, mergeId: string): Promise<{ kept: Contact; moved: Record<string, number> } | null> {
    if (keepId === mergeId) throw new Error("cannot merge a contact into itself");
    const keep = this.db.prepare("SELECT * FROM contacts WHERE id = ?").get(keepId) as Contact | undefined;
    const gone = this.db.prepare("SELECT * FROM contacts WHERE id = ?").get(mergeId) as Contact | undefined;
    if (!keep || !gone) return null;
    const moved: Record<string, number> = {};

    this.db.transaction(() => {
      const fill: Record<string, unknown> = {};
      for (const col of ["email", "phone", "company", "lead_source", "lead_status", "instagram_handle", "linkedin_url", "x_handle", "website", "project_id"] as const) {
        if (!keep[col] && gone[col]) fill[col] = gone[col];
      }
      if (gone.notes && !keep.notes.includes(gone.notes)) fill.notes = keep.notes ? `${keep.notes}\n\n${gone.notes}` : gone.notes;
      if (gone.last_interaction && (!keep.last_interaction || gone.last_interaction > keep.last_interaction)) {
        fill.last_interaction = gone.last_interaction;
      }
      if (gone.do_not_contact && !keep.do_not_contact) fill.do_not_contact = 1;
      const cols = Object.keys(fill);
      if (cols.length) {
        this.db
          .prepare(`UPDATE contacts SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
          .run(...cols.map((c) => fill[c] as string | number), isoNow(), keepId);
      }

      // Everything the absorbed contact was known by now names the kept one.
      syncContactIdentities(this.db, gone, "merge");
      moved.identities = Number(
        this.db.prepare("UPDATE OR IGNORE contact_identities SET contact_id = ? WHERE contact_id = ?").run(keepId, mergeId).changes,
      );
      this.db.prepare("DELETE FROM contact_identities WHERE contact_id = ?").run(mergeId);

      for (const { table, column } of referencingColumns(this.db)) {
        const n = Number(this.db.prepare(`UPDATE OR IGNORE ${table} SET ${column} = ? WHERE ${column} = ?`).run(keepId, mergeId).changes);
        // Rows left behind collided with a unique key: the kept contact already has them.
        this.db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(mergeId);
        if (n) moved[`${table}.${column}`] = n;
      }
      if (tableExists(this.db, "google_sync_map")) {
        const n = Number(this.db
          .prepare("UPDATE OR IGNORE google_sync_map SET local_id = ? WHERE local_id = ? AND local_table = 'contacts'")
          .run(keepId, mergeId).changes);
        if (n) moved.google_sync_map = n;
      }
      if (tableExists(this.db, "facts")) {
        const n = Number(this.db.prepare("UPDATE facts SET subject = ? WHERE subject = ?").run(`Person:${keepId}`, `Person:${mergeId}`).changes);
        if (n) moved.facts = n;
      }
      this.db.prepare("UPDATE contact_distinct SET a = ? WHERE a = ?").run(keepId, mergeId);
      this.db.prepare("UPDATE contact_distinct SET b = ? WHERE b = ?").run(keepId, mergeId);

      this.db
        .prepare("INSERT INTO contact_merges (id, kept_id, merged_id, snapshot, moved, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(newId(), keepId, mergeId, JSON.stringify(gone), JSON.stringify(moved), isoNow());
      this.db.prepare("DELETE FROM contacts WHERE id = ?").run(mergeId);
    })();

    const kept = this.db.prepare("SELECT * FROM contacts WHERE id = ?").get(keepId) as Contact;
    const graph = this.getGraph();
    if (graph?.capabilities.cypher) {
      try {
        // One transaction: a failure halfway used to leave the absorbed
        // Person in the graph with its relationships, and no backfill removes
        // a node.
        moved.graph_relationships = await inGraphTransaction(graph, (tx) => this.mergeInGraph(tx, kept, mergeId));
      } catch {
        // Nothing of the merge reached the graph; the kept Person is rewritten on its next write.
      }
    }
    return { kept, moved };
  }

  private async mergeInGraph(graph: GraphRunner, kept: Contact, mergeId: string): Promise<number> {
    await graph.run(
      `MERGE (p:Person {id: $id})
       SET p.name = $name, p.email = $email, p.company = $company, p.relationship = $relationship`,
      { id: kept.id, name: kept.name, email: kept.email, company: kept.company, relationship: kept.relationship },
    );
    const r = await graph.run(
      `MATCH (old:Person {id: $old}), (keep:Person {id: $keep})
       CALL (old, keep) {
         MATCH (old)-[r]->(x) WHERE x <> keep
         MERGE (keep)-[n:$(type(r))]->(x) SET n += properties(r)
         RETURN count(*) AS outgoing
       }
       CALL (old, keep) {
         MATCH (x)-[r]->(old) WHERE x <> keep
         MERGE (x)-[n:$(type(r))]->(keep) SET n += properties(r)
         RETURN count(*) AS incoming
       }
       DETACH DELETE old
       RETURN outgoing + incoming AS n`,
      { old: mergeId, keep: kept.id },
    );
    // Facts moved to the kept contact in SQLite; their nodes say so too.
    await graph.run("MATCH (f:Fact {subject: $old}) SET f.subject = $keep", {
      old: `Person:${mergeId}`,
      keep: `Person:${kept.id}`,
    });
    return Number(r.records[0]?.get("n") ?? 0);
  }

  /** Everything Kernl knows about one person, across modules. */
  async person360(contactId: string): Promise<Record<string, unknown> | null> {
    const c = this.db.prepare("SELECT * FROM contacts WHERE id = ?").get(contactId) as Contact | undefined;
    if (!c) return null;
    syncContactIdentities(this.db, c);
    const ids = this.identities(contactId);
    const emails = ids.filter((i) => i.kind === "email").map((i) => i.value_norm);
    const phones = ids.filter((i) => i.kind === "phone").map((i) => i.value_norm);
    const section = <T>(fn: () => T): T | { unavailable: string } => {
      try {
        return fn();
      } catch (err) {
        return { unavailable: err instanceof Error ? err.message.split("\n")[0] : String(err) };
      }
    };
    const inList = (n: number) => Array(n).fill("?").join(",");
    const count = (sql: string, ...p: unknown[]) => Number((this.db.prepare(sql).get(...p) as { n: number }).n);

    const out: Record<string, unknown> = {
      contact: c,
      identities: Object.fromEntries(
        (["email", "phone", "linkedin", "instagram", "x", "website"] as const)
          .map((k) => [k, ids.filter((i) => i.kind === k).map((i) => i.value)])
          .filter(([, v]) => (v as string[]).length),
      ),
      interactions: section(() => ({
        total: count("SELECT COUNT(*) AS n FROM interactions WHERE contact_id = ?", contactId),
        recent: this.db.prepare("SELECT type, summary, date FROM interactions WHERE contact_id = ? ORDER BY date DESC LIMIT 5").all(contactId),
      })),
    };

    if (tableExists(this.db, "communications")) {
      out.messages = section(() => ({
        total: count("SELECT COUNT(*) AS n FROM communications WHERE contact_id = ?", contactId),
        by_channel: this.db.prepare("SELECT channel, direction, COUNT(*) AS n FROM communications WHERE contact_id = ? GROUP BY channel, direction").all(contactId),
        recent: this.db
          .prepare(`SELECT channel, direction, subject, substr(body, 1, 160) AS preview, coalesce(sent_at, created_at) AS at
                    FROM communications WHERE contact_id = ? ORDER BY at DESC LIMIT 5`)
          .all(contactId),
      }));
    }
    if (emails.length && tableExists(this.db, "google_emails")) {
      out.mail = section(() => {
        const like = emails.map(() => "LOWER(to_emails || ' ' || cc_emails) LIKE ?").join(" OR ");
        const where = `LOWER(from_email) IN (${inList(emails.length)}) OR ${like}`;
        const p = [...emails, ...emails.map((e) => `%${e}%`)];
        return {
          total: count(`SELECT COUNT(*) AS n FROM google_emails WHERE ${where}`, ...p),
          from_them: count(`SELECT COUNT(*) AS n FROM google_emails WHERE LOWER(from_email) IN (${inList(emails.length)})`, ...emails),
          recent: this.db.prepare(`SELECT subject, from_email, date FROM google_emails WHERE ${where} ORDER BY date DESC LIMIT 5`).all(...p),
        };
      });
    }
    if (emails.length && tableExists(this.db, "google_calendar_events")) {
      out.calendar = section(() => {
        const where = `LOWER(organizer_email) IN (${inList(emails.length)}) OR ${emails.map(() => "LOWER(attendees) LIKE ?").join(" OR ")}`;
        const p = [...emails, ...emails.map((e) => `%${e}%`)];
        const now = isoNow();
        return {
          total: count(`SELECT COUNT(*) AS n FROM google_calendar_events WHERE ${where}`, ...p),
          next: this.db.prepare(`SELECT title, start_at FROM google_calendar_events WHERE (${where}) AND start_at >= ? ORDER BY start_at LIMIT 3`).all(...p, now),
          last: this.db.prepare(`SELECT title, start_at FROM google_calendar_events WHERE (${where}) AND start_at < ? ORDER BY start_at DESC LIMIT 3`).all(...p, now),
        };
      });
    }
    if (tableExists(this.db, "notes")) {
      out.notes = section(() => this.db.prepare("SELECT id, title, updated_at FROM notes WHERE contact_id = ? ORDER BY updated_at DESC LIMIT 5").all(contactId));
    }
    if (tableExists(this.db, "event_attendees")) {
      out.events = section(() =>
        this.db
          .prepare(`SELECT e.title, e.start_at, a.rsvp_status FROM event_attendees a JOIN events e ON e.id = a.event_id
                    WHERE a.contact_id = ?${phones.length ? ` OR a.phone IN (${inList(phones.length)})` : ""}
                    ORDER BY e.start_at DESC LIMIT 5`)
          .all(contactId, ...phones),
      );
    }
    if (tableExists(this.db, "facts")) {
      out.facts = section(() =>
        this.db
          .prepare(`SELECT predicate, object, valid_from FROM facts
                    WHERE subject = ? AND valid_to IS NULL AND superseded_at IS NULL ORDER BY predicate`)
          .all(`Person:${contactId}`),
      );
    }

    const graph = this.getGraph();
    if (graph?.capabilities.cypher) {
      try {
        const r = await graph.run(
          `MATCH (p:Person {id: $id})-[r]-(m)
           WITH type(r) AS rel, startNode(r) = p AS out, labels(m)[0] AS label,
                [x IN [m.name, m.title, m.subject] WHERE x IS NOT NULL AND x <> ''][0] AS name
           RETURN rel, out, label, count(*) AS n, collect(name)[0..3] AS sample
           ORDER BY n DESC LIMIT 20`,
          { id: contactId },
        );
        out.graph = r.records.map((x) => ({
          rel: x.get("rel"), out: x.get("out"), label: x.get("label"), count: Number(x.get("n")), sample: x.get("sample"),
        }));
      } catch {
        out.graph = { unavailable: "graph query failed" };
      }
    }

    const dups = this.duplicates({ contactId, limit: 5 });
    if (dups.length) out.possible_duplicates = dups;
    const merges = this.db.prepare("SELECT merged_id, created_at FROM contact_merges WHERE kept_id = ?").all(contactId);
    if (merges.length) out.merged_from = merges;
    return out;
  }
}
