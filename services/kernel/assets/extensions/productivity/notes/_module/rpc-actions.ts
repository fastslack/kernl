/**
 * Notes RPC Actions — CRUD + search via mtwRequest.
 */

import crypto from "node:crypto";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { RpcAction } from "../../../../../src/core/mtw/rpc-handler.js";

export function notesRpcActions(db: SqliteDb): RpcAction[] {
  return [
    {
      name: "notes.list",
      handler: async (args) => {
        const tag = typeof args.tag === "string" ? args.tag : "";
        const pinned = args.pinned === true ? 1 : undefined;
        const limit = Math.min(200, Math.max(10, typeof args.limit === "number" ? args.limit : 50));
        const offset = typeof args.offset === "number" ? args.offset : 0;

        let where = "1=1";
        const params: unknown[] = [];
        if (tag) { where += " AND tags LIKE ?"; params.push(`%${tag}%`); }
        if (pinned !== undefined) { where += " AND pinned = ?"; params.push(pinned); }

        const rows = db.prepare(
          `SELECT id, title, body, tags, pinned, contact_id, task_id, created_at, updated_at
           FROM notes WHERE ${where} ORDER BY pinned DESC, updated_at DESC LIMIT ? OFFSET ?`,
        ).all(...params, limit, offset);
        return { notes: rows };
      },
    },
    {
      name: "notes.create",
      handler: async (args) => {
        const title = typeof args.title === "string" ? args.title.trim() : "";
        if (!title) throw new Error("Title required");
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        db.prepare(
          `INSERT INTO notes (id, title, body, tags, pinned, contact_id, task_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, title, args.body ?? "", args.tags ?? "", args.pinned ? 1 : 0, args.contact_id ?? null, args.task_id ?? null, now, now);
        // Update FTS
        try { db.prepare("INSERT INTO notes_fts (note_id, title, body, tags) VALUES (?, ?, ?, ?)").run(id, title, args.body ?? "", args.tags ?? ""); } catch {}
        return { ok: true, id };
      },
    },
    {
      name: "notes.update",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) throw new Error("Missing id");
        const fields: string[] = [];
        const vals: unknown[] = [];
        for (const f of ["title", "body", "tags", "contact_id", "task_id"]) {
          if (args[f] !== undefined) { fields.push(`${f} = ?`); vals.push(args[f]); }
        }
        if (args.pinned !== undefined) { fields.push("pinned = ?"); vals.push(args.pinned ? 1 : 0); }
        if (!fields.length) throw new Error("No fields");
        const now = new Date().toISOString();
        fields.push("updated_at = ?"); vals.push(now);
        vals.push(id);
        db.prepare(`UPDATE notes SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
        // Update FTS
        try {
          const note = db.prepare("SELECT title, body, tags FROM notes WHERE id = ?").get(id) as { title: string; body: string; tags: string } | undefined;
          if (note) {
            db.prepare("DELETE FROM notes_fts WHERE note_id = ?").run(id);
            db.prepare("INSERT INTO notes_fts (note_id, title, body, tags) VALUES (?, ?, ?, ?)").run(id, note.title, note.body, note.tags);
          }
        } catch {}
        return { ok: true };
      },
    },
    {
      name: "notes.delete",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) throw new Error("Missing id");
        db.prepare("DELETE FROM notes WHERE id = ?").run(id);
        try { db.prepare("DELETE FROM notes_fts WHERE note_id = ?").run(id); } catch {}
        return { ok: true };
      },
    },
    {
      name: "notes.search",
      handler: async (args) => {
        const q = typeof args.q === "string" ? args.q.trim() : "";
        if (!q) throw new Error("Query required");
        const limit = Math.min(50, typeof args.limit === "number" ? args.limit : 20);
        const rows = db.prepare(
          `SELECT n.id, n.title, n.body, n.tags, n.pinned, n.created_at, n.updated_at
           FROM notes_fts f JOIN notes n ON f.note_id = n.id
           WHERE notes_fts MATCH ? ORDER BY rank LIMIT ?`,
        ).all(q, limit);
        return { notes: rows };
      },
    },
  ];
}
