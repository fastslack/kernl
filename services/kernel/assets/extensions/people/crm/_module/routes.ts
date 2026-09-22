import crypto from "node:crypto";
import { HttpError, isHttpError, type KernelHttpServer, type SqliteDb, type EventBus } from "@kernl/extension-sdk";

export function registerContactsRoutes(
  server: KernelHttpServer,
  db: SqliteDb,
  events?: EventBus,
): void {
  /** Runs `fn`, answering any failure but a deliberate HttpError with `status` + `message`. */
  const failAs = <T>(status: number, message: string, fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      if (isHttpError(err)) throw err;
      throw new HttpError(status, message);
    }
  };

  server.route("GET", "/api/contacts/all", ({ query }) => failAs(500, "Failed to fetch contacts", () => {
    const q = query.get("q") ?? "";
    const rel = query.get("relationship") ?? "";
    const page = Math.max(1, parseInt(query.get("page") ?? "1"));
    const limit = Math.min(100, Math.max(10, parseInt(query.get("limit") ?? "50")));
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
  }));

  server.route("GET", "/api/contacts/detail", ({ query }) => failAs(500, "Failed", () => {
    const id = query.get("id") ?? "";
    if (!id) throw new HttpError(400, "Missing id");
    const contact = db.prepare("SELECT * FROM contacts WHERE id = ?").get(id);
    if (!contact) throw new HttpError(404, "Not found");
    const interactions = db.prepare(
      "SELECT id, type, summary, date, created_at FROM interactions WHERE contact_id = ? ORDER BY date DESC LIMIT 20"
    ).all(id);
    return { contact, interactions };
  }));

  server.route<{
    name: string; email?: string; phone?: string; company?: string;
    relationship?: string; notes?: string;
  }>("POST", "/api/contacts/create", ({ body }) => failAs(400, "Invalid request", () => {
    if (!body.name?.trim()) throw new HttpError(400, "Name required");
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO contacts (id, name, email, phone, company, relationship, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, body.name.trim(), body.email ?? "", body.phone ?? "", body.company ?? "",
      body.relationship ?? "acquaintance", body.notes ?? "", now, now);
    events?.emit("data.changed", { module: "crm", action: "create" });
    return { ok: true, id };
  }));

  server.route<{
    id: string; name?: string; email?: string; phone?: string;
    company?: string; relationship?: string; notes?: string;
  }>("POST", "/api/contacts/update", ({ body }) => failAs(400, "Invalid request", () => {
    if (!body.id) throw new HttpError(400, "Missing id");
    const fields: string[] = [];
    const vals: unknown[] = [];
    for (const f of ["name", "email", "phone", "company", "relationship", "notes"] as const) {
      if (body[f] !== undefined) { fields.push(`${f} = ?`); vals.push(body[f]); }
    }
    if (!fields.length) throw new HttpError(400, "No fields");
    const now = new Date().toISOString();
    fields.push("updated_at = ?"); vals.push(now);
    vals.push(body.id);
    db.prepare(`UPDATE contacts SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
    events?.emit("data.changed", { module: "crm", action: "update" });
    return { ok: true };
  }));

  server.route<{ id: string }>("POST", "/api/contacts/delete", ({ body }) => failAs(400, "Invalid request", () => {
    if (!body.id) throw new HttpError(400, "Missing id");
    db.prepare("DELETE FROM contacts WHERE id = ?").run(body.id);
    events?.emit("data.changed", { module: "crm", action: "delete" });
    return { ok: true };
  }));

  server.route<{
    contact_id: string; type?: string; summary?: string; date?: string;
  }>("POST", "/api/contacts/log-interaction", ({ body }) => failAs(400, "Invalid request", () => {
    if (!body.contact_id) throw new HttpError(400, "Missing contact_id");
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const date = body.date ?? now.split("T")[0];
    db.prepare(
      `INSERT INTO interactions (id, contact_id, type, summary, date, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, body.contact_id, body.type ?? "other", body.summary ?? "", date, now);
    db.prepare("UPDATE contacts SET last_interaction = ?, updated_at = ? WHERE id = ?")
      .run(date, now, body.contact_id);
    events?.emit("data.changed", { module: "crm", action: "log_interaction" });
    return { ok: true, id };
  }));
}
