import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { GraphDriver } from "../../../../../src/core/db-drivers/graph-driver.js";
import type { Note } from "./types.js";
import { newId, isoNow } from "../../../../../src/core/helpers.js";

/**
 * Turn a user-supplied search string into a safe FTS5 MATCH expression.
 * Strips punctuation that FTS5 treats as syntax (-, *, +, ", etc.) and
 * wraps each surviving token as a quoted phrase so hashtags like "#foo"
 * or hyphenated words like "web-office-nl" work as simple term matches.
 */
function sanitizeFtsQuery(raw: string): string {
  if (!raw) return "";
  // Replace any char that isn't a letter, digit, or whitespace with a space.
  // (FTS5 uses space as the token delimiter; this collapses "#tag" into "tag",
  // "web-office-nl" into "web office nl", "user@host" into "user host", etc.)
  const cleaned = raw.replace(/[^\p{L}\p{N}\s]/gu, " ");
  const tokens = cleaned.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return "";
  // Quote each token so FTS5 treats it as a literal, then AND them with spaces.
  return tokens.map((t) => `"${t}"`).join(" ");
}

export class NotesService {
  constructor(
    private db: SqliteDb,
    private getGraph: () => GraphDriver | null,
  ) {}

  create(input: {
    title: string;
    body?: string;
    tags?: string;
    pinned?: boolean;
    contact_id?: string;
    task_id?: string;
  }): Note {
    const now = isoNow();
    const note: Note = {
      id: newId(),
      title: input.title,
      body: input.body ?? "",
      tags: input.tags ?? "",
      pinned: input.pinned ? 1 : 0,
      contact_id: input.contact_id ?? null,
      task_id: input.task_id ?? null,
      created_at: now,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO notes (id, title, body, tags, pinned, contact_id, task_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(note.id, note.title, note.body, note.tags, note.pinned, note.contact_id, note.task_id, note.created_at, note.updated_at);

    // FTS index
    this.db
      .prepare("INSERT INTO notes_fts (note_id, title, body, tags) VALUES (?, ?, ?, ?)")
      .run(note.id, note.title, note.body, note.tags);

    const graph = this.getGraph();
    if (graph?.capabilities.cypher) {
      graph
        .run(
          `MERGE (n:Note {id: $id})
           SET n.title = $title, n.tags = $tags`,
          { id: note.id, title: note.title, tags: note.tags },
        )
        .catch(() => {});

      if (note.contact_id) {
        graph
          .run(
            `MATCH (n:Note {id: $nid}), (p:Person {id: $pid})
             MERGE (n)-[:RELATES_TO]->(p)`,
            { nid: note.id, pid: note.contact_id },
          )
          .catch(() => {});
      }
      if (note.task_id) {
        graph
          .run(
            `MATCH (n:Note {id: $nid}), (t:Task {id: $tid})
             MERGE (n)-[:RELATES_TO]->(t)`,
            { nid: note.id, tid: note.task_id },
          )
          .catch(() => {});
      }
    }

    return note;
  }

  getById(id: string): Note | undefined {
    return this.db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as Note | undefined;
  }

  update(
    id: string,
    changes: Partial<Pick<Note, "title" | "body" | "tags" | "pinned" | "contact_id" | "task_id">>,
  ): Note | undefined {
    const existing = this.getById(id);
    if (!existing) return undefined;

    const updated = { ...existing, ...changes, updated_at: isoNow() };

    this.db
      .prepare(
        `UPDATE notes SET title=?, body=?, tags=?, pinned=?, contact_id=?, task_id=?, updated_at=?
         WHERE id=?`,
      )
      .run(updated.title, updated.body, updated.tags, updated.pinned, updated.contact_id, updated.task_id, updated.updated_at, id);

    // Update FTS
    this.db.prepare("DELETE FROM notes_fts WHERE note_id = ?").run(id);
    this.db
      .prepare("INSERT INTO notes_fts (note_id, title, body, tags) VALUES (?, ?, ?, ?)")
      .run(id, updated.title, updated.body, updated.tags);

    const graph = this.getGraph();
    if (graph?.capabilities.cypher) {
      graph
        .run(
          `MERGE (n:Note {id: $id}) SET n.title = $title, n.tags = $tags`,
          { id, title: updated.title, tags: updated.tags },
        )
        .catch(() => {});
    }

    return updated;
  }

  delete(id: string): boolean {
    const existing = this.getById(id);
    if (!existing) return false;

    this.db.prepare("DELETE FROM notes WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM notes_fts WHERE note_id = ?").run(id);

    const graph = this.getGraph();
    if (graph?.capabilities.cypher) {
      graph
        .run("MATCH (n:Note {id: $id}) DETACH DELETE n", { id })
        .catch(() => {});
    }

    return true;
  }

  search(query: string, limit: number = 20): Note[] {
    const safe = sanitizeFtsQuery(query);
    if (!safe) return [];
    const ftsResults = this.db
      .prepare(
        `SELECT note_id, rank FROM notes_fts WHERE notes_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(safe, limit) as { note_id: string; rank: number }[];

    if (ftsResults.length === 0) return [];

    const ids = ftsResults.map((r) => r.note_id);
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM notes WHERE id IN (${placeholders})`)
      .all(...ids) as Note[];

    // SQLite does not preserve the IN-clause order, so we explicitly restore
    // the FTS rank order that the agents rely on.
    const byId = new Map(rows.map((r) => [r.id, r] as const));
    const ordered: Note[] = [];
    for (const r of ftsResults) {
      const note = byId.get(r.note_id);
      if (note) ordered.push(note);
    }
    return ordered;
  }

  list(filters?: {
    tag?: string;
    contact_id?: string;
    task_id?: string;
    pinned?: boolean;
    limit?: number;
  }): Note[] {
    let sql = "SELECT * FROM notes WHERE 1=1";
    const params: unknown[] = [];

    if (filters?.tag) {
      // Tags are stored whitespace-separated in practice (e.g.
      // "#office #architecture #project-x"), although some seed notes use commas too.
      // Normalise both sides: commas become spaces in the stored value, the
      // leading '#' is stripped from the query, and the match runs as a whole
      // token so callers can pass either "office" or "#office".
      const needle = filters.tag.replace(/^#/, "");
      sql += " AND (' ' || REPLACE(REPLACE(tags, ',', ' '), '#', '') || ' ') LIKE ?";
      params.push(`% ${needle} %`);
    }
    if (filters?.contact_id) { sql += " AND contact_id = ?"; params.push(filters.contact_id); }
    if (filters?.task_id) { sql += " AND task_id = ?"; params.push(filters.task_id); }
    if (filters?.pinned !== undefined) { sql += " AND pinned = ?"; params.push(filters.pinned ? 1 : 0); }

    sql += " ORDER BY pinned DESC, updated_at DESC";
    if (filters?.limit) { sql += " LIMIT ?"; params.push(filters.limit); }

    return this.db.prepare(sql).all(...params) as Note[];
  }
}
