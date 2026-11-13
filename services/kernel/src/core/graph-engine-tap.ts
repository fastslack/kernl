/**
 * The engine tap: every statement the embedded graph (Relate) runs for the
 * kernel, as the engine timed it. The dashboard's engine room (A4) reads it to
 * show the engine at work — a pulse per statement, reads and writes on their
 * own lanes, the slowest statements, and the plan of any of them.
 *
 * In memory only: the last few hundred statements and an aggregate per
 * distinct statement. Parameters are kept only for reads (to PROFILE them
 * again on request) and only when small; nothing here is persisted.
 */

export interface EngineQuery {
  seq: number;
  at: number;
  key: string;
  label: string;
  write: boolean;
  ms: number | null;
  phases: { parse: number; plan: number; execute: number } | null;
  rows: number;
  failed: boolean;
}

export interface EngineStatement {
  key: string;
  cypher: string;
  label: string;
  write: boolean;
  count: number;
  totalMs: number;
  maxMs: number;
  lastAt: number;
  failures: number;
  /** The last parameters of a read, when small enough to keep; the engine room PROFILEs with them. */
  lastParams: Record<string, unknown> | null;
}

const RING = 400;
const MAX_STATEMENTS = 300;
const MAX_PARAM_BYTES = 4000;

/** Whitespace-collapsed text: one key per statement, whatever its indentation. */
export function statementKey(cypher: string): string {
  return cypher.replace(/\s+/g, " ").trim();
}

/** A short name for the statement: its clauses in order, the procedure it calls, the labels it reads. */
export function statementLabel(cypher: string): string {
  const flat = statementKey(cypher).replace(/'[^']*'|"[^"]*"/g, "…");
  const schema = flat.match(/^(CREATE|DROP)\s+(?:OR REPLACE\s+)?((?:FULLTEXT |VECTOR |RANGE |POINT |TEXT )?(?:INDEX|CONSTRAINT))\b/i);
  if (schema) {
    const on = flat.match(/\(\s*\w*\s*:\s*(\w+)/)?.[1] ?? flat.match(/\[\s*\w*\s*:\s*(\w+)/)?.[1];
    return `${schema[1].toUpperCase()} ${schema[2].toUpperCase()}${on ? ` :${on}` : ""}`;
  }
  const proc = flat.match(/\bCALL\s+([A-Za-z_][\w.]*)\s*\(/i)?.[1];
  const clauses = [...flat.matchAll(/\b(OPTIONAL MATCH|MATCH|MERGE|CREATE|SET|DELETE|DETACH DELETE|REMOVE|UNWIND|SEARCH|RETURN|SHOW \w+|EXPLAIN|PROFILE)\b/gi)]
    .map((m) => m[1].toUpperCase());
  const uniq = clauses.filter((c, i) => clauses.indexOf(c) === i).slice(0, 4);
  const label = flat.match(/\(\s*\w*\s*:\s*(\w+)/)?.[1];
  return [proc ? `CALL ${proc}` : "", uniq.join(" · "), label ? `:${label}` : ""].filter(Boolean).join(" ").slice(0, 90) || flat.slice(0, 60);
}

function keepParams(params: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!params) return {};
  try {
    const s = JSON.stringify(params);
    return s.length <= MAX_PARAM_BYTES ? (JSON.parse(s) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export class EngineTap {
  private seq = 0;
  private ring: EngineQuery[] = [];
  private statements = new Map<string, EngineStatement>();
  /** Statements the engine room itself runs (EXPLAIN passes, PROFILEs) are not recorded. */
  private quiet = 0;

  record(cypher: string, params: Record<string, unknown> | undefined, write: boolean,
    res: { ms: number | null; phases?: EngineQuery["phases"]; rows: number; failed?: boolean }): void {
    if (this.quiet > 0) return;
    const key = statementKey(cypher);
    let st = this.statements.get(key);
    if (!st) {
      if (this.statements.size >= MAX_STATEMENTS) {
        // Drop the statement seen longest ago.
        let oldest: EngineStatement | null = null;
        for (const s of this.statements.values()) if (!oldest || s.lastAt < oldest.lastAt) oldest = s;
        if (oldest) this.statements.delete(oldest.key);
      }
      st = { key, cypher: key.slice(0, 4000), label: statementLabel(cypher), write, count: 0, totalMs: 0, maxMs: 0, lastAt: 0, failures: 0, lastParams: null };
      this.statements.set(key, st);
    }
    const at = Date.now();
    st.count++;
    st.lastAt = at;
    if (res.failed) st.failures++;
    if (res.ms != null) { st.totalMs += res.ms; st.maxMs = Math.max(st.maxMs, res.ms); }
    if (!write) st.lastParams = keepParams(params);
    this.ring.push({ seq: ++this.seq, at, key, label: st.label, write, ms: res.ms, phases: res.phases ?? null, rows: res.rows, failed: !!res.failed });
    if (this.ring.length > RING) this.ring.splice(0, this.ring.length - RING);
  }

  /** Run `fn` without recording what it sends to the engine. */
  async unrecorded<T>(fn: () => Promise<T>): Promise<T> {
    this.quiet++;
    try { return await fn(); } finally { this.quiet--; }
  }

  since(seq: number, max = 80): EngineQuery[] {
    const out = this.ring.filter((q) => q.seq > seq);
    return out.slice(-max);
  }

  get lastSeq(): number { return this.seq; }

  statement(key: string): EngineStatement | undefined { return this.statements.get(key); }

  topStatements(n = 12): EngineStatement[] {
    return [...this.statements.values()].sort((a, b) => b.totalMs - a.totalMs).slice(0, n);
  }

  /** Reads seen often, with parameters kept: what an EXPLAIN pass checks for missing indexes. */
  explainable(n = 20): EngineStatement[] {
    return [...this.statements.values()]
      .filter((s) => !s.write && s.lastParams !== null && !/^\s*(EXPLAIN|PROFILE|SHOW)\b/i.test(s.cypher))
      .sort((a, b) => b.count - a.count)
      .slice(0, n);
  }

  /** Reads and writes in the last `windowMs`: how many, per second, and the engine time at p50 / p95. */
  stats(windowMs = 60_000): { reads: LaneStats; writes: LaneStats; windowMs: number } {
    const since = Date.now() - windowMs;
    const recent = this.ring.filter((q) => q.at >= since);
    const lane = (w: boolean): LaneStats => {
      const qs = recent.filter((q) => q.write === w);
      const ms = qs.map((q) => q.ms).filter((x): x is number => x != null).sort((a, b) => a - b);
      const pct = (p: number) => (ms.length ? ms[Math.min(ms.length - 1, Math.floor(p * ms.length))] : null);
      return { count: qs.length, perSec: qs.length / (windowMs / 1000), p50: pct(0.5), p95: pct(0.95), failed: qs.filter((q) => q.failed).length };
    };
    return { reads: lane(false), writes: lane(true), windowMs };
  }

  /** For tests. */
  reset(): void { this.seq = 0; this.ring = []; this.statements.clear(); this.quiet = 0; }
}

export interface LaneStats { count: number; perSec: number; p50: number | null; p95: number | null; failed: number }

export const engineTap = new EngineTap();
