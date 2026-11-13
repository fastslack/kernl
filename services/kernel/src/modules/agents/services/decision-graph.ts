/**
 * The office's decisions in the graph, connected to what they were about.
 *
 *   (q:AgentQuestion {id, flow_id, category, subject_key, status, text,
 *                     asked_at, answered_at, answer, answered_by, via, actor})
 *   (q)-[:ASKED_BY]->(:Agent {id})          (q)-[:IN_RUN]->(:AgentRun {id})
 *   (q)-[:ABOUT]->(w:WorkItem {key})        (w)-[:PART_OF]->(:WorkItem {key})   web#2653:a-b → web#2653
 *   (q)-[:DECIDED_BY]->(:DecisionMaker {id, via})
 *   (q)-[:DECIDED_WHILE]->(e:EnvFact)       the environment problems open when it was answered
 *   (e:EnvFact {id, flow_id, key, valid_from, valid_to})
 *   (w)-[:BLOCKED_BY]->(e)                  work parked on an environment problem
 *
 * SQLite stays the record; this is the connected view of it: everything asked
 * and decided about an issue and its parts, who decided each, and what was
 * broken at the time — a question about one office's issue took 115 questions
 * over 31 parts, and the answer to "what happened here" is one traversal.
 * Times are native datetimes, so "decided while DEV was down" is a range test.
 */
import type { GraphDriver } from "../../../core/db-drivers/graph-driver.js";
import type { SqliteDb } from "../../../core/db/sqlite.js";
import { log } from "../../../core/logger.js";

const SCHEMA = [
  "CREATE CONSTRAINT agent_question_id IF NOT EXISTS FOR (q:AgentQuestion) REQUIRE q.id IS UNIQUE",
  "CREATE CONSTRAINT work_item_key IF NOT EXISTS FOR (w:WorkItem) REQUIRE w.key IS UNIQUE",
  "CREATE CONSTRAINT decision_maker_id IF NOT EXISTS FOR (d:DecisionMaker) REQUIRE d.id IS UNIQUE",
  "CREATE CONSTRAINT env_fact_id IF NOT EXISTS FOR (e:EnvFact) REQUIRE e.id IS UNIQUE",
  "CREATE INDEX agent_question_subject IF NOT EXISTS FOR (q:AgentQuestion) ON (q.subject_key)",
];

interface QuestionRow {
  id: string; from_agent_id: string; flow_id: string; run_id: string; question: string; status: string;
  category: string; subject_key: string; created_at: string; answered_at: string | null;
  selected_option: string; answered_by: string; answered_via: string; answered_actor: string; for_operator: number;
}

export interface SubjectHistoryEntry {
  id: string; subject_key: string; category: string; asked_at: string; question: string; status: string;
  answer: string | null; answered_at: string | null; answered_by: string; via: string; actor: string;
  asked_by: string | null; env_open: string[];
}

export class DecisionGraph {
  private schemaReady = new WeakSet<object>();
  private watermark = "";
  /** The store the watermark belongs to: a new one is projected from the start. */
  private watermarkGraph: GraphDriver | null = null;

  constructor(private readonly db: SqliteDb, private readonly getGraph: () => GraphDriver | null | undefined) {}

  private graph(): GraphDriver | null {
    const g = this.getGraph();
    return g?.capabilities.cypher ? g : null;
  }

  private async ensureSchema(g: GraphDriver): Promise<void> {
    if (this.schemaReady.has(g)) return;
    for (const s of SCHEMA) {
      try { await g.run(s); } catch (err) { log.debug(`decision-graph: ${s.slice(0, 60)}… — ${String(err)}`); }
    }
    this.schemaReady.add(g);
  }

  /** Project the questions touched since the last pass (asked, answered, owed). */
  async sync(): Promise<number> {
    const g = this.graph();
    if (!g) return 0;
    if (g !== this.watermarkGraph) {
      this.watermark = "";
      this.watermarkGraph = g;
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_questions
         WHERE max(created_at, coalesce(answered_at, ''), coalesce(owed_at, '')) > ?
         ORDER BY max(created_at, coalesce(answered_at, ''), coalesce(owed_at, '')) LIMIT 2000`,
      )
      .all(this.watermark) as Array<QuestionRow & { owed_at: string | null }>;
    if (rows.length === 0) return 0;
    await this.projectQuestions(g, rows);
    await this.projectEnvFacts(g);
    const last = rows[rows.length - 1];
    this.watermark = [last.created_at, last.answered_at ?? "", last.owed_at ?? ""].sort().pop()!;
    return rows.length;
  }

  async projectQuestions(g: GraphDriver, rows: QuestionRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.ensureSchema(g);
    const envAt = this.db.prepare(
      "SELECT id FROM agent_env_facts WHERE flow_id = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)",
    );
    const data = rows.map((q) => {
      const parent = q.subject_key.includes(":") ? q.subject_key.split(":")[0] : null;
      const decided = q.status === "answered" || q.status === "owed";
      return {
        id: q.id,
        props: {
          flow_id: q.flow_id, category: q.category, subject_key: q.subject_key, status: q.status,
          text: q.question.slice(0, 500), answer: decided ? q.selected_option : null, answered_by: q.answered_by,
          via: q.answered_via, actor: q.answered_actor, for_operator: q.for_operator === 1,
        },
        asked_at: q.created_at, answered_at: q.answered_at,
        agent: q.from_agent_id, run: q.run_id || null, subject: q.subject_key || null, parent,
        maker: decided ? (q.answered_actor || q.answered_via || q.answered_by || null) : null,
        makerVia: q.answered_via,
        env: decided && q.answered_at ? (envAt.all(q.flow_id, q.answered_at, q.answered_at) as Array<{ id: string }>).map((e) => e.id) : [],
      };
    });
    const write = async (tx: Pick<GraphDriver, "run">) => {
      await tx.run(
        `UNWIND $rows AS r
         MERGE (q:AgentQuestion {id: r.id}) SET q += r.props,
           q.asked_at = datetime(r.asked_at), q.answered_at = datetime(r.answered_at)
         MERGE (a:Agent {id: r.agent}) MERGE (q)-[:ASKED_BY]->(a)`,
        { rows: data },
      );
      const withRun = data.filter((r) => r.run);
      if (withRun.length) {
        await tx.run("UNWIND $rows AS r MATCH (q:AgentQuestion {id: r.id}) MERGE (run:AgentRun {id: r.run}) MERGE (q)-[:IN_RUN]->(run)", { rows: withRun });
      }
      const withSubject = data.filter((r) => r.subject);
      if (withSubject.length) {
        await tx.run(
          `UNWIND $rows AS r MATCH (q:AgentQuestion {id: r.id})
           MERGE (w:WorkItem {key: r.subject}) SET w.flow_id = q.flow_id MERGE (q)-[:ABOUT]->(w)`,
          { rows: withSubject },
        );
        const parts = withSubject.filter((r) => r.parent);
        if (parts.length) {
          await tx.run(
            `UNWIND $rows AS r MATCH (w:WorkItem {key: r.subject})
             MERGE (p:WorkItem {key: r.parent}) MERGE (w)-[:PART_OF]->(p)`,
            { rows: parts },
          );
        }
      }
      const decided = data.filter((r) => r.maker);
      if (decided.length) {
        await tx.run(
          `UNWIND $rows AS r MATCH (q:AgentQuestion {id: r.id})
           MERGE (d:DecisionMaker {id: r.maker}) SET d.via = r.makerVia
           MERGE (q)-[:DECIDED_BY]->(d)`,
          { rows: decided },
        );
      }
      const env = data.flatMap((r) => r.env.map((e) => ({ id: r.id, env: e })));
      if (env.length) {
        await tx.run(
          "UNWIND $rows AS r MATCH (q:AgentQuestion {id: r.id}) MERGE (e:EnvFact {id: r.env}) MERGE (q)-[:DECIDED_WHILE]->(e)",
          { rows: env },
        );
      }
    };
    if (g.withTransaction) await g.withTransaction(write);
    else await write(g);
  }

  /** Every environment fact, with the work parked on each. */
  async projectEnvFacts(g: GraphDriver): Promise<number> {
    await this.ensureSchema(g);
    const facts = this.db.prepare("SELECT * FROM agent_env_facts").all() as Array<{
      id: string; flow_id: string; key: string; description: string; valid_from: string; valid_to: string | null;
    }>;
    if (facts.length === 0) return 0;
    const blocks = this.db.prepare("SELECT fact_id, subject_key FROM agent_env_blocks WHERE subject_key <> ''").all() as Array<{ fact_id: string; subject_key: string }>;
    const write = async (tx: Pick<GraphDriver, "run">) => {
      await tx.run(
        `UNWIND $rows AS r MERGE (e:EnvFact {id: r.id})
         SET e.flow_id = r.flow_id, e.key = r.key, e.description = r.description,
             e.valid_from = datetime(r.valid_from), e.valid_to = datetime(r.valid_to)`,
        { rows: facts },
      );
      if (blocks.length) {
        await tx.run(
          "UNWIND $rows AS r MATCH (e:EnvFact {id: r.fact_id}) MERGE (w:WorkItem {key: r.subject_key}) MERGE (w)-[:BLOCKED_BY]->(e)",
          { rows: blocks },
        );
      }
    };
    if (g.withTransaction) await g.withTransaction(write);
    else await write(g);
    return facts.length;
  }

  /** Everything, for the graph backfill. */
  async backfill(g: GraphDriver): Promise<{ nodes: number; relationships: number }> {
    const all = this.db.prepare("SELECT * FROM agent_questions ORDER BY created_at").all() as QuestionRow[];
    for (let i = 0; i < all.length; i += 500) await this.projectQuestions(g, all.slice(i, i + 500));
    const env = await this.projectEnvFacts(g);
    return { nodes: all.length + env, relationships: all.length * 2 };
  }

  /**
   * What was asked and decided about a subject and all its parts, oldest
   * first: who decided each, through what, and which environment problems
   * were open at the time.
   */
  async subjectHistory(key: string, limit = 200): Promise<SubjectHistoryEntry[] | null> {
    const g = this.graph();
    if (!g) return null;
    const root = key.toLowerCase().split(":")[0];
    const r = await g.run(
      `MATCH (w:WorkItem) WHERE w.key = $key OR w.key = $root OR w.key STARTS WITH $prefix
       MATCH (q:AgentQuestion)-[:ABOUT]->(w)
       OPTIONAL MATCH (q)-[:ASKED_BY]->(a:Agent)
       OPTIONAL MATCH (q)-[:DECIDED_WHILE]->(e:EnvFact)
       WITH q, a, collect(DISTINCT e.key) AS env
       RETURN q.id AS id, q.subject_key AS subject_key, q.category AS category, toString(q.asked_at) AS asked_at,
              q.text AS question, q.status AS status, q.answer AS answer, toString(q.answered_at) AS answered_at,
              q.answered_by AS answered_by, q.via AS via, q.actor AS actor, a.id AS asked_by, env
       ORDER BY q.asked_at LIMIT $limit`,
      { key: key.toLowerCase(), root, prefix: `${root}:`, limit },
    );
    return r.records.map((x) => ({
      id: String(x.get("id")), subject_key: String(x.get("subject_key") ?? ""), category: String(x.get("category") ?? ""),
      asked_at: String(x.get("asked_at") ?? ""), question: String(x.get("question") ?? ""), status: String(x.get("status") ?? ""),
      answer: (x.get("answer") as string | null) ?? null, answered_at: (x.get("answered_at") as string | null) ?? null,
      answered_by: String(x.get("answered_by") ?? ""), via: String(x.get("via") ?? ""), actor: String(x.get("actor") ?? ""),
      asked_by: (x.get("asked_by") as string | null) ?? null, env_open: (x.get("env") as string[] | null) ?? [],
    }));
  }
}
