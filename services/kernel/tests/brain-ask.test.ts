import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { RelateGraphDriver, relateClientInstalled } from "../src/core/db-drivers/builtins/relate-graph-driver.js";
import type { GraphDriver } from "../src/core/db-drivers/graph-driver.js";
import type { EmbeddingsClient } from "../src/core/embeddings/index.js";
import { brainMigrations } from "../src/modules/brain/migrations.js";
import { chatMigrations } from "../src/modules/chat/migrations/001_chat.js";
import { BrainService } from "../src/modules/brain/service.js";
import { askMemory, fuse, queryTerms } from "../src/modules/brain/ask.js";

/** A toy 4-d space: each topic word pulls toward one axis. */
const AXES: Record<string, number> = { engine: 0, garden: 1, invoice: 2, deploy: 3 };
function vec(text: string): number[] {
  const v = [0.01, 0.01, 0.01, 0.01];
  for (const w of text.toLowerCase().split(/\W+/)) if (w in AXES) v[AXES[w]] += 1;
  return v;
}
function client(model: string): EmbeddingsClient {
  return { provider: "test", model, dim: 4, embed: async (texts: string[]) => texts.map(vec) } as unknown as EmbeddingsClient;
}

async function setup() {
  const db = new Database(":memory:");
  runMigrations(db as never, "brain", brainMigrations);
  runMigrations(db as never, "chat", chatMigrations);
  const g = new RelateGraphDriver();
  g.configure({ path: ":memory:" });
  await g.start();
  for (const [name, label] of [["memory-embeddings", "Memory"], ["agent-learning-embeddings", "AgentLearning"]]) {
    await g.run(`CREATE VECTOR INDEX \`${name}\` IF NOT EXISTS FOR (n:${label}) ON (n.embedding)
                 OPTIONS { indexConfig: { \`vector.dimensions\`: 4, \`vector.similarity_function\`: 'cosine' }}`);
  }
  await g.run("CREATE FULLTEXT INDEX `agent-learning-text` IF NOT EXISTS FOR (l:AgentLearning) ON EACH [l.content]");
  return { db, g };
}

describe("queryTerms and fuse", () => {
  it("keeps distinct words of three letters or more, in any script", () => {
    expect(queryTerms("¿Qué sé de Ada y el motor-analítico?")).toEqual(["ada", "motor", "analítico"]);
    expect(queryTerms("cómo evitar que se corte la respuesta del modelo")).toEqual(["evitar", "corte", "respuesta", "modelo"]);
  });

  it("adds up ranks for one key found by several searches and keeps the first fields", () => {
    const out = fuse([
      [{ key: "Task:1", kind: "task", title: "A", text: "a", ref: { x: "1" }, leg: "brain" },
       { key: "Task:2", kind: "task", title: "B", text: "b", ref: {}, leg: "brain" }],
      [{ key: "Task:2", kind: "task", title: "B", text: "bbb", ref: { y: "2" }, elementId: "e2", leg: "entities" }],
    ]);
    expect(out.map((h) => h.candidate.key)).toEqual(["Task:2", "Task:1"]);
    expect(out[0].via).toEqual(["brain", "entities"]);
    expect(out[0].candidate).toMatchObject({ text: "bbb", elementId: "e2", ref: { y: "2" } });
  });
});

describe.skipIf(!relateClientInstalled())("askMemory on Relate", () => {
  it("answers from brain, chat, learnings and the graph, fused, with one hop of context", async () => {
    const { db, g } = await setup();
    const brain = new BrainService(db as never, client("main"));

    // Graph entities, as the modules project them.
    await g.run(`CREATE (p:Person {id: 'c1', name: 'Ada Lovelace', company: 'Analytical'}),
                        (t:Task {id: 't1', title: 'Finish the engine notes'}),
                        (n:Note {id: 'n1', title: 'Garden plan'}),
                        (t)-[:ASSIGNED_TO]->(p)`);
    // The same task also indexed in the brain: one result, not two.
    brain.upsert({ kind: "task", sourceTable: "tasks", sourceId: "t1", text: "Finish the engine notes", embedding: vec("engine") });
    brain.upsert({ kind: "note", sourceTable: "notes", sourceId: "n1", text: "Garden plan", embedding: vec("garden") });

    // A chat message, in SQLite (FTS) and as a graph memory.
    db.prepare("INSERT INTO chat_episodes (id, created_at, updated_at) VALUES ('ep1', 'x', 'x')").run();
    db.prepare("INSERT INTO chat_messages (id, episode_id, role, content, created_at) VALUES ('m1', 'ep1', 'user', 'Ada asked about the engine schedule', '2026-11-10')").run();
    db.prepare("INSERT INTO chat_messages_fts (message_id, content) VALUES ('m1', 'Ada asked about the engine schedule')").run();
    await g.run("CREATE (:Memory {id: 'm1', module: 'chat', episode_id: 'ep1', role: 'user', content: 'Ada asked about the engine schedule', embedding: $v})", { v: vec("engine") });

    // Agent learnings: one in the configured model, one written by another model.
    await g.run(`CREATE (a:Agent {id: 'ag1', name: 'Builder'})-[:LEARNED]->(:AgentLearning {id: 'l1', type: 'insight', active: true,
                   agent_id: 'ag1', content: 'The engine build needs the notes first', embedding: $v, embedding_model: 'main'})`, { v: vec("engine") });
    await g.run(`CREATE (:AgentLearning {id: 'l2', type: 'insight', active: true, agent_id: 'ag1',
                   content: 'Unrelated deploy tip', embedding: $v, embedding_model: 'other'})`, { v: vec("engine") });

    const deps = { db: db as never, brain: () => brain, embeddings: () => client("main"), chatEmbeddings: () => client("local"), graph: () => g as GraphDriver };
    const { results, legs } = await askMemory(deps, { query: "engine notes", limit: 10 });

    expect(legs).toMatchObject({ brain: 1, "chat-text": 1, "chat-vector": 1, "learning-vector": 1, "learning-text": 1 });
    const keys = results.map((r) => r.key);
    expect(keys).toContain("Task:t1");
    expect(keys).toContain("Memory:m1");
    expect(keys).toContain("AgentLearning:l1");
    expect(keys).not.toContain("AgentLearning:l2");
    expect(keys).not.toContain("Note:n1");
    expect(keys.filter((k) => k === "Task:t1")).toHaveLength(1);

    const task = results.find((r) => r.key === "Task:t1")!;
    expect(task.via).toEqual(expect.arrayContaining(["brain", "entities"]));
    expect(task.related).toEqual([{ rel: "ASSIGNED_TO", out: true, label: "Person", name: "Ada Lovelace" }]);
    // Found by more searches, so it ranks first.
    expect(results[0].key).toBe("Task:t1");
    expect(results.find((r) => r.key === "AgentLearning:l1")!.related).toEqual([
      { rel: "LEARNED", out: false, label: "Agent", name: "Builder" },
    ]);

    // A person by name, with what points at them.
    const ada = await askMemory(deps, { query: "Ada", limit: 5 });
    const person = ada.results.find((r) => r.key === "Person:c1")!;
    expect(person.related).toEqual([{ rel: "ASSIGNED_TO", out: false, label: "Task", name: "Finish the engine notes" }]);
  });

  it("degrades to what is left when the graph and embeddings are off", async () => {
    const { db } = await setup();
    db.prepare("INSERT INTO chat_episodes (id, created_at, updated_at) VALUES ('ep1', 'x', 'x')").run();
    db.prepare("INSERT INTO chat_messages (id, episode_id, role, content, created_at) VALUES ('m1', 'ep1', 'user', 'invoice for March', 'x')").run();
    db.prepare("INSERT INTO chat_messages_fts (message_id, content) VALUES ('m1', 'invoice for March')").run();
    const out = await askMemory(
      { db: db as never, brain: () => null, embeddings: () => null, chatEmbeddings: () => null, graph: () => null },
      { query: "the March invoice" },
    );
    expect(out.results.map((r) => r.key)).toEqual(["Memory:m1"]);
    expect(out.legs).toMatchObject({ brain: "brain offline", "chat-text": 1, entities: "graph off" });
  });
});
