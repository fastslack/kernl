/**
 * CRM/Contacts RPC Actions — replaces /api/contacts/* routes.
 */

import crypto from "node:crypto";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { RpcAction } from "../../../../../src/core/mtw/rpc-handler.js";

export function contactsRpcActions(db: SqliteDb): RpcAction[] {
  return [
    {
      name: "contacts.list",
      handler: async (args) => {
        const q = typeof args.q === "string" ? args.q : "";
        const rel = typeof args.relationship === "string" ? args.relationship : "";
        const page = Math.max(1, typeof args.page === "number" ? args.page : 1);
        const limit = Math.min(100, Math.max(10, typeof args.limit === "number" ? args.limit : 50));
        const offset = (page - 1) * limit;

        let where = "1=1";
        const params: unknown[] = [];
        if (q) { where += " AND (name LIKE ? OR email LIKE ? OR company LIKE ?)"; const p = `%${q}%`; params.push(p, p, p); }
        if (rel) { where += " AND relationship = ?"; params.push(rel); }

        const total = (db.prepare(`SELECT COUNT(*) as c FROM contacts WHERE ${where}`).get(...params) as { c: number }).c;
        const rows = db.prepare(
          `SELECT id, name, email, phone, company, relationship, notes, last_interaction, created_at, updated_at
           FROM contacts WHERE ${where}
           ORDER BY last_interaction DESC NULLS LAST, name COLLATE NOCASE
           LIMIT ? OFFSET ?`
        ).all(...params, limit, offset);
        return { contacts: rows, total, page, limit };
      },
    },
    {
      name: "contacts.detail",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) throw new Error("Missing id");
        const contact = db.prepare("SELECT * FROM contacts WHERE id = ?").get(id);
        if (!contact) throw new Error("Not found");
        const interactions = db.prepare(
          "SELECT id, type, summary, date, created_at FROM interactions WHERE contact_id = ? ORDER BY date DESC LIMIT 20"
        ).all(id);
        return { contact, interactions };
      },
    },
    {
      name: "contacts.create",
      handler: async (args) => {
        const name = typeof args.name === "string" ? args.name.trim() : "";
        if (!name) throw new Error("Name required");
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        db.prepare(
          `INSERT INTO contacts (id, name, email, phone, company, relationship, notes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(id, name, args.email ?? "", args.phone ?? "", args.company ?? "",
          args.relationship ?? "acquaintance", args.notes ?? "", now, now);
        return { ok: true, id };
      },
    },
    {
      name: "contacts.update",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) throw new Error("Missing id");
        const fields: string[] = [];
        const vals: unknown[] = [];
        for (const f of ["name", "email", "phone", "company", "relationship", "notes"]) {
          if (args[f] !== undefined) { fields.push(`${f} = ?`); vals.push(args[f]); }
        }
        if (!fields.length) throw new Error("No fields");
        const now = new Date().toISOString();
        fields.push("updated_at = ?"); vals.push(now);
        vals.push(id);
        db.prepare(`UPDATE contacts SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
        return { ok: true };
      },
    },
    {
      name: "contacts.delete",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) throw new Error("Missing id");
        db.prepare("DELETE FROM contacts WHERE id = ?").run(id);
        return { ok: true };
      },
    },
    {
      name: "contacts.logInteraction",
      handler: async (args) => {
        const contactId = typeof args.contact_id === "string" ? args.contact_id : "";
        if (!contactId) throw new Error("Missing contact_id");
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        const date = typeof args.date === "string" ? args.date : now.split("T")[0];
        db.prepare(
          `INSERT INTO interactions (id, contact_id, type, summary, date, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(id, contactId, args.type ?? "other", args.summary ?? "", date, now);
        db.prepare("UPDATE contacts SET last_interaction = ?, updated_at = ? WHERE id = ?")
          .run(date, now, contactId);
        return { ok: true, id };
      },
    },
  ];
}
