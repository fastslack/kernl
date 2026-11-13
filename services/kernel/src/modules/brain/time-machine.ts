/**
 * The time machine: one subject (a person, usually) seen at any moment.
 *
 *   asOf(subject, T)  One Cypher query on the graph. Every fact about the
 *                     subject, classified by the two timelines at T:
 *                       known    true at T, and Kernl believed it at T
 *                       stale    Kernl believed it at T, but it was no longer
 *                                true (or never was: corrected later)
 *                       unknown  true at T, and Kernl had not learned it yet
 *                     with the agent that wrote each one, from the graph's own
 *                     provenance: (:Agent)-[:RAN]->(:AgentRun)-[:TOUCHED]->(:Fact).
 *
 *   story(subject)    What happened to the subject, in order: when facts became
 *                     true in the world, when Kernl learned them, and every
 *                     agent run that touched the subject — with its tool calls,
 *                     the hand-offs between agents and the lessons kept — as
 *                     the same events the live 3D office animates, so the
 *                     dashboard can replay them.
 */
import type { GraphDriver } from "../../core/db-drivers/graph-driver.js";
import type { SqliteDb } from "../../core/db/sqlite.js";

export type FactState = "known" | "stale" | "unknown";

export interface AsOfFact {
  id: string;
  predicate: string;
  object: string;
  valid_from: string | null;
  valid_to: string | null;
  recorded_at: string | null;
  ended_at: string | null;
  superseded_at: string | null;
  state: FactState;
  written_by: { name: string; agent_id: string; at: string | null; tool: string } | null;
  /** The fact this one replaced, and how: a change in the world or a correction of a mistake. */
  replaces: { id: string; how: string } | null;
}

/** What the engine did for one statement: Relate's PROFILE, summed up. */
export interface EngineProfile {
  ms: number;
  phases: { parse: number; plan: number; execute: number } | null;
  rows: number;
  db_hits: number;
  node_reads: number;
  neighbor_walks: number;
  hops: number;
  memory_bytes: number;
  operators: Array<{ operator: string; details: string; rows: number; ms: number; start: string | null }>;
}

/** Sum a Relate PROFILE plan (relate.plan/v1) into the figures worth showing. */
export function summarizeProfile(plan: unknown, ms: number, phases: EngineProfile["phases"]): EngineProfile | null {
  const root = (plan as { root?: unknown } | null)?.root as PlanNode | undefined;
  if (!root) return null;
  const out: EngineProfile = { ms, phases, rows: Number(root.actual?.rows ?? 0), db_hits: 0, node_reads: 0, neighbor_walks: 0, hops: 0, memory_bytes: 0, operators: [] };
  const walk = (n: PlanNode) => {
    const a = n.actual ?? {};
    out.db_hits += Number(a.db_hits ?? 0);
    out.node_reads += Number(a.node_reads ?? 0);
    out.neighbor_walks += Number(a.neighbor_walks ?? 0);
    out.hops += Number(a.hops ?? 0);
    out.memory_bytes = Math.max(out.memory_bytes, Number(a.memory_bytes ?? 0));
    out.operators.push({
      operator: String(n.operator ?? "?"),
      details: String(n.details ?? "").slice(0, 160),
      rows: Number(a.rows ?? 0),
      ms: Math.round(Number(a.time_ms ?? 0) * 1000) / 1000,
      start: a.start?.reason ? String(a.start.reason) : null,
    });
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return out;
}
type PlanNode = {
  operator?: string; details?: string; children?: PlanNode[];
  actual?: { rows?: number; db_hits?: number; node_reads?: number; neighbor_walks?: number; hops?: number; memory_bytes?: number; time_ms?: number; start?: { reason?: string } | null };
};

export interface AsOfSnapshot {
  at: string;
  subject: { id: string; ref: string; name: string; label: string };
  facts: AsOfFact[];
  /** Facts Kernl held at T that were not true then, plus truths it had not learned. */
  gaps: number;
  query_ms: number;
  cypher: string;
  /** Relate's PROFILE of the same statement, when asked for. */
  profile?: EngineProfile | null;
}

export interface StoryTick {
  at: string;
  kind: "world" | "learned" | "ended" | "run" | "action";
  label: string;
  /** For an action sent out of Kernl: what it rested on, judged now (kernel_facts_explain). */
  verdict?: "consistent" | "late_information" | "wrong_belief";
  why?: string;
  agent_id?: string;
  agent_name?: string;
  run_id?: string;
}

export interface ReplayEvent {
  at: string;
  event: string;
  data: Record<string, unknown>;
}

export interface Story {
  subject: { id: string; ref: string; name: string; label: string };
  from: string;
  to: string;
  ticks: StoryTick[];
  replay: ReplayEvent[];
  /** Offices whose agents appear in the story, most involved first. */
  offices: Array<{ id: string; name: string; runs: number }>;
}

/**
 * Everything about one subject at moment $t, in one traversal. The subject is
 * matched by id; its facts by ABOUT; their writer by the provenance edges the
 * kernel projects for every tool call, and the agent behind each run when the
 * run has been synced.
 */
export const asOfCypher = (label: string) => `
MATCH (s:${label} {id: $id})<-[:ABOUT]-(f:Fact)
WITH s, f, datetime($t) AS t
WITH s, f, t,
  f.superseded_at IS NULL
    AND (f.valid_from IS NULL OR f.valid_from <= t)
    AND (f.valid_to IS NULL OR f.valid_to > t) AS trueThen,
  f.recorded_at <= t
    AND (f.superseded_at IS NULL OR f.superseded_at > t)
    AND (f.valid_from IS NULL OR f.valid_from <= t)
    AND (f.ended_at IS NULL OR f.ended_at > t OR f.valid_to IS NULL OR f.valid_to > t) AS believedThen
WHERE trueThen OR believedThen
OPTIONAL MATCH (run:AgentRun)-[w:TOUCHED {tool: 'kernel_facts_assert'}]->(f)
OPTIONAL MATCH (a:Agent)-[:RAN]->(run)
OPTIONAL MATCH (f)-[rep:REPLACES]->(old:Fact)
WITH s, f, trueThen, believedThen, rep, old, w, a ORDER BY w.at
WITH s, f, trueThen, believedThen, rep, old,
  collect({name: coalesce(a.name, w.actor, ''), agent_id: coalesce(a.id, w.actor_id, ''), at: w.at, tool: w.tool})[0] AS writer
RETURN s.id AS sid, coalesce(s.name, s.title, '') AS sname, labels(s)[0] AS slabel,
  f.id AS id, f.predicate AS predicate, f.object AS object,
  f.valid_from AS valid_from, f.valid_to AS valid_to, f.recorded_at AS recorded_at,
  f.ended_at AS ended_at, f.superseded_at AS superseded_at,
  trueThen, believedThen, writer, old.id AS replaces_id, rep.how AS replaces_how
ORDER BY predicate, valid_from`;

type ProvRow = { at: string; actor_kind: string; actor_id: string; actor_name: string; run_id: string; tool: string; detail: string };

export interface AgentLesson { id: string; type: string; content: string; created_at: string | null }
export interface AgentTouched {
  id: string; ref: string; name: string; label: string;
  /** stale: it held beliefs about them that were no longer true at T; unknown: truths it had not learned. */
  state: FactState; stale: number; unknown: number; stale_facts: string[];
  tools: string[]; first: string;
}
export interface AgentSnapshot {
  at: string;
  agent: { id: string; name: string; flow_id: string | null };
  touched: AgentTouched[];
  lessons: AgentLesson[];
  gaps: number;
  query_ms: number;
  cypher: string;
}

/**
 * One subject between two moments, in one traversal: each fact's state at $t1
 * and at $t2 (known, stale, not yet known, or absent), kept when it differs.
 */
export const diffCypher = (label: string) => `
MATCH (s:${label} {id: $id})<-[:ABOUT]-(f:Fact)
WITH f, [x IN [datetime($t1), datetime($t2)] |
  CASE
    WHEN f.superseded_at IS NULL AND (f.valid_from IS NULL OR f.valid_from <= x) AND (f.valid_to IS NULL OR f.valid_to > x)
         AND f.recorded_at <= x AND (f.ended_at IS NULL OR f.ended_at > x OR f.valid_to IS NULL OR f.valid_to > x) THEN 'known'
    WHEN f.recorded_at <= x AND (f.superseded_at IS NULL OR f.superseded_at > x) AND (f.valid_from IS NULL OR f.valid_from <= x)
         AND (f.ended_at IS NULL OR f.ended_at > x OR f.valid_to IS NULL OR f.valid_to > x) THEN 'stale'
    WHEN f.superseded_at IS NULL AND (f.valid_from IS NULL OR f.valid_from <= x) AND (f.valid_to IS NULL OR f.valid_to > x) THEN 'unknown'
    ELSE 'absent' END] AS st
WHERE st[0] <> st[1]
RETURN f.id AS id, f.predicate AS predicate, f.object AS object, st[0] AS before, st[1] AS after
ORDER BY predicate, object`;

/** An agent at $t: the lessons it had learned, and what its runs had touched. */
export const AGENT_AS_OF_CYPHER = `
MATCH (a:Agent {id: $id})
OPTIONAL MATCH (a)-[:LEARNED]->(l:AgentLearning)
WHERE l.created_at IS NULL OR l.created_at <= datetime($t)
WITH a, collect(DISTINCT {id: l.id, type: l.type, content: l.content, created_at: l.created_at}) AS lessons
OPTIONAL MATCH (a)-[:RAN]->(:AgentRun)-[w:TOUCHED]->(n)
WHERE w.at <= $t
OPTIONAL MATCH (n)-[:ABOUT]->(s)
RETURN a.name AS name, lessons,
  collect(DISTINCT {id: n.id, label: labels(n)[0], tool: w.tool, at: w.at,
    about: CASE WHEN s IS NULL THEN null ELSE labels(s)[0] + ':' + s.id END}) AS touched`;

function finish(subject: Story["subject"], ticks: StoryTick[], replay: ReplayEvent[], offices: Story["offices"]): Story {
  ticks.sort((a, b) => a.at.localeCompare(b.at));
  replay.sort((a, b) => a.at.localeCompare(b.at));
  const all = [...ticks.map((t) => t.at), ...replay.map((r) => r.at)].sort();
  const now = new Date().toISOString();
  return { subject, from: all[0] ?? now, to: all.at(-1) ?? now, ticks: dedupe(ticks), replay, offices };
}

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** "Person:abc" or "abc" → { label, id }. */
function parseRef(subject: string): { label: string; id: string } {
  const m = /^([A-Z][A-Za-z]*):(.+)$/.exec(subject.trim());
  return m ? { label: m[1], id: m[2] } : { label: "Person", id: subject.trim() };
}

export class TimeMachine {
  constructor(
    private db: SqliteDb,
    private getGraph: () => GraphDriver | null,
    /** Brings a graph written before fact times were datetimes up to the schema. */
    private ensureSchema: (g: GraphDriver) => Promise<void> = async () => {},
    /** What an action at `at` rested on (explain.ts), for actions that left Kernl. */
    private explain: (subjectRef: string, at: string) => { verdict: StoryTick["verdict"]; why: string } | null = () => null,
  ) {}

  /** A subject by ref ("Person:<id>"), bare contact id, or a contact's name. */
  resolve(who: string): { id: string; ref: string; name: string; label: string } | null {
    const w = who.trim();
    if (!w) return null;
    const { label, id } = parseRef(w);
    const byFacts = this.db
      .prepare("SELECT subject, MAX(subject_name) AS name FROM facts WHERE subject = ? OR subject_name = ? GROUP BY subject ORDER BY COUNT(*) DESC LIMIT 1")
      .get(`${label}:${id}`, w) as { subject: string; name: string } | undefined;
    if (byFacts) {
      const p = parseRef(byFacts.subject);
      return { id: p.id, ref: byFacts.subject, name: byFacts.name ?? "", label: p.label };
    }
    try {
      const c = this.db
        .prepare("SELECT id, name FROM contacts WHERE (id = ? OR name = ?) AND deleted_at IS NULL LIMIT 1")
        .get(id, w) as { id: string; name: string } | undefined;
      if (c) return { id: c.id, ref: `Person:${c.id}`, name: c.name, label: "Person" };
    } catch { /* no CRM */ }
    return null;
  }

  async asOf(who: string, at: string, opts: { profile?: boolean } = {}): Promise<AsOfSnapshot> {
    const subject = this.resolve(who);
    if (!subject) throw new Error(`No subject "${who}"`);
    const t = new Date(at);
    if (Number.isNaN(t.getTime())) throw new Error(`Not a moment: "${at}"`);
    const g = this.getGraph();
    if (!g?.capabilities.cypher) throw new Error("The graph is off.");
    const started = performance.now();
    if (!/^[A-Z][A-Za-z]*$/.test(subject.label)) throw new Error(`Not a label: ${subject.label}`);
    await this.ensureSchema(g);
    const cypher = asOfCypher(subject.label);
    const r = await g.run(cypher, { id: subject.id, t: t.toISOString() });
    // The engine's own time when the driver reports it (Relate does).
    const query_ms = Math.round((r.summary?.resultAvailableAfterMs ?? performance.now() - started) * 100) / 100;
    const facts: AsOfFact[] = r.records.map((x) => {
      const trueThen = x.get("trueThen") === true;
      const believedThen = x.get("believedThen") === true;
      const w = x.get("writer") as { name?: unknown; agent_id?: unknown; at?: unknown; tool?: unknown } | null;
      const replacesId = str(x.get("replaces_id"));
      return {
        id: String(x.get("id")),
        predicate: String(x.get("predicate") ?? ""),
        object: String(x.get("object") ?? ""),
        valid_from: str(x.get("valid_from")),
        valid_to: str(x.get("valid_to")),
        recorded_at: str(x.get("recorded_at")),
        ended_at: str(x.get("ended_at")),
        superseded_at: str(x.get("superseded_at")),
        state: trueThen && believedThen ? "known" : believedThen ? "stale" : "unknown",
        written_by: w && (w.name || w.agent_id)
          ? { name: String(w.name ?? ""), agent_id: String(w.agent_id ?? ""), at: str(w.at), tool: String(w.tool ?? "") }
          : null,
        replaces: replacesId ? { id: replacesId, how: String(x.get("replaces_how") ?? "") } : null,
      };
    });
    // Runs whose agent the graph has not linked yet (the experience graph
    // syncs runs as they finish): the provenance table has the same call.
    const missing = facts.filter((f) => !f.written_by?.name).map((f) => f.id);
    if (missing.length) {
      const rows = this.db
        .prepare(
          `SELECT p.ref, p.at, p.tool, p.actor_id, COALESCE(NULLIF(p.actor_name, ''), a.name, p.actor_kind) AS name
             FROM tool_provenance p LEFT JOIN agents a ON a.id = p.actor_id
            WHERE p.ok = 1 AND p.tool = 'kernel_facts_assert' AND p.ref IN (${missing.map(() => "?").join(",")})
            ORDER BY p.at`,
        )
        .all(...missing) as Array<{ ref: string; at: string; tool: string; actor_id: string; name: string }>;
      for (const f of facts) {
        const w = rows.find((x) => x.ref === f.id);
        if (w && !f.written_by?.name) f.written_by = { name: w.name, agent_id: w.actor_id, at: w.at, tool: w.tool };
      }
    }
    const first = r.records[0];
    if (first) subject.name = String(first.get("sname") || subject.name);
    // The timed run above is plain; the profile is a second run, so its
    // instrumentation never inflates the time shown.
    let profile: EngineProfile | null | undefined;
    if (opts.profile) {
      try {
        const p = await g.run(`PROFILE ${cypher}`, { id: subject.id, t: t.toISOString() });
        profile = summarizeProfile(p.summary?.plan, p.summary?.resultAvailableAfterMs ?? 0, p.summary?.phasesMs ?? null);
      } catch { profile = null; }
    }
    return {
      ...(opts.profile ? { profile } : {}),
      at: t.toISOString(),
      subject,
      facts,
      gaps: facts.filter((f) => f.state !== "known").length,
      query_ms,
      cypher: cypher.trim(),
    };
  }

  story(who: string): Story {
    const subject = this.resolve(who);
    if (!subject) throw new Error(`No subject "${who}"`);
    const ticks: StoryTick[] = [];
    const replay: ReplayEvent[] = [];
    const facts = this.db
      .prepare("SELECT id, predicate, object, valid_from, valid_to, recorded_at, ended_at, superseded_at, source FROM facts WHERE subject = ?")
      .all(subject.ref) as Array<{ id: string; predicate: string; object: string; valid_from: string | null; valid_to: string | null; recorded_at: string; ended_at: string | null; superseded_at: string | null; source: string }>;
    const what = (f: { predicate: string; object: string }) => `${f.predicate.replace(/_/g, " ")} ${f.object}`;
    for (const f of facts) {
      // A change in the world Kernl heard of later is worth its own tick —
      // a change, so only where an older value of the same thing was held.
      const changed = facts.some((o) => o !== f && o.predicate === f.predicate && o.recorded_at < f.recorded_at);
      if (changed && f.valid_from && f.valid_from < f.recorded_at && dayOf(f.valid_from) !== dayOf(f.recorded_at)) {
        ticks.push({ at: f.valid_from, kind: "world", label: `In the world: ${what(f)}` });
      }
      ticks.push({ at: f.recorded_at, kind: "learned", label: `Kernl learns: ${what(f)}` });
    }

    // Every id that stands for the subject: itself, records merged into it, its facts.
    const ids = new Set<string>([subject.id, ...facts.map((f) => f.id)]);
    try {
      for (const m of this.db.prepare("SELECT merged_id FROM contact_merges WHERE kept_id = ?").all(subject.id) as Array<{ merged_id: string }>) ids.add(m.merged_id);
      for (const c of this.db.prepare("SELECT id FROM communications WHERE contact_id IN (" + [...ids].map(() => "?").join(",") + ")").all(...ids) as Array<{ id: string }>) ids.add(c.id);
    } catch { /* tables of modules that are off */ }
    const list = [...ids];
    // Actions addressed to the subject (a mail to one of their addresses) name
    // the address, not the record.
    let addresses: string[] = [];
    try {
      addresses = (this.db
        .prepare(`SELECT DISTINCT value_norm FROM contact_identities WHERE kind = 'email' AND contact_id IN (${list.map(() => "?").join(",")})`)
        .all(...list) as Array<{ value_norm: string }>).map((r) => r.value_norm).filter((v) => v.includes("@"));
    } catch { /* no identities table */ }
    const prov = this.db
      .prepare(
        `SELECT at, actor_kind, actor_id, actor_name, run_id, tool, detail FROM tool_provenance
          WHERE ok = 1 AND (ref IN (${list.map(() => "?").join(",")})${addresses.map(() => " OR detail LIKE ?").join("")})
          ORDER BY at, rowid`,
      )
      .all(...list, ...addresses.map((a) => `%${a}%`)) as ProvRow[];
    const offices = this.stitch(prov, [], ticks, replay, () => subject.ref);
    return finish(subject, ticks, replay, offices);
  }

  // ── Agents ──────────────────────────────────────────────────────────

  resolveAgent(who: string): { id: string; name: string; flow_id: string | null } | null {
    const w = who.trim();
    if (!w) return null;
    try {
      return (this.db
        .prepare("SELECT id, name, flow_id FROM agents WHERE id = ? OR name = ? OR slug = ? LIMIT 1")
        .get(w, w, w) as { id: string; name: string; flow_id: string | null } | undefined) ?? null;
    } catch {
      return (this.db.prepare("SELECT id, name, flow_id FROM agents WHERE id = ? OR name = ? LIMIT 1").get(w, w) as { id: string; name: string; flow_id: string | null } | undefined) ?? null;
    }
  }

  /** One agent's story: its runs, what they touched, what it sent out, and the lessons it kept. */
  agentStory(who: string): Story {
    const agent = this.resolveAgent(who);
    if (!agent) throw new Error(`No agent "${who}"`);
    const ticks: StoryTick[] = [];
    const replay: ReplayEvent[] = [];
    const prov = this.db
      .prepare(
        `SELECT at, actor_kind, actor_id, actor_name, run_id, tool, detail FROM tool_provenance
          WHERE ok = 1 AND actor_id = ? ORDER BY at, rowid`,
      )
      .all(agent.id) as ProvRow[];
    const runs = (this.db.prepare("SELECT id FROM agent_runs WHERE agent_id = ? ORDER BY created_at DESC LIMIT 200").all(agent.id) as Array<{ id: string }>)
      .map((r) => r.id);
    const offices = this.stitch(prov, runs, ticks, replay, (p) => this.personFor(p.detail));
    // Its office first, even when another office's runs touched the same things.
    if (agent.flow_id) {
      const i = offices.findIndex((o) => o.id === agent.flow_id);
      if (i > 0) offices.unshift(...offices.splice(i, 1));
      if (i < 0) offices.unshift({ id: agent.flow_id, name: this.officeName(agent.flow_id), runs: 0 });
    }
    return finish({ id: agent.id, ref: `Agent:${agent.id}`, name: agent.name, label: "Agent" }, ticks, replay, offices);
  }

  /**
   * One agent at moment T: what it had touched by then and the lessons it held.
   * The agent's side is one traversal —
   *   (:Agent)-[:LEARNED]->(:AgentLearning)            lessons learned by T
   *   (:Agent)-[:RAN]->(:AgentRun)-[:TOUCHED]->(n)     what its runs touched by T
   * — and each person among them is then seen as of T (asOf), so a person the
   * agent acted on with a stale belief shows red.
   */
  async agentAsOf(who: string, at: string): Promise<AgentSnapshot> {
    const agent = this.resolveAgent(who);
    if (!agent) throw new Error(`No agent "${who}"`);
    const t = new Date(at);
    if (Number.isNaN(t.getTime())) throw new Error(`Not a moment: "${at}"`);
    const g = this.getGraph();
    if (!g?.capabilities.cypher) throw new Error("The graph is off.");
    await this.ensureSchema(g);
    const T = t.toISOString();
    const started = performance.now();
    const r = await g.run(AGENT_AS_OF_CYPHER, { id: agent.id, t: T });
    let query_ms = r.summary?.resultAvailableAfterMs ?? performance.now() - started;
    const row = r.records[0];
    const lessonsRaw = ((row?.get("lessons") as Array<Record<string, unknown>> | undefined) ?? []).filter((l) => l && l.id);
    const touchedRaw = ((row?.get("touched") as Array<Record<string, unknown>> | undefined) ?? []).filter((n) => n && n.id);

    // Lessons the graph has no date for yet (synced before it kept one): SQLite has it.
    const lessons: AgentLesson[] = [];
    for (const l of lessonsRaw) {
      let created = str(l.created_at);
      if (!created) {
        const x = this.db.prepare("SELECT created_at FROM agent_learnings WHERE id = ?").get(String(l.id)) as { created_at: string } | undefined;
        created = x?.created_at ?? null;
      }
      if (created && created > T) continue;
      lessons.push({ id: String(l.id), type: String(l.type ?? "insight"), content: String(l.content ?? ""), created_at: created });
    }

    // People it acted on by T: through the graph, and through provenance for
    // actions that name them by address (a mail) rather than by record.
    const people = new Map<string, { tools: Set<string>; first: string }>();
    const add = (ref: string, tool: string, when: string) => {
      const p = people.get(ref) ?? { tools: new Set<string>(), first: when };
      p.tools.add(tool);
      if (when < p.first) p.first = when;
      people.set(ref, p);
    };
    for (const n of touchedRaw) {
      const ref = n.label === "Person" ? `Person:${n.id}` : str(n.about);
      if (ref) add(ref, String(n.tool ?? ""), String(n.at ?? ""));
    }
    const prov = this.db
      .prepare("SELECT at, tool, ref, detail FROM tool_provenance WHERE ok = 1 AND actor_id = ? AND at <= ? ORDER BY at")
      .all(agent.id, T) as Array<{ at: string; tool: string; ref: string; detail: string }>;
    for (const p of prov) {
      const ref = this.personFor(p.detail) ?? this.personForRef(p.ref);
      if (ref) add(ref, p.tool, p.at);
    }

    const touched: AgentTouched[] = [];
    for (const [ref, info] of [...people.entries()].slice(0, 8)) {
      try {
        const snap = await this.asOf(ref, T);
        query_ms += snap.query_ms;
        const stale = snap.facts.filter((f) => f.state === "stale").length;
        const unknown = snap.facts.filter((f) => f.state === "unknown").length;
        touched.push({
          id: snap.subject.id, ref, name: snap.subject.name || ref, label: snap.subject.label,
          state: stale ? "stale" : unknown ? "unknown" : "known", stale, unknown,
          stale_facts: snap.facts.filter((f) => f.state === "stale").map((f) => `${f.predicate.replace(/_/g, " ")}: ${f.object}`),
          tools: [...info.tools].map((x) => x.replace(/^kernel_/, "").replace(/_/g, " ")),
          first: info.first,
        });
      } catch { /* a subject with no facts: nothing to judge */ }
    }
    return {
      at: T,
      agent: { id: agent.id, name: String(row?.get("name") ?? agent.name), flow_id: agent.flow_id },
      touched,
      lessons,
      gaps: touched.filter((x) => x.state !== "known").length,
      query_ms: Math.round(query_ms * 100) / 100,
      cypher: AGENT_AS_OF_CYPHER.trim(),
    };
  }

  /** What changed for a subject between two moments: every fact whose state differs. */
  async diff(who: string, from: string, to: string): Promise<{
    subject: { id: string; ref: string; name: string; label: string };
    from: string; to: string; query_ms: number; cypher: string;
    changes: Array<{ id: string; predicate: string; object: string; before: FactState | "absent"; after: FactState | "absent" }>;
  }> {
    const subject = this.resolve(who);
    if (!subject) throw new Error(`No subject "${who}"`);
    const a = new Date(from), b = new Date(to);
    if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) throw new Error("Two moments are needed");
    const g = this.getGraph();
    if (!g?.capabilities.cypher) throw new Error("The graph is off.");
    if (!/^[A-Z][A-Za-z]*$/.test(subject.label)) throw new Error(`Not a label: ${subject.label}`);
    await this.ensureSchema(g);
    const cypher = diffCypher(subject.label);
    const started = performance.now();
    const r = await g.run(cypher, { id: subject.id, t1: a.toISOString(), t2: b.toISOString() });
    const query_ms = Math.round((r.summary?.resultAvailableAfterMs ?? performance.now() - started) * 100) / 100;
    return {
      subject, from: a.toISOString(), to: b.toISOString(), query_ms, cypher: cypher.trim(),
      changes: r.records.map((x) => ({
        id: String(x.get("id")), predicate: String(x.get("predicate") ?? ""), object: String(x.get("object") ?? ""),
        before: String(x.get("before")) as FactState | "absent", after: String(x.get("after")) as FactState | "absent",
      })),
    };
  }

  /** A person named by address in an action's detail (to=…), as a subject ref. */
  private personFor(detail: string | null | undefined): string | null {
    if (!detail || !detail.includes("@")) return null;
    try {
      const ids = this.db.prepare("SELECT contact_id, value_norm FROM contact_identities WHERE kind = 'email'").all() as Array<{ contact_id: string; value_norm: string }>;
      const hit = ids.find((i) => i.value_norm && detail.toLowerCase().includes(i.value_norm));
      return hit ? this.keptRef(hit.contact_id) : null;
    } catch { return null; }
  }

  /** A contact id (or a merged one) as the subject ref it lives under now. */
  private personForRef(ref: string | null | undefined): string | null {
    if (!ref) return null;
    try {
      const c = this.db.prepare("SELECT id FROM contacts WHERE id = ?").get(ref) as { id: string } | undefined;
      if (c) return this.keptRef(c.id);
      const m = this.db.prepare("SELECT kept_id FROM contact_merges WHERE merged_id = ?").get(ref) as { kept_id: string } | undefined;
      if (m) return `Person:${m.kept_id}`;
      const f = this.db.prepare("SELECT subject FROM facts WHERE id = ?").get(ref) as { subject: string } | undefined;
      return f?.subject ?? null;
    } catch { return null; }
  }

  private keptRef(contactId: string): string {
    try {
      const m = this.db.prepare("SELECT kept_id FROM contact_merges WHERE merged_id = ?").get(contactId) as { kept_id: string } | undefined;
      return `Person:${m?.kept_id ?? contactId}`;
    } catch { return `Person:${contactId}`; }
  }

  private officeName(id: string): string {
    try { return (this.db.prepare("SELECT name FROM agent_flows WHERE id = ?").get(id) as { name: string } | undefined)?.name ?? ""; } catch { return ""; }
  }

  /**
   * Turn provenance rows and runs into ticks and replay events: runs on record
   * replay from their own steps; actions without a run row (an older run, a
   * seeded history) become a short run of their calls; an action that left
   * Kernl gets its verdict. Returns the offices involved, most active first.
   */
  private stitch(
    prov: ProvRow[],
    extraRunIds: string[],
    ticks: StoryTick[],
    replay: ReplayEvent[],
    subjectOf: (p: ProvRow) => string | null,
  ): Story["offices"] {
    const agentName = (id: string, fallback = "") => {
      try {
        const a = this.db.prepare("SELECT name FROM agents WHERE id = ?").get(id) as { name: string } | undefined;
        return a?.name ?? fallback;
      } catch { return fallback; }
    };
    const runIds = [...new Set([...prov.map((p) => p.run_id).filter(Boolean), ...extraRunIds])];
    const runs = runIds.length
      ? (this.db
          .prepare(`SELECT id, agent_id, goal, status, created_at, completed_at, parent_run_id, parent_agent_id FROM agent_runs WHERE id IN (${runIds.map(() => "?").join(",")})`)
          .all(...runIds) as Array<{ id: string; agent_id: string; goal: string; status: string; created_at: string; completed_at: string | null; parent_run_id: string | null; parent_agent_id: string | null }>)
      : [];
    const known = new Map(runs.map((r) => [r.id, r]));
    const officeRuns = new Map<string, number>();
    const countOffice = (agentId: string) => {
      try {
        const f = this.db.prepare("SELECT flow_id FROM agents WHERE id = ?").get(agentId) as { flow_id: string | null } | undefined;
        if (f?.flow_id) officeRuns.set(f.flow_id, (officeRuns.get(f.flow_id) ?? 0) + 1);
      } catch { /* no agents table */ }
    };
    for (const run of runs.sort((a, b) => a.created_at.localeCompare(b.created_at))) {
      const name = agentName(run.agent_id);
      countOffice(run.agent_id);
      if (/^new (e-?mail|message) received|^from: /i.test(run.goal ?? "")) {
        replay.push({ at: shift(run.created_at, -4000), event: "comms:mail:received", data: { count: 1 } });
        ticks.push({ at: run.created_at, kind: "action", label: "A mail arrives", agent_id: run.agent_id, agent_name: name });
      }
      if (run.parent_run_id && run.parent_agent_id) {
        replay.push({
          at: shift(run.created_at, -1000), event: "chain_triggered",
          data: { source_agent_id: run.parent_agent_id, target_agent_id: run.agent_id, target_agent_name: name },
        });
      }
      ticks.push({ at: run.created_at, kind: "run", label: `${name} runs`, agent_id: run.agent_id, agent_name: name, run_id: run.id });
      replay.push({ at: run.created_at, event: "run_started", data: { agent_id: run.agent_id, agent_name: name, run_id: run.id, goal: (run.goal ?? "").slice(0, 200) } });
      const steps = this.db
        .prepare("SELECT type, tool_name, created_at FROM agent_run_steps WHERE run_id = ? AND type = 'tool_call' ORDER BY step_number")
        .all(run.id) as Array<{ type: string; tool_name: string | null; created_at: string }>;
      for (const s of steps) {
        if (!s.tool_name || s.tool_name === "ToolSearch") continue;
        replay.push({ at: s.created_at, event: "step", data: { agent_id: run.agent_id, run_id: run.id, type: "tool_call", tool_name: s.tool_name.replace(/^mcp__[^_]+__/, "") } });
      }
      // Lessons the run was given (agent_run_learnings: what its prompt carried,
      // its own and other agents') are recalled, not learned: they replay at the
      // run's start, each from the agent that learned it.
      let recalled: Array<{ id: string; type: string; owner: string; shared: number }> = [];
      try {
        recalled = this.db
          .prepare(
            `SELECT l.id, l.type, l.agent_id AS owner, rl.shared FROM agent_run_learnings rl
               JOIN agent_learnings l ON l.id = rl.learning_id
              WHERE rl.run_id = ? ORDER BY rl.shared DESC LIMIT 5`,
          )
          .all(run.id) as typeof recalled;
      } catch { /* no agent_run_learnings yet */ }
      if (recalled.length > 0) {
        replay.push({
          at: shift(run.created_at, 300), event: "learning_recalled",
          data: {
            agent_id: run.agent_id, agent_name: name, run_id: run.id,
            items: recalled.map((l) => ({ learning_id: l.id, learning_type: l.type, source_agent_id: l.owner, source_agent_name: agentName(l.owner), shared: l.shared === 1 })),
          },
        });
        const shared = recalled.filter((l) => l.shared === 1);
        if (shared.length > 0) {
          const from = [...new Set(shared.map((l) => agentName(l.owner)).filter(Boolean))].join(", ");
          ticks.push({ at: shift(run.created_at, 300), kind: "action", label: `${name} recalls ${shared.length} lesson(s)${from ? ` from ${from}` : ""}`, agent_id: run.agent_id, agent_name: name, run_id: run.id });
        }
      }
      // Lessons the run kept: those it produced (source_runs), or written by
      // its agent while it ran.
      const end0 = run.completed_at ?? steps.at(-1)?.created_at ?? run.created_at;
      const learned = this.db
        .prepare(
          `SELECT DISTINCT l.type, l.created_at FROM agent_learnings l
            WHERE l.agent_id = ?
              AND (instr(l.source_runs, '"' || ? || '"') > 0
                   OR (l.created_at >= ? AND l.created_at <= ? AND l.type <> 'insight'))
            ORDER BY l.created_at LIMIT 3`,
        )
        .all(run.agent_id, run.id, run.created_at, shift(end0, 1000)) as Array<{ type: string; created_at: string }>;
      for (const l of learned) {
        replay.push({ at: l.created_at, event: "learning_created", data: { agent_id: run.agent_id, learning_type: l.type } });
        ticks.push({ at: l.created_at, kind: "action", label: `${name} keeps a lesson`, agent_id: run.agent_id, agent_name: name });
      }
      const end = run.completed_at ?? steps.at(-1)?.created_at ?? run.created_at;
      replay.push({ at: end, event: "run_completed", data: { agent_id: run.agent_id, run_id: run.id, status: run.status === "completed" ? "completed" : run.status } });
      // What the run did to the lessons it carried (agent_learning_confidence):
      // the spark back to whoever learned each one.
      try {
        const moved = this.db
          .prepare(
            `SELECT h.learning_id, h.before, h.after, h.delta, h.cause, l.agent_id AS owner, l.type
               FROM agent_learning_confidence h JOIN agent_learnings l ON l.id = h.learning_id
              WHERE h.run_id = ? AND h.cause LIKE 'run:%' ORDER BY h.rowid`,
          )
          .all(run.id) as Array<{ learning_id: string; before: number | null; after: number; delta: number; cause: string; owner: string; type: string }>;
        if (moved.length > 0) {
          replay.push({
            at: shift(end, 600), event: "learning_reinforced",
            data: {
              agent_id: run.agent_id, agent_name: name, run_id: run.id, outcome: moved[0].cause.slice(4),
              items: moved.map((m) => ({
                learning_id: m.learning_id, owner_agent_id: m.owner, owner_agent_name: agentName(m.owner),
                shared: m.owner !== run.agent_id, learning_type: m.type,
                before: m.before, after: m.after, delta: m.delta, deactivated: m.after < 0.15,
              })),
            },
          });
        }
      } catch { /* no confidence history yet (agents migration 63) */ }
    }
    // Agent learnings are linked to runs only when the run kept them; a lesson
    // added through the tool is still in provenance.
    const seen = new Set<string>();
    for (const p of prov) {
      if (p.run_id && known.has(p.run_id)) continue;
      const key = `${p.run_id || p.at}:${p.tool}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const name = p.actor_name || agentName(p.actor_id, p.actor_kind);
      if (p.actor_kind === "agent") {
        countOffice(p.actor_id);
        replay.push({ at: p.at, event: "run_started", data: { agent_id: p.actor_id, agent_name: name, run_id: p.run_id } });
        replay.push({ at: shift(p.at, 500), event: "step", data: { agent_id: p.actor_id, run_id: p.run_id, type: "tool_call", tool_name: p.tool } });
        replay.push({ at: shift(p.at, 1500), event: "run_completed", data: { agent_id: p.actor_id, run_id: p.run_id, status: "completed" } });
      }
      if (!/^kernel_facts_assert$|^kernel_crm_add_contact$/.test(p.tool)) {
        const tick: StoryTick = { at: p.at, kind: "action", label: `${name}: ${p.tool.replace(/^kernel_/, "").replace(/_/g, " ")}`, agent_id: p.actor_id, agent_name: name, run_id: p.run_id };
        // Something that went out (a mail, a post): was it right for what was known?
        if (/(^|_)(send|reply|forward|post|publish|propose)(_|$)/.test(p.tool)) {
          const ref = subjectOf(p);
          const e = ref ? this.explain(ref, p.at) : null;
          if (e?.verdict) { tick.verdict = e.verdict; tick.why = e.why; }
        }
        ticks.push(tick);
      }
    }

    return [...officeRuns.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id, n]) => ({ id, name: this.officeName(id), runs: n }));
  }
}

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

function shift(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

function dedupe(ticks: StoryTick[]): StoryTick[] {
  const out: StoryTick[] = [];
  for (const t of ticks) {
    const prev = out.at(-1);
    if (prev && prev.label === t.label && prev.at.slice(0, 16) === t.at.slice(0, 16)) continue;
    out.push(t);
  }
  return out;
}
