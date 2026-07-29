import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type {
  LearningResource, LearningHighlight, LearningFlashcard,
  LearningReview, LearningGoal, ResourceType, ResourceStatus, HighlightType,
} from "./types.js";
import { newId, isoNow } from "../../../../../src/core/helpers.js";

/** SM-2 spaced repetition algorithm */
function sm2(card: LearningFlashcard, quality: number): {
  ease_factor: number; interval_days: number; repetitions: number; next_review: string;
} {
  // quality: 0-5 (0=blackout, 3=correct with effort, 5=perfect)
  let { ease_factor, interval_days, repetitions } = card;

  if (quality < 3) {
    // Failed — reset
    repetitions = 0;
    interval_days = 1;
  } else {
    if (repetitions === 0) interval_days = 1;
    else if (repetitions === 1) interval_days = 6;
    else interval_days = Math.round(interval_days * ease_factor);
    repetitions += 1;
  }

  ease_factor = Math.max(1.3, ease_factor + 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));

  const next = new Date();
  next.setDate(next.getDate() + interval_days);
  const next_review = next.toISOString().split("T")[0];

  return { ease_factor, interval_days, repetitions, next_review };
}

export class LearningService {
  constructor(private db: SqliteDb) {}

  // ── Resources ─────────────────────────────────────────────────────────────

  addResource(input: {
    type?: ResourceType; title: string; author?: string;
    url?: string; isbn?: string; source?: string;
    status?: ResourceStatus; priority?: "low" | "medium" | "high";
    total_pages?: number; total_hours?: number; tags?: string[]; notes?: string;
  }): LearningResource {
    const now = isoNow();
    const resource: LearningResource = {
      id: newId(), type: input.type ?? "book", title: input.title,
      author: input.author ?? "", url: input.url ?? "",
      isbn: input.isbn ?? "", source: input.source ?? "",
      status: input.status ?? "wishlist", priority: input.priority ?? "medium",
      rating: null, started_at: null, completed_at: null,
      total_pages: input.total_pages ?? 0, current_page: 0,
      total_hours: input.total_hours ?? 0, spent_hours: 0,
      tags: JSON.stringify(input.tags ?? []),
      notes: input.notes ?? "", summary: "",
      created_at: now, updated_at: now,
    };
    this.db.prepare(`
      INSERT INTO learning_resources
        (id,type,title,author,url,isbn,source,status,priority,rating,started_at,completed_at,
         total_pages,current_page,total_hours,spent_hours,tags,notes,summary,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      resource.id,resource.type,resource.title,resource.author,resource.url,resource.isbn,
      resource.source,resource.status,resource.priority,resource.rating,resource.started_at,
      resource.completed_at,resource.total_pages,resource.current_page,resource.total_hours,
      resource.spent_hours,resource.tags,resource.notes,resource.summary,
      resource.created_at,resource.updated_at,
    );
    return resource;
  }

  updateResource(id: string, changes: Partial<{
    status: ResourceStatus; priority: "low" | "medium" | "high";
    current_page: number; spent_hours: number; rating: number;
    notes: string; summary: string; tags: string[];
    started_at: string; completed_at: string;
  }>): LearningResource | undefined {
    const existing = this.db.prepare("SELECT * FROM learning_resources WHERE id = ?").get(id) as LearningResource | undefined;
    if (!existing) return undefined;
    const tags = changes.tags ? JSON.stringify(changes.tags) : existing.tags;
    const updated: LearningResource = {
      ...existing,
      ...changes,
      tags,
      updated_at: isoNow(),
    };
    this.db.prepare(`
      UPDATE learning_resources SET status=?,priority=?,current_page=?,spent_hours=?,rating=?,
      notes=?,summary=?,tags=?,started_at=?,completed_at=?,updated_at=? WHERE id=?
    `).run(
      updated.status,updated.priority,updated.current_page,updated.spent_hours,updated.rating,
      updated.notes,updated.summary,updated.tags,updated.started_at,updated.completed_at,
      updated.updated_at,id,
    );
    return updated;
  }

  listResources(filters?: {
    type?: ResourceType; status?: ResourceStatus; search?: string; limit?: number;
  }): LearningResource[] {
    let sql = "SELECT * FROM learning_resources WHERE 1=1";
    const params: unknown[] = [];
    if (filters?.type) { sql += " AND type = ?"; params.push(filters.type); }
    if (filters?.status) { sql += " AND status = ?"; params.push(filters.status); }
    if (filters?.search) {
      sql += " AND (title LIKE ? OR author LIKE ? OR notes LIKE ?)";
      const q = `%${filters.search}%`;
      params.push(q, q, q);
    }
    sql += " ORDER BY updated_at DESC";
    if (filters?.limit) { sql += " LIMIT ?"; params.push(filters.limit); }
    return this.db.prepare(sql).all(...params) as LearningResource[];
  }

  getResource(id: string): LearningResource | undefined {
    return this.db.prepare("SELECT * FROM learning_resources WHERE id = ?").get(id) as LearningResource | undefined;
  }

  getCurrentlyReading(): LearningResource[] {
    return this.db.prepare(
      "SELECT * FROM learning_resources WHERE status = 'in_progress' ORDER BY updated_at DESC"
    ).all() as LearningResource[];
  }

  // ── Highlights ────────────────────────────────────────────────────────────

  addHighlight(input: {
    resource_id: string; content: string;
    location?: string; type?: HighlightType;
  }): LearningHighlight {
    const highlight: LearningHighlight = {
      id: newId(), resource_id: input.resource_id, content: input.content,
      location: input.location ?? "", type: input.type ?? "highlight",
      created_at: isoNow(),
    };
    this.db.prepare(`
      INSERT INTO learning_highlights (id,resource_id,content,location,type,created_at)
      VALUES (?,?,?,?,?,?)
    `).run(highlight.id,highlight.resource_id,highlight.content,highlight.location,highlight.type,highlight.created_at);
    return highlight;
  }

  listHighlights(resourceId: string): LearningHighlight[] {
    return this.db.prepare(
      "SELECT * FROM learning_highlights WHERE resource_id = ? ORDER BY created_at ASC"
    ).all(resourceId) as LearningHighlight[];
  }

  // ── Flashcards ────────────────────────────────────────────────────────────

  addFlashcard(input: {
    front: string; back: string; deck?: string;
    resource_id?: string; tags?: string[];
  }): LearningFlashcard {
    const today = new Date().toISOString().split("T")[0];
    const now = isoNow();
    const card: LearningFlashcard = {
      id: newId(), resource_id: input.resource_id ?? null,
      deck: input.deck ?? "general", front: input.front, back: input.back,
      tags: JSON.stringify(input.tags ?? []),
      ease_factor: 2.5, interval_days: 1, repetitions: 0,
      next_review: today, last_reviewed: null,
      created_at: now, updated_at: now,
    };
    this.db.prepare(`
      INSERT INTO learning_flashcards
        (id,resource_id,deck,front,back,tags,ease_factor,interval_days,repetitions,next_review,last_reviewed,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      card.id,card.resource_id,card.deck,card.front,card.back,card.tags,
      card.ease_factor,card.interval_days,card.repetitions,card.next_review,
      card.last_reviewed,card.created_at,card.updated_at,
    );
    return card;
  }

  getDueCards(deck?: string, limit = 20): LearningFlashcard[] {
    const today = new Date().toISOString().split("T")[0];
    let sql = "SELECT * FROM learning_flashcards WHERE next_review <= ?";
    const params: unknown[] = [today];
    if (deck) { sql += " AND deck = ?"; params.push(deck); }
    sql += " ORDER BY next_review ASC LIMIT ?";
    params.push(limit);
    return this.db.prepare(sql).all(...params) as LearningFlashcard[];
  }

  reviewCard(cardId: string, quality: number): LearningFlashcard | undefined {
    const card = this.db.prepare("SELECT * FROM learning_flashcards WHERE id = ?").get(cardId) as LearningFlashcard | undefined;
    if (!card) return undefined;

    const { ease_factor, interval_days, repetitions, next_review } = sm2(card, quality);
    const now = isoNow();

    this.db.prepare(`
      UPDATE learning_flashcards SET ease_factor=?,interval_days=?,repetitions=?,
      next_review=?,last_reviewed=?,updated_at=? WHERE id=?
    `).run(ease_factor, interval_days, repetitions, next_review, now, now, cardId);

    // Log review
    const review: LearningReview = { id: newId(), card_id: cardId, quality, reviewed_at: now };
    this.db.prepare("INSERT INTO learning_reviews (id,card_id,quality,reviewed_at) VALUES (?,?,?,?)")
      .run(review.id, review.card_id, review.quality, review.reviewed_at);

    return { ...card, ease_factor, interval_days, repetitions, next_review, last_reviewed: now, updated_at: now };
  }

  listDecks(): Array<{ deck: string; total: number; due: number }> {
    const today = new Date().toISOString().split("T")[0];
    return this.db.prepare(`
      SELECT deck, COUNT(*) as total,
             SUM(CASE WHEN next_review <= ? THEN 1 ELSE 0 END) as due
      FROM learning_flashcards GROUP BY deck ORDER BY deck ASC
    `).all(today) as Array<{ deck: string; total: number; due: number }>;
  }

  // ── Goals ─────────────────────────────────────────────────────────────────

  addGoal(input: {
    title: string; description?: string; target_date?: string;
  }): LearningGoal {
    const now = isoNow();
    const goal: LearningGoal = {
      id: newId(), title: input.title, description: input.description ?? "",
      target_date: input.target_date ?? null, status: "active",
      created_at: now, updated_at: now,
    };
    this.db.prepare(`
      INSERT INTO learning_goals (id,title,description,target_date,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)
    `).run(goal.id,goal.title,goal.description,goal.target_date,goal.status,goal.created_at,goal.updated_at);
    return goal;
  }

  listGoals(): LearningGoal[] {
    return this.db.prepare("SELECT * FROM learning_goals ORDER BY created_at DESC").all() as LearningGoal[];
  }

  addResourceToGoal(goalId: string, resourceId: string, order = 0): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO learning_goal_resources (goal_id,resource_id,order_idx) VALUES (?,?,?)
    `).run(goalId, resourceId, order);
  }

  getStats(): {
    total: number; by_status: Record<string, number>; by_type: Record<string, number>;
    due_cards: number; decks: number; highlights: number;
  } {
    const resources = this.db.prepare("SELECT status, type FROM learning_resources").all() as Array<{ status: string; type: string }>;
    const by_status: Record<string, number> = {};
    const by_type: Record<string, number> = {};
    for (const r of resources) {
      by_status[r.status] = (by_status[r.status] ?? 0) + 1;
      by_type[r.type] = (by_type[r.type] ?? 0) + 1;
    }
    const today = new Date().toISOString().split("T")[0];
    const due_cards = (this.db.prepare("SELECT COUNT(*) as c FROM learning_flashcards WHERE next_review <= ?").get(today) as { c: number }).c;
    const decks = (this.db.prepare("SELECT COUNT(DISTINCT deck) as c FROM learning_flashcards").get() as { c: number }).c;
    const highlights = (this.db.prepare("SELECT COUNT(*) as c FROM learning_highlights").get() as { c: number }).c;
    return { total: resources.length, by_status, by_type, due_cards, decks, highlights };
  }
}
