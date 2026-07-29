import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { isoNow } from "../../../../../src/core/helpers.js";

export interface ReaderState {
  item_id: string;
  read: number;
  starred: number;
  read_at: string | null;
  starred_at: string | null;
  updated_at: string;
}

export interface ReaderItem {
  id: string;
  feed_id: string;
  guid: string;
  title: string;
  link: string;
  author: string;
  description: string;
  content: string;
  image_url: string;
  published_at: string | null;
  fetched_at: string;
  feed_name: string;
  feed_slug: string;
  feed_url: string;
  category_id: string | null;
  category_name: string | null;
  category_icon: string | null;
  language: string;
  read: number;
  starred: number;
  read_at: string | null;
}

export interface ReaderListQuery {
  feed_id?: string;
  category_id?: string;
  unread_only?: boolean;
  starred_only?: boolean;
  search?: string;
  since?: string;
  limit?: number;
  offset?: number;
}

export interface ReaderStats {
  total_items: number;
  unread: number;
  starred: number;
  unread_by_feed: Record<string, number>;
  unread_by_category: Record<string, number>;
  unread_today: number;
}

/**
 * Reader-side state for items owned by rss-registry. Reads (rss_items JOIN
 * rss_reader_state) and writes (mark read/star). Storage is intentionally
 * separate from the registry so multiple readers / agents can keep their
 * own state without polluting the source-of-truth catalog.
 */
export class RssReaderService {
  constructor(private readonly db: SqliteDb) {}

  // Composed query — items LEFT JOIN reader_state, plus feed/category metadata.
  // LEFT JOIN means items without a state row default to read=0 (unread).
  private baseSelect(): string {
    return `
      SELECT i.id, i.feed_id, i.guid, i.title, i.link, i.author,
             i.description, i.content, i.image_url, i.published_at, i.fetched_at,
             f.name AS feed_name, f.slug AS feed_slug, f.feed_url,
             f.category_id, f.language,
             c.name AS category_name, c.icon AS category_icon,
             COALESCE(s.read, 0)    AS read,
             COALESCE(s.starred, 0) AS starred,
             s.read_at              AS read_at
      FROM rss_items i
      JOIN rss_registry f ON i.feed_id = f.id
      LEFT JOIN rss_categories c ON f.category_id = c.id
      LEFT JOIN rss_reader_state s ON s.item_id = i.id
    `;
  }

  /**
   * Returns the given category id plus every descendant. Used to make
   * "click on a parent folder" automatically include items in its child
   * folders — otherwise parent rows that only group children (no direct
   * feeds) would always show empty lists. Iterative to handle deeper trees
   * without stack-recursion concerns.
   */
  private resolveCategorySubtree(rootId: string): string[] {
    const out: string[] = [rootId];
    const stack = [rootId];
    const kidsStmt = this.db.prepare("SELECT id FROM rss_categories WHERE parent_id = ?");
    while (stack.length > 0) {
      const cur = stack.pop()!;
      const kids = kidsStmt.all(cur) as Array<{ id: string }>;
      for (const k of kids) { out.push(k.id); stack.push(k.id); }
    }
    return out;
  }

  listItems(query: ReaderListQuery = {}): ReaderItem[] {
    const wheres: string[] = ["1=1"];
    const vals: unknown[] = [];
    if (query.feed_id) { wheres.push("i.feed_id = ?"); vals.push(query.feed_id); }
    if (query.category_id) {
      // Auto-expand to subtree so parent folders include their children's items.
      const ids = this.resolveCategorySubtree(query.category_id);
      const placeholders = ids.map(() => "?").join(",");
      wheres.push(`f.category_id IN (${placeholders})`);
      vals.push(...ids);
    }
    if (query.unread_only) { wheres.push("COALESCE(s.read, 0) = 0"); }
    if (query.starred_only) { wheres.push("COALESCE(s.starred, 0) = 1"); }
    if (query.since) {
      wheres.push("(i.published_at >= ? OR i.fetched_at >= ?)");
      vals.push(query.since, query.since);
    }
    if (query.search) {
      wheres.push("(i.title LIKE ? OR i.description LIKE ?)");
      const t = `%${query.search}%`;
      vals.push(t, t);
    }
    const limit = query.limit ?? 200;
    const offset = query.offset ?? 0;
    vals.push(limit, offset);
    const sql = `
      ${this.baseSelect()}
      WHERE ${wheres.join(" AND ")}
      ORDER BY COALESCE(i.published_at, i.fetched_at) DESC
      LIMIT ? OFFSET ?
    `;
    return this.db.prepare(sql).all(...(vals as never[])) as ReaderItem[];
  }

  getItem(id: string): ReaderItem | null {
    const sql = `${this.baseSelect()} WHERE i.id = ?`;
    const row = this.db.prepare(sql).get(id) as ReaderItem | undefined;
    return row ?? null;
  }

  markRead(itemId: string, read = true): void {
    const now = isoNow();
    this.upsertState(itemId, { read: read ? 1 : 0, read_at: read ? now : null });
  }

  markAllRead(filter?: { feed_id?: string; category_id?: string }): number {
    const wheres: string[] = ["1=1"];
    const vals: unknown[] = [];
    if (filter?.feed_id) { wheres.push("i.feed_id = ?"); vals.push(filter.feed_id); }
    if (filter?.category_id) {
      const ids = this.resolveCategorySubtree(filter.category_id);
      const placeholders = ids.map(() => "?").join(",");
      wheres.push(`f.category_id IN (${placeholders})`);
      vals.push(...ids);
    }
    const ids = (this.db
      .prepare(`SELECT i.id FROM rss_items i JOIN rss_registry f ON i.feed_id = f.id WHERE ${wheres.join(" AND ")}`)
      .all(...(vals as never[])) as Array<{ id: string }>).map((r) => r.id);
    const now = isoNow();
    const upsert = this.db.prepare(
      `INSERT INTO rss_reader_state (item_id, read, starred, read_at, starred_at, updated_at)
         VALUES (?, 1, 0, ?, NULL, ?)
       ON CONFLICT(item_id) DO UPDATE SET read = 1, read_at = ?, updated_at = ?`,
    );
    for (const id of ids) upsert.run(id, now, now, now, now);
    return ids.length;
  }

  toggleStar(itemId: string): boolean {
    const cur = this.getState(itemId);
    const next = cur?.starred ? 0 : 1;
    const now = isoNow();
    this.upsertState(itemId, { starred: next, starred_at: next ? now : null });
    return next === 1;
  }

  getState(itemId: string): ReaderState | null {
    const row = this.db
      .prepare("SELECT * FROM rss_reader_state WHERE item_id = ?")
      .get(itemId) as ReaderState | undefined;
    return row ?? null;
  }

  /** Per-feed unread counts (used for sidebar badges). */
  unreadCountsByFeed(): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT i.feed_id AS feed_id, COUNT(*) AS count
         FROM rss_items i
         LEFT JOIN rss_reader_state s ON s.item_id = i.id
         WHERE COALESCE(s.read, 0) = 0
         GROUP BY i.feed_id`,
      )
      .all() as Array<{ feed_id: string; count: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.feed_id] = r.count;
    return out;
  }

  unreadCountsByCategory(): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT COALESCE(f.category_id, '') AS cat, COUNT(*) AS count
         FROM rss_items i
         JOIN rss_registry f ON i.feed_id = f.id
         LEFT JOIN rss_reader_state s ON s.item_id = i.id
         WHERE COALESCE(s.read, 0) = 0
         GROUP BY f.category_id`,
      )
      .all() as Array<{ cat: string; count: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.cat] = r.count;
    return out;
  }

  getStats(): ReaderStats {
    const total = this.db
      .prepare("SELECT COUNT(*) as count FROM rss_items")
      .get() as { count: number };
    const unread = this.db
      .prepare(
        `SELECT COUNT(*) as count
         FROM rss_items i
         LEFT JOIN rss_reader_state s ON s.item_id = i.id
         WHERE COALESCE(s.read, 0) = 0`,
      )
      .get() as { count: number };
    const starred = this.db
      .prepare(
        "SELECT COUNT(*) as count FROM rss_reader_state WHERE starred = 1",
      )
      .get() as { count: number };
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayIso = todayStart.toISOString();
    const unreadToday = this.db
      .prepare(
        `SELECT COUNT(*) as count
         FROM rss_items i
         LEFT JOIN rss_reader_state s ON s.item_id = i.id
         WHERE COALESCE(s.read, 0) = 0
           AND COALESCE(i.published_at, i.fetched_at) >= ?`,
      )
      .get(todayIso) as { count: number };

    return {
      total_items: total.count,
      unread: unread.count,
      starred: starred.count,
      unread_by_feed: this.unreadCountsByFeed(),
      unread_by_category: this.unreadCountsByCategory(),
      unread_today: unreadToday.count,
    };
  }

  private upsertState(
    itemId: string,
    patch: Partial<Pick<ReaderState, "read" | "starred" | "read_at" | "starred_at">>,
  ): void {
    const now = isoNow();
    const cur = this.getState(itemId);
    const read = patch.read ?? cur?.read ?? 0;
    const starred = patch.starred ?? cur?.starred ?? 0;
    const read_at = patch.read_at !== undefined ? patch.read_at : cur?.read_at ?? null;
    const starred_at = patch.starred_at !== undefined ? patch.starred_at : cur?.starred_at ?? null;
    this.db
      .prepare(
        `INSERT INTO rss_reader_state (item_id, read, starred, read_at, starred_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(item_id) DO UPDATE SET
           read = excluded.read,
           starred = excluded.starred,
           read_at = excluded.read_at,
           starred_at = excluded.starred_at,
           updated_at = excluded.updated_at`,
      )
      .run(itemId, read, starred, read_at, starred_at, now);
  }
}
