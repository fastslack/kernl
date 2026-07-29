/**
 * Learning RPC Actions — resources, highlights, flashcards, goals via mtwRequest.
 */

import crypto from "node:crypto";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { RpcAction } from "../../../../../src/core/mtw/rpc-handler.js";

export function learningRpcActions(db: SqliteDb): RpcAction[] {
  return [
    {
      name: "learning.resources.list",
      handler: async (args) => {
        const status = typeof args.status === "string" ? args.status : "";
        const type = typeof args.type === "string" ? args.type : "";
        const limit = Math.min(200, typeof args.limit === "number" ? args.limit : 50);

        let where = "1=1";
        const params: unknown[] = [];
        if (status) { where += " AND status = ?"; params.push(status); }
        if (type) { where += " AND type = ?"; params.push(type); }

        const rows = db.prepare(
          `SELECT id, type, title, author, url, status, priority, rating, started_at, completed_at,
                  total_pages, current_page, total_hours, spent_hours, tags, notes, created_at, updated_at
           FROM learning_resources WHERE ${where}
           ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'wishlist' THEN 1 ELSE 2 END, updated_at DESC LIMIT ?`,
        ).all(...params, limit);
        return { resources: rows };
      },
    },
    {
      name: "learning.resources.detail",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) throw new Error("Missing id");
        const resource = db.prepare("SELECT * FROM learning_resources WHERE id = ?").get(id);
        if (!resource) throw new Error("Not found");
        const highlights = db.prepare(
          "SELECT id, content, location, type, created_at FROM learning_highlights WHERE resource_id = ? ORDER BY created_at",
        ).all(id);
        return { resource, highlights };
      },
    },
    {
      name: "learning.resources.create",
      handler: async (args) => {
        const title = typeof args.title === "string" ? args.title.trim() : "";
        if (!title) throw new Error("Title required");
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        db.prepare(
          `INSERT INTO learning_resources (id, type, title, author, url, isbn, source, status, priority, rating,
           started_at, completed_at, total_pages, current_page, total_hours, spent_hours, tags, notes, summary, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id, args.type ?? "book", title, args.author ?? "", args.url ?? "",
          args.isbn ?? "", args.source ?? "", args.status ?? "wishlist",
          args.priority ?? "medium", args.rating ?? null,
          args.started_at ?? null, args.completed_at ?? null,
          args.total_pages ?? null, args.current_page ?? null,
          args.total_hours ?? null, args.spent_hours ?? null,
          typeof args.tags === "string" ? args.tags : JSON.stringify(args.tags ?? []),
          args.notes ?? "", args.summary ?? "", now, now,
        );
        return { ok: true, id };
      },
    },
    {
      name: "learning.resources.update",
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) throw new Error("Missing id");
        const fields: string[] = [];
        const vals: unknown[] = [];
        for (const f of ["type", "title", "author", "url", "isbn", "source", "status", "priority", "rating",
          "started_at", "completed_at", "total_pages", "current_page", "total_hours", "spent_hours", "tags", "notes", "summary"]) {
          if (args[f] !== undefined) {
            fields.push(`${f} = ?`);
            vals.push(f === "tags" && typeof args[f] !== "string" ? JSON.stringify(args[f]) : args[f]);
          }
        }
        if (!fields.length) throw new Error("No fields");
        const now = new Date().toISOString();
        fields.push("updated_at = ?"); vals.push(now);
        vals.push(id);
        db.prepare(`UPDATE learning_resources SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
        return { ok: true };
      },
    },
    {
      name: "learning.highlights.list",
      handler: async (args) => {
        const resourceId = typeof args.resource_id === "string" ? args.resource_id : "";
        if (!resourceId) throw new Error("resource_id required");
        const rows = db.prepare(
          "SELECT id, content, location, type, created_at FROM learning_highlights WHERE resource_id = ? ORDER BY created_at",
        ).all(resourceId);
        return { highlights: rows };
      },
    },
    {
      name: "learning.highlights.add",
      handler: async (args) => {
        const resourceId = typeof args.resource_id === "string" ? args.resource_id : "";
        const content = typeof args.content === "string" ? args.content.trim() : "";
        if (!resourceId || !content) throw new Error("resource_id and content required");
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        db.prepare(
          "INSERT INTO learning_highlights (id, resource_id, content, location, type, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(id, resourceId, content, args.location ?? "", args.type ?? "highlight", now);
        return { ok: true, id };
      },
    },
    {
      name: "learning.flashcards.due",
      handler: async (args) => {
        const deck = typeof args.deck === "string" ? args.deck : "";
        const limit = Math.min(50, typeof args.limit === "number" ? args.limit : 20);
        const now = new Date().toISOString();

        let where = "(next_review IS NULL OR next_review <= ?)";
        const params: unknown[] = [now];
        if (deck) { where += " AND deck = ?"; params.push(deck); }

        const rows = db.prepare(
          `SELECT id, resource_id, deck, front, back, tags, ease_factor, interval_days, repetitions, next_review, last_reviewed
           FROM learning_flashcards WHERE ${where} ORDER BY next_review ASC NULLS FIRST LIMIT ?`,
        ).all(...params, limit);
        return { cards: rows };
      },
    },
    {
      name: "learning.flashcards.review",
      handler: async (args) => {
        const cardId = typeof args.card_id === "string" ? args.card_id : "";
        const quality = typeof args.quality === "number" ? args.quality : 3;
        if (!cardId || quality < 0 || quality > 5) throw new Error("card_id and quality (0-5) required");

        const card = db.prepare("SELECT * FROM learning_flashcards WHERE id = ?").get(cardId) as any;
        if (!card) throw new Error("Card not found");

        // SM-2 algorithm
        let ef = card.ease_factor;
        let interval = card.interval_days;
        let reps = card.repetitions;

        if (quality >= 3) {
          if (reps === 0) interval = 1;
          else if (reps === 1) interval = 6;
          else interval = Math.round(interval * ef);
          reps++;
        } else {
          reps = 0;
          interval = 1;
        }
        ef = Math.max(1.3, ef + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)));

        const now = new Date().toISOString();
        const nextReview = new Date(Date.now() + interval * 86400000).toISOString();

        db.prepare(
          "UPDATE learning_flashcards SET ease_factor = ?, interval_days = ?, repetitions = ?, next_review = ?, last_reviewed = ?, updated_at = ? WHERE id = ?",
        ).run(ef, interval, reps, nextReview, now, now, cardId);

        // Log review
        const reviewId = crypto.randomUUID();
        db.prepare("INSERT INTO learning_reviews (id, card_id, quality, reviewed_at) VALUES (?, ?, ?, ?)")
          .run(reviewId, cardId, quality, now);

        return { ok: true, nextReview, interval, easeFactor: ef };
      },
    },
    {
      name: "learning.stats",
      handler: async () => {
        const total = db.prepare("SELECT COUNT(*) as c FROM learning_resources").get() as { c: number };
        const byStatus = db.prepare(
          "SELECT status, COUNT(*) as count FROM learning_resources GROUP BY status",
        ).all();
        const dueCards = db.prepare(
          "SELECT COUNT(*) as c FROM learning_flashcards WHERE next_review IS NULL OR next_review <= ?",
        ).get(new Date().toISOString()) as { c: number };
        const totalCards = db.prepare("SELECT COUNT(*) as c FROM learning_flashcards").get() as { c: number };
        const recentReviews = db.prepare(
          "SELECT COUNT(*) as c FROM learning_reviews WHERE reviewed_at >= ?",
        ).get(new Date(Date.now() - 7 * 86400000).toISOString()) as { c: number };
        return { totalResources: total.c, byStatus, dueCards: dueCards.c, totalCards: totalCards.c, weeklyReviews: recentReviews.c };
      },
    },
  ];
}
