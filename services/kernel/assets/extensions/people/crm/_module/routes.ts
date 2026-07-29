import crypto from "node:crypto";
import type { KernelHttpServer } from "../../../../../src/core/http-server.js";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { EventBus } from "../../../../../src/core/event-bus.js";

export function registerContactsRoutes(
  server: KernelHttpServer,
  db: SqliteDb,
  events?: EventBus,
): void {
  server.get("/api/contacts/all", async (req, res) => {
    try {
      const url = new URL(req.url ?? "", "http://localhost");
      const q = url.searchParams.get("q") ?? "";
      const rel = url.searchParams.get("relationship") ?? "";
      const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1"));
      const limit = Math.min(100, Math.max(10, parseInt(url.searchParams.get("limit") ?? "50")));
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
      server.json(res, 200, { contacts: rows, total, page, limit });
    } catch { server.json(res, 500, { error: "Failed to fetch contacts" }); }
  });

  server.get("/api/contacts/detail", async (req, res) => {
    try {
      const url = new URL(req.url ?? "", "http://localhost");
      const id = url.searchParams.get("id") ?? "";
      if (!id) { server.json(res, 400, { error: "Missing id" }); return; }
      const contact = db.prepare("SELECT * FROM contacts WHERE id = ?").get(id);
      if (!contact) { server.json(res, 404, { error: "Not found" }); return; }
      const interactions = db.prepare(
        "SELECT id, type, summary, date, created_at FROM interactions WHERE contact_id = ? ORDER BY date DESC LIMIT 20"
      ).all(id);
      server.json(res, 200, { contact, interactions });
    } catch { server.json(res, 500, { error: "Failed" }); }
  });

  server.post("/api/contacts/create", async (req, res) => {
    try {
      const body = await server.parseBody<{
        name: string; email?: string; phone?: string; company?: string;
        relationship?: string; notes?: string;
      }>(req);
      if (!body.name?.trim()) { server.json(res, 400, { error: "Name required" }); return; }
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO contacts (id, name, email, phone, company, relationship, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, body.name.trim(), body.email ?? "", body.phone ?? "", body.company ?? "",
        body.relationship ?? "acquaintance", body.notes ?? "", now, now);
      events?.emit("data.changed", { module: "crm", action: "create" });
      server.json(res, 200, { ok: true, id });
    } catch { server.json(res, 400, { error: "Invalid request" }); }
  });

  server.post("/api/contacts/update", async (req, res) => {
    try {
      const body = await server.parseBody<{
        id: string; name?: string; email?: string; phone?: string;
        company?: string; relationship?: string; notes?: string;
      }>(req);
      if (!body.id) { server.json(res, 400, { error: "Missing id" }); return; }
      const fields: string[] = [];
      const vals: unknown[] = [];
      for (const f of ["name", "email", "phone", "company", "relationship", "notes"] as const) {
        if (body[f] !== undefined) { fields.push(`${f} = ?`); vals.push(body[f]); }
      }
      if (!fields.length) { server.json(res, 400, { error: "No fields" }); return; }
      const now = new Date().toISOString();
      fields.push("updated_at = ?"); vals.push(now);
      vals.push(body.id);
      db.prepare(`UPDATE contacts SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
      events?.emit("data.changed", { module: "crm", action: "update" });
      server.json(res, 200, { ok: true });
    } catch { server.json(res, 400, { error: "Invalid request" }); }
  });

  server.post("/api/contacts/delete", async (req, res) => {
    try {
      const body = await server.parseBody<{ id: string }>(req);
      if (!body.id) { server.json(res, 400, { error: "Missing id" }); return; }
      db.prepare("DELETE FROM contacts WHERE id = ?").run(body.id);
      events?.emit("data.changed", { module: "crm", action: "delete" });
      server.json(res, 200, { ok: true });
    } catch { server.json(res, 400, { error: "Invalid request" }); }
  });

  server.post("/api/contacts/log-interaction", async (req, res) => {
    try {
      const body = await server.parseBody<{
        contact_id: string; type?: string; summary?: string; date?: string;
      }>(req);
      if (!body.contact_id) { server.json(res, 400, { error: "Missing contact_id" }); return; }
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
      server.json(res, 200, { ok: true, id });
    } catch { server.json(res, 400, { error: "Invalid request" }); }
  });
}
