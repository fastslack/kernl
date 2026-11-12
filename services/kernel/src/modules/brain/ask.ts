/**
 * "What do I know about X?" — one question over every memory Kernl keeps.
 *
 * Kernl remembers in several places, each searched its own way until now:
 *   - brain items      (SQLite: embeddings of tasks, notes, contacts, mail…)
 *   - chat memories    (graph `:Memory`, one per chat message, plus SQLite FTS)
 *   - agent learnings  (graph `:AgentLearning`, vector + full-text indexes)
 *   - facts            (SQLite `facts`, what is true now — facts.ts)
 *   - graph entities   (people, tasks, notes, mail, events, products…)
 *
 * `askMemory()` runs a dense and a lexical search on each that has one, fuses
 * the ranked lists with Reciprocal Rank Fusion (one item found by several
 * searches rises; a brain item and the graph node for the same row are one
 * result), then follows one hop in the graph from each result so the answer
 * carries what it is connected to.
 *
 * Every leg is best-effort: a missing index, an offline embeddings backend or
 * a graph that is off only removes that leg, and `legs` says which ran.
 *
 * Vector spaces: each leg is queried with the model its vectors were written
 * with. Chat memories are embedded with the bundled local model; brain items
 * and agent learnings with the configured client (learnings are filtered to
 * that model). Mixing them would compare unrelated spaces.
 */

import type { SqliteDb } from "../../core/db/sqlite.js";
import type { EmbeddingsClient } from "../../core/embeddings/index.js";
import type { GraphDriver } from "../../core/db-drivers/graph-driver.js";
import { log } from "../../core/logger.js";
import type { BrainService } from "./service.js";
import { runVectorSearch } from "../../sdk/graph-vectors.js";

export const ENTITY_TEXT_INDEX = "kernl_entity_text";
const MEMORY_VECTOR_INDEX = "memory-embeddings";
const LEARNING_VECTOR_INDEX = "agent-learning-embeddings";
const LEARNING_TEXT_INDEX = "agent-learning-text";
const RRF_K = 60;
const LEG_SIZE = 20;

/** Labels the entity index covers, and the property that names each. */
export const ENTITY_LABELS = [
  "Person", "Task", "Note", "Goal", "Reminder", "Email", "EmailThread",
  "CalendarEvent", "Product", "Store", "Concept", "Article", "Fact",
] as const;

/** Brain source tables whose rows are also graph nodes keyed by `id`. */
const TABLE_TO_LABEL: Record<string, string> = {
  tasks: "Task",
  contacts: "Person",
  notes: "Note",
  reminders: "Reminder",
  goals: "Goal",
};

export interface AskRelated {
  rel: string;
  /** true when the relationship points from the result to the neighbour. */
  out: boolean;
  label: string;
  name: string;
}

export interface AskHit {
  key: string;
  kind: string;
  title: string;
  text: string;
  score: number;
  /** Which searches found it. */
  via: string[];
  ref: Record<string, string>;
  related?: AskRelated[];
}

export interface AskResult {
  results: AskHit[];
  /** Per leg: how many candidates it returned, or why it did not run. */
  legs: Record<string, number | string>;
}

export interface AskDeps {
  db: SqliteDb;
  brain: () => BrainService | null;
  embeddings: () => EmbeddingsClient | null;
  /** The client chat memories were embedded with. */
  chatEmbeddings: () => EmbeddingsClient | null;
  graph: () => GraphDriver | null;
}

interface Candidate {
  key: string;
  kind: string;
  title: string;
  text: string;
  ref: Record<string, string>;
  elementId?: string;
  /** label + id, to find the node when the leg did not come from the graph. */
  node?: { label: string; id: string };
  /** The search that found it. */
  leg?: string;
}

const str = (v: unknown): string => (v == null ? "" : String(v));
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** The first line that has text in it. */
const firstLine = (s: string): string => s.split("\n").map((l) => l.trim()).find(Boolean) ?? "";

/** Words that match nearly everything in Spanish or English text. */
const STOPWORDS = new Set(
  ("que qué del los las una uno unos unas con por para como cómo cuando cuándo donde dónde este esta esto " +
   "ese esa eso sus mis tus nos les fue son hay ser muy más mas pero sin sobre entre desde hasta todo toda " +
   "the and for with that this from what how who are was were has have not you your our its into about").split(" "),
);

/** Words worth matching, for FTS5 and Lucene alike. */
export function queryTerms(text: string, max = 12): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words.filter((w) => w.length > 2 && !STOPWORDS.has(w)))].slice(0, max);
}

let entityIndexEnsured: GraphDriver | null = null;

/** Create the full-text index over entity names once per graph driver. */
export async function ensureEntityTextIndex(graph: GraphDriver): Promise<void> {
  if (entityIndexEnsured === graph) return;
  await graph.run(
    `CREATE FULLTEXT INDEX ${ENTITY_TEXT_INDEX} IF NOT EXISTS
     FOR (n:${ENTITY_LABELS.join("|")}) ON EACH [n.name, n.title, n.subject, n.label]`,
  );
  entityIndexEnsured = graph;
}

export async function askMemory(
  deps: AskDeps,
  args: { query: string; limit?: number; related?: number },
): Promise<AskResult> {
  const limit = args.limit ?? 10;
  const perNode = args.related ?? 5;
  const legs: Record<string, number | string> = {};
  const lists: Candidate[][] = [];
  const graph = deps.graph();
  const g = graph?.capabilities.cypher ? graph : null;
  const terms = queryTerms(args.query);

  const leg = async (name: string, fn: () => Promise<Candidate[] | string>) => {
    try {
      const out = await fn();
      if (typeof out === "string") {
        legs[name] = out;
        return;
      }
      legs[name] = out.length;
      if (out.length) lists.push(out.map((c) => ({ ...c, leg: name })));
    } catch (err) {
      const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
      // An index appears with the first thing written to it.
      legs[name] = /IndexDoesNotExist|no such index|There is no such/i.test(msg) ? "no index yet" : `failed: ${msg}`;
      log.debug(`brain ask: ${name} failed — ${legs[name]}`);
    }
  };

  const client = deps.embeddings();
  const queryVector = client
    ? await client.embed([args.query], { inputType: "query" }).then((v) => v[0]).catch(() => null)
    : null;

  await leg("brain", async () => {
    const svc = deps.brain();
    if (!svc) return "brain offline";
    const hits = await svc.recall({ query: args.query, limit: LEG_SIZE, queryVector: queryVector ?? undefined });
    return hits.map((h) => {
      const label = TABLE_TO_LABEL[h.item.source_table];
      return {
        key: label ? `${label}:${h.item.source_id}` : `brain:${h.item.id}`,
        kind: h.item.kind,
        title: clip(firstLine(h.item.text), 100),
        text: h.item.text,
        ref: { source_table: h.item.source_table, source_id: h.item.source_id, brain_item_id: h.item.id },
        node: label ? { label, id: h.item.source_id } : undefined,
      };
    });
  });

  await leg("facts", async () => {
    if (terms.length === 0) return "no terms";
    // What is true now and still believed, by how many terms it shares.
    const hits = terms.map(() => "((subject_name || ' ' || subject || ' ' || predicate || ' ' || object) LIKE ?)").join(" + ");
    const rows = deps.db
      .prepare(
        `SELECT * FROM (
           SELECT id, subject, subject_name, predicate, object, valid_from, recorded_at, ${hits} AS hits
           FROM facts WHERE valid_to IS NULL AND superseded_at IS NULL)
         WHERE hits > 0 ORDER BY hits DESC, recorded_at DESC LIMIT ${LEG_SIZE}`,
      )
      .all(...terms.map((t) => `%${t}%`)) as Array<Record<string, unknown>>;
    return rows.map((r) => {
      const line = `${str(r.subject_name) || str(r.subject)} · ${str(r.predicate).replace(/_/g, " ")} · ${str(r.object)}`;
      return {
        key: `Fact:${str(r.id)}`,
        kind: "fact",
        title: clip(line, 100),
        text: `${line} (since ${str(r.valid_from).slice(0, 10)})`,
        ref: { fact_id: str(r.id), subject: str(r.subject) },
        node: { label: "Fact", id: str(r.id) },
      };
    });
  });

  await leg("chat-text", async () => {
    if (terms.length === 0) return "no terms";
    const rows = deps.db
      .prepare(
        `SELECT m.id, m.episode_id, m.role, m.content, m.created_at
         FROM chat_messages_fts f JOIN chat_messages m ON m.id = f.message_id
         WHERE chat_messages_fts MATCH ? ORDER BY rank LIMIT ${LEG_SIZE}`,
      )
      .all(terms.map((t) => `"${t}"`).join(" OR ")) as Array<Record<string, unknown>>;
    return rows.map((r) => chatCandidate(r));
  });

  await leg("chat-vector", async () => {
    if (!g) return "graph off";
    const chatClient = deps.chatEmbeddings();
    if (!chatClient) return "no chat embeddings";
    const [v] = await chatClient.embed([args.query], { inputType: "query" });
    const r = await runVectorSearch(g, {
        index: MEMORY_VECTOR_INDEX, label: "Memory", alias: "node", k: "$k", vector: "$vector",
        filters: { module: "'chat'" },
      }, (clause) => `${clause}
       RETURN node.id AS id, node.episode_id AS episode_id, node.role AS role,
              node.content AS content, node.created_at AS created_at, elementId(node) AS el, score`,
      { k: LEG_SIZE, vector: v },
    );
    // queryNodes reports 0.5 for orthogonal vectors: below that is unrelated.
    return r.records
      .filter((x) => Number(x.get("score")) > 0.6)
      .map((x) => ({ ...chatCandidate(x.toObject()), elementId: str(x.get("el")) }));
  });

  await leg("learning-vector", async () => {
    if (!g) return "graph off";
    if (!queryVector || !client) return "embeddings offline";
    const r = await runVectorSearch(g, {
        index: LEARNING_VECTOR_INDEX, label: "AgentLearning", alias: "l", k: "$k", vector: "$vector",
        filters: { active: "true", embedding_model: "$model" },
        where: "score > 0.6",
      }, (clause) => `${clause}
       RETURN l.id AS id, l.type AS type, l.content AS content, l.agent_id AS agent_id, elementId(l) AS el`,
      { k: LEG_SIZE, vector: queryVector, model: client.model },
    );
    return r.records.map((x) => learningCandidate(x.toObject()));
  });

  await leg("learning-text", async () => {
    if (!g) return "graph off";
    if (terms.length === 0) return "no terms";
    const r = await g.run(
      `CALL db.index.fulltext.queryNodes($index, $terms) YIELD node AS l, score
       WHERE l.active = true
       RETURN l.id AS id, l.type AS type, l.content AS content, l.agent_id AS agent_id, elementId(l) AS el
       LIMIT ${LEG_SIZE}`,
      { index: LEARNING_TEXT_INDEX, terms: terms.join(" ") },
    );
    return r.records.map((x) => learningCandidate(x.toObject()));
  });

  await leg("entities", async () => {
    if (!g) return "graph off";
    if (terms.length === 0) return "no terms";
    await ensureEntityTextIndex(g);
    const r = await g.run(
      `CALL db.index.fulltext.queryNodes($index, $terms) YIELD node AS n, score
       WHERE NOT (n:Fact AND n.current = false)
       RETURN labels(n)[0] AS label, elementId(n) AS el,
              coalesce(n.id, n.gmail_id, n.gmail_thread_id, n.google_event_id, n.link) AS id,
              coalesce(n.name, n.title, n.subject, n.label) AS title,
              coalesce(n.description, n.snippet, n.content, n.email, n.company, '') AS text
       LIMIT ${LEG_SIZE}`,
      { index: ENTITY_TEXT_INDEX, terms: terms.join(" ") },
    );
    return r.records.map((x) => {
      const label = str(x.get("label"));
      const id = str(x.get("id"));
      return {
        key: id ? `${label}:${id}` : `el:${str(x.get("el"))}`,
        kind: label.toLowerCase(),
        title: clip(str(x.get("title")), 100),
        text: str(x.get("text")),
        ref: { label, id },
        elementId: str(x.get("el")),
      };
    });
  });

  const fused = fuse(lists).slice(0, limit);
  if (g && perNode > 0 && fused.length > 0) {
    try {
      await attachRelated(g, fused, perNode);
      legs.related = fused.filter((h) => h.related?.length).length;
    } catch (err) {
      legs.related = `failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
    }
  }
  return {
    results: fused.map(({ candidate: c, score, via, related }) => ({
      key: c.key,
      kind: c.kind,
      title: c.title,
      text: clip(c.text, 400),
      score: Number(score.toFixed(5)),
      via,
      ref: c.ref,
      related,
    })),
    legs,
  };
}

function chatCandidate(r: Record<string, unknown>): Candidate {
  const content = str(r.content);
  return {
    key: `Memory:${str(r.id)}`,
    kind: "chat",
    title: clip(firstLine(content), 100),
    text: content,
    ref: { message_id: str(r.id), episode_id: str(r.episode_id), role: str(r.role), at: str(r.created_at) },
    node: { label: "Memory", id: str(r.id) },
  };
}

function learningCandidate(r: Record<string, unknown>): Candidate {
  const content = str(r.content);
  return {
    key: `AgentLearning:${str(r.id)}`,
    kind: `learning:${str(r.type)}`,
    title: clip(content, 100),
    text: content,
    ref: { learning_id: str(r.id), agent_id: str(r.agent_id) },
    elementId: str(r.el),
  };
}

interface Fused {
  candidate: Candidate;
  score: number;
  via: string[];
  related?: AskRelated[];
}

/** Reciprocal Rank Fusion; candidates sharing a key are one result. */
export function fuse(lists: Candidate[][]): Fused[] {
  const byKey = new Map<string, Fused>();
  for (const list of lists) {
    list.forEach((c, i) => {
      const leg = c.leg ?? "?";
      const cur = byKey.get(c.key);
      const add = 1 / (RRF_K + i + 1);
      if (!cur) {
        byKey.set(c.key, { candidate: { ...c }, score: add, via: [leg] });
        return;
      }
      cur.score += add;
      if (!cur.via.includes(leg)) cur.via.push(leg);
      // Keep the richest fields any leg offered.
      const k = cur.candidate;
      if (!k.elementId && c.elementId) k.elementId = c.elementId;
      if (!k.node && c.node) k.node = c.node;
      if (c.text.length > k.text.length) k.text = c.text;
      k.ref = { ...c.ref, ...k.ref };
    });
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score);
}

/** One hop from each result: what it is connected to, a few per node. */
async function attachRelated(g: GraphDriver, hits: Fused[], perNode: number): Promise<void> {
  // Results that came only from SQLite: find their node by label and id.
  const byLabel = new Map<string, Fused[]>();
  for (const h of hits) {
    const n = h.candidate.node;
    if (h.candidate.elementId || !n || !/^[A-Za-z]+$/.test(n.label)) continue;
    byLabel.set(n.label, [...(byLabel.get(n.label) ?? []), h]);
  }
  for (const [label, group] of byLabel) {
    const r = await g.run(
      `UNWIND $ids AS id MATCH (n:${label} {id: id}) RETURN n.id AS id, elementId(n) AS el`,
      { ids: group.map((h) => h.candidate.node!.id) },
    );
    const els = new Map(r.records.map((x) => [str(x.get("id")), str(x.get("el"))]));
    for (const h of group) h.candidate.elementId = els.get(h.candidate.node!.id) || undefined;
  }

  const ids = hits.map((h) => h.candidate.elementId).filter((e): e is string => !!e);
  if (ids.length === 0) return;
  const r = await g.run(
    `UNWIND $ids AS e
     MATCH (n) WHERE elementId(n) = e
     CALL (n) {
       MATCH (n)-[r]-(m)
       WHERE NOT m:KernlGraphBackfill AND NOT m:AgentXpSync
       RETURN type(r) AS rel, startNode(r) = n AS out, labels(m)[0] AS label,
              [x IN [m.name, m.title, m.subject, m.label, m.goal, left(m.content, 200)]
                 WHERE x IS NOT NULL AND trim(toString(x)) <> ''][0] AS name
       LIMIT $per
     }
     RETURN e, collect({rel: rel, out: out, label: label, name: name}) AS related`,
    { ids, per: perNode },
  );
  const related = new Map(
    r.records.map((x) => [str(x.get("e")), (x.get("related") as AskRelated[]).filter((y) => y.rel)]),
  );
  for (const h of hits) {
    const rel = h.candidate.elementId ? related.get(h.candidate.elementId) : undefined;
    // A run's name is its goal, often a whole prompt: its first line is enough.
    const named = (rel ?? [])
      .map((y) => ({ ...y, name: clip(firstLine(str(y.name)), 100) }))
      .filter((y) => y.name);
    if (named.length) h.related = named;
  }
}
