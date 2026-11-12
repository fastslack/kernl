/**
 * Facts that know when they were true — and when Kernl knew them.
 *
 * A fact is (subject, predicate, object): ("Person:c1", "works_at", "Acme").
 * Each carries two timelines:
 *
 *   valid_from / valid_to       when it was true in the world
 *   recorded_at / superseded_at when Kernl believed it
 *   ended_at                    when Kernl learned it had ended (valid_to is
 *                               written later, in world time)
 *
 * so the memory stops piling up contradictions. Asserting a new value for a
 * single-valued predicate is read one of two ways:
 *
 *   change      the world changed: the old value stays in the history, true
 *               until the new one started (valid_to = the new valid_from).
 *   correction  the old value was wrong: Kernl stops believing it
 *               (superseded_at = now) and the new one takes its place from
 *               the same start.
 *
 * Nothing is deleted. `query()` answers "what is true now", "what was true on
 * date T" (asOf) and "what did Kernl believe on date K" (knownAt), or returns
 * the whole history.
 *
 * SQLite is the source of truth; each fact is projected into the graph as
 * (:Fact)-[:ABOUT]->(subject) when the subject is a node ("Label:id").
 */

import type { SqliteDb } from "../../core/db/sqlite.js";
import type { GraphDriver } from "../../core/db-drivers/graph-driver.js";
import { newId, isoNow } from "../../core/helpers.js";
import { log } from "../../core/logger.js";
import { ENTITY_LABELS } from "./ask.js";

export interface Fact {
  id: string;
  subject: string;
  subject_name: string;
  predicate: string;
  object: string;
  multi: number;
  confidence: number;
  source: string;
  source_ref: string;
  valid_from: string;
  valid_to: string | null;
  ended_by: string | null;
  ended_at: string | null;
  recorded_at: string;
  superseded_at: string | null;
  superseded_by: string | null;
}

export interface AssertInput {
  subject: string;
  subjectName?: string;
  predicate: string;
  object: string;
  /** Several values can hold at once (likes, speaks); default single-valued. */
  multi?: boolean;
  /** How a different current value is read; see the header. */
  mode?: "change" | "correction";
  validFrom?: string;
  confidence?: number;
  source?: string;
  sourceRef?: string;
}

export interface AssertOutcome {
  status: "recorded" | "unchanged";
  fact: Fact;
  /** Values this one ended (change) or replaced (correction). */
  ended: Fact[];
  superseded: Fact[];
}

const REF = /^([A-Z][A-Za-z]+):(.+)$/;
const GRAPH_LABELS = new Set<string>(ENTITY_LABELS);

/** "works at" → "works_at". */
export function normPredicate(p: string): string {
  return p.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "");
}

/** ISO instant; a bare date is midnight UTC. Throws on anything else. */
export function normTime(t: string): string {
  const s = /^\d{4}-\d{2}-\d{2}$/.test(t.trim()) ? `${t.trim()}T00:00:00.000Z` : t.trim();
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new Error(`not a date: ${t}`);
  return new Date(ms).toISOString();
}

/** Lowercase, without accents: "Lucía" → "lucia". */
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export class FactStore {
  constructor(
    private db: SqliteDb,
    private getGraph: () => GraphDriver | null = () => null,
    /** Transaction-time clock; the demo seed replays a past timeline with it. */
    private now: () => string = isoNow,
  ) {}

  get(id: string): Fact | null {
    return (this.db.prepare("SELECT * FROM facts WHERE id = ?").get(id) as Fact | undefined) ?? null;
  }

  /** Values Kernl currently believes are true now for (subject, predicate). */
  private current(subject: string, predicate: string): Fact[] {
    return this.db
      .prepare(
        `SELECT * FROM facts WHERE subject = ? AND predicate = ?
         AND valid_to IS NULL AND superseded_at IS NULL ORDER BY valid_from`,
      )
      .all(subject, predicate) as Fact[];
  }

  assert(input: AssertInput): AssertOutcome {
    const subject = input.subject.trim();
    const predicate = normPredicate(input.predicate);
    const object = input.object.trim();
    if (!subject || !predicate || !object) throw new Error("subject, predicate and object are required");
    const mode = input.mode ?? "change";
    const now = this.now();
    const validFrom = input.validFrom ? normTime(input.validFrom) : now;

    const outcome = this.db.transaction((): AssertOutcome => {
      const cur = this.current(subject, predicate);
      const already = cur.find((f) => same(f.object, object));
      if (already) {
        // Said again: hold it a little more firmly, change nothing else.
        const confidence = Math.max(already.confidence, input.confidence ?? 0);
        this.db.prepare("UPDATE facts SET confidence = ? WHERE id = ?").run(confidence, already.id);
        return { status: "unchanged", fact: { ...already, confidence }, ended: [], superseded: [] };
      }

      const others = input.multi ? [] : cur;
      const id = newId();
      // A correction replaces the old value over the same span.
      const start = mode === "correction" && others.length
        ? others.reduce((min, f) => (f.valid_from < min ? f.valid_from : min), validFrom)
        : validFrom;
      this.db
        .prepare(
          `INSERT INTO facts (id, subject, subject_name, predicate, object, multi, confidence, source, source_ref,
                              valid_from, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, subject, input.subjectName?.trim() ?? "", predicate, object, input.multi ? 1 : 0,
          input.confidence ?? 0.8, input.source ?? "", input.sourceRef ?? "", start, now);

      const ended: Fact[] = [];
      const superseded: Fact[] = [];
      for (const f of others) {
        if (mode === "correction") {
          this.db.prepare("UPDATE facts SET superseded_at = ?, superseded_by = ? WHERE id = ?").run(now, id, f.id);
          superseded.push({ ...f, superseded_at: now, superseded_by: id });
        } else {
          // It held until the new value began (never before it began itself).
          const end = start > f.valid_from ? start : f.valid_from;
          this.db.prepare("UPDATE facts SET valid_to = ?, ended_by = ?, ended_at = ? WHERE id = ?").run(end, id, now, f.id);
          ended.push({ ...f, valid_to: end, ended_by: id, ended_at: now });
        }
      }
      return { status: "recorded", fact: this.get(id)!, ended, superseded };
    })();

    if (outcome.status === "recorded") {
      void this.project([outcome.fact, ...outcome.ended, ...outcome.superseded]);
    }
    return outcome;
  }

  /**
   * Stop holding a fact: `ended` — it was true until `at` (default now);
   * `wrong` — it never was, Kernl stops believing it.
   */
  retract(id: string, how: "ended" | "wrong" = "ended", at?: string): Fact | null {
    const f = this.get(id);
    if (!f) return null;
    const now = this.now();
    if (how === "wrong") {
      if (f.superseded_at) return f;
      this.db.prepare("UPDATE facts SET superseded_at = ? WHERE id = ?").run(now, id);
    } else {
      if (f.valid_to) return f;
      const end = at ? normTime(at) : now;
      this.db.prepare("UPDATE facts SET valid_to = ?, ended_at = ? WHERE id = ?").run(end > f.valid_from ? end : f.valid_from, now, id);
    }
    const out = this.get(id)!;
    void this.project([out]);
    return out;
  }

  /**
   * Facts as of a moment. `asOf` is world time (default now), `knownAt` is
   * what Kernl believed then (default now). `history` returns every row for
   * the filter, believed or not, oldest first.
   */
  query(q: {
    subject?: string;
    predicate?: string;
    text?: string;
    asOf?: string;
    knownAt?: string;
    history?: boolean;
    limit?: number;
  } = {}): Fact[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.subject) { where.push("subject = ?"); params.push(q.subject.trim()); }
    if (q.predicate) { where.push("predicate = ?"); params.push(normPredicate(q.predicate)); }
    if (q.text) {
      where.push("(subject_name LIKE ? OR object LIKE ? OR predicate LIKE ?)");
      const like = `%${q.text.trim()}%`;
      params.push(like, like, like);
    }
    if (!q.history) {
      const k = q.knownAt ? normTime(q.knownAt) : null;
      if (k) {
        where.push("recorded_at <= ? AND (superseded_at IS NULL OR superseded_at > ?)");
        params.push(k, k);
      } else {
        where.push("superseded_at IS NULL");
      }
      // An end Kernl learned after `knownAt` was not known then: as Kernl
      // believed it, the fact was still open.
      const open = k ? "(valid_to IS NULL OR ended_at > ?)" : "valid_to IS NULL";
      const t = q.asOf ? normTime(q.asOf) : null;
      if (t) {
        where.push(`valid_from <= ? AND (${open} OR valid_to > ?)`);
        params.push(t, ...(k ? [k] : []), t);
      } else {
        where.push(open);
        if (k) params.push(k);
      }
    }
    const sql = `SELECT * FROM facts ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
                 ORDER BY ${q.history ? "subject, predicate, valid_from, recorded_at" : "recorded_at DESC"}
                 LIMIT ${Math.max(1, Math.min(q.limit ?? 100, 1000))}`;
    return this.db.prepare(sql).all(...params) as Fact[];
  }

  /** Subjects whose name or ref matches `text`, with the name they are known by. */
  findSubjects(text: string, limit = 20): Array<{ subject: string; subject_name: string }> {
    const like = `%${text.trim()}%`;
    const found = this.db
      .prepare(
        `SELECT subject, COALESCE(MAX(NULLIF(subject_name, '')), '') AS subject_name FROM facts
          WHERE subject_name LIKE ? OR subject LIKE ? GROUP BY subject ORDER BY subject LIMIT ?`,
      )
      .all(like, like, limit) as Array<{ subject: string; subject_name: string }>;
    if (found.length) return found;
    // SQLite's LIKE folds ASCII case only: "lucia" misses "Lucía". Compare
    // without accents or case over the named subjects instead.
    const want = fold(text);
    if (!want) return [];
    return (this.db
      .prepare(
        `SELECT subject, MAX(subject_name) AS subject_name FROM facts
          WHERE subject_name <> '' GROUP BY subject ORDER BY subject LIMIT 5000`,
      )
      .all() as Array<{ subject: string; subject_name: string }>)
      .filter((r) => fold(r.subject_name).includes(want))
      .slice(0, limit);
  }

  /** The name a subject was given in any of its facts. */
  subjectName(subject: string): string {
    const r = this.db
      .prepare("SELECT COALESCE(MAX(NULLIF(subject_name, '')), '') AS n FROM facts WHERE subject = ?")
      .get(subject) as { n: string } | undefined;
    return r?.n ?? "";
  }

  /** Write facts to the graph, linked to their subject node when it is one. */
  async project(facts: Fact[], graph = this.getGraph()): Promise<number> {
    if (!graph?.capabilities.cypher || facts.length === 0) return 0;
    try {
      const rows = facts.map((f) => {
        const m = REF.exec(f.subject);
        const label = m && GRAPH_LABELS.has(m[1]) ? m[1] : null;
        return {
          id: f.id,
          props: {
            subject: f.subject,
            predicate: f.predicate,
            object: f.object,
            title: `${f.subject_name || f.subject} · ${f.predicate.replace(/_/g, " ")} · ${f.object}`,
            valid_from: f.valid_from,
            valid_to: f.valid_to,
            ended_at: f.ended_at,
            recorded_at: f.recorded_at,
            superseded_at: f.superseded_at,
            current: !f.valid_to && !f.superseded_at,
            confidence: f.confidence,
          },
          label,
          ref: m ? m[2] : null,
        };
      });
      // The nodes, their subjects and what replaced what land together.
      const write = async (tx: Pick<GraphDriver, "run">) => {
        await tx.run("UNWIND $rows AS r MERGE (f:Fact {id: r.id}) SET f += r.props", { rows });
        // Facts written while the graph was off point at nothing yet; link by label.
        const byLabel = new Map<string, Array<{ id: string; ref: string }>>();
        for (const r of rows) {
          if (r.label && r.ref) byLabel.set(r.label, [...(byLabel.get(r.label) ?? []), { id: r.id, ref: r.ref }]);
        }
        for (const [label, list] of byLabel) {
          await tx.run(
            `UNWIND $rows AS r MATCH (f:Fact {id: r.id}) MATCH (s:${label} {id: r.ref}) MERGE (f)-[:ABOUT]->(s)`,
            { rows: list },
          );
        }
        for (const f of facts) {
          const next = f.superseded_by ?? f.ended_by;
          if (next) {
            await tx.run(
              "MATCH (a:Fact {id: $a}), (b:Fact {id: $b}) MERGE (b)-[:REPLACES {how: $how}]->(a)",
              { a: f.id, b: next, how: f.superseded_by ? "correction" : "change" },
            );
          }
        }
      };
      if (graph.withTransaction) await graph.withTransaction(write);
      else await write(graph);
      return rows.length;
    } catch (err) {
      log.debug(`facts: graph projection failed — ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  /** Every fact, for the graph backfill. */
  async backfill(graph: GraphDriver): Promise<{ nodes: number; relationships: number }> {
    const all = this.db.prepare("SELECT * FROM facts").all() as Fact[];
    // Twice: a fact's replacement may sit in a later batch, so the second
    // pass draws the REPLACES links the first could not.
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < all.length; i += 500) await this.project(all.slice(i, i + 500), graph);
    }
    return { nodes: all.length, relationships: all.filter((f) => REF.test(f.subject) || f.ended_by || f.superseded_by).length };
  }
}
