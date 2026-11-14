import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { ReembedQueue, AGENT_REEMBED_TARGETS } from "../src/core/embeddings/reembed.js";
import { EmbeddingsManager } from "../src/core/embeddings/manager.js";
import type { EmbedOptions, EmbeddingsClient } from "../src/core/embeddings/client.js";
import { blobToVector } from "../src/core/ranking/relevance.js";

class FakeClient implements EmbeddingsClient {
  calls: string[][] = [];
  failOn = new Set<string>();
  down = false;
  constructor(public provider: "local" | "lmstudio", public model: string, public dim = 3) {}
  async available() { return !this.down; }
  async embed(texts: string[], _o?: EmbedOptions): Promise<number[][]> {
    this.calls.push(texts);
    if (this.down) throw new Error("connection refused");
    if (texts.some((t) => this.failOn.has(t))) throw new Error("bad input");
    return texts.map((t) => [t.length, 1, this.dim]);
  }
}

function schema(db: Database) {
  db.exec(`
    CREATE TABLE agent_learnings (id TEXT PRIMARY KEY, content TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
      embedding BLOB, embedding_model TEXT NOT NULL DEFAULT '');
    CREATE TABLE agent_memory (id TEXT PRIMARY KEY, content TEXT NOT NULL, embedding BLOB, embedding_model TEXT NOT NULL DEFAULT '');
    CREATE TABLE agent_runs (id TEXT PRIMARY KEY, goal TEXT NOT NULL, goal_embedding BLOB, goal_embedding_model TEXT NOT NULL DEFAULT '');
  `);
}

const blob = (v: number[]) => Buffer.from(new Float32Array(v).buffer);

function seed(db: Database) {
  const L = db.prepare("INSERT INTO agent_learnings (id, content, active, embedding, embedding_model) VALUES (?, ?, ?, ?, ?)");
  L.run("l1", "usar la copia", 1, blob([1, 1, 1]), "old-model");
  L.run("l2", "probar migración", 1, blob([1, 1, 1]), "new-model");
  L.run("l3", "retired lesson", 0, blob([1, 1, 1]), "old-model");
  L.run("l4", "never embedded", 1, null, "");
  db.prepare("INSERT INTO agent_memory (id, content, embedding, embedding_model) VALUES (?, ?, ?, ?)").run("m1", "hola", null, "");
  const R = db.prepare("INSERT INTO agent_runs (id, goal, goal_embedding, goal_embedding_model) VALUES (?, ?, ?, ?)");
  R.run("r1", "do x", null, ""); // under minTextLen 5
  R.run("r2", "do the thing", blob([1, 1, 1]), "old-model");
}

describe("ReembedQueue", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    schema(db);
    seed(db);
  });

  it("counts what does not carry the active model's vectors", () => {
    const q = new ReembedQueue(db, () => new FakeClient("local", "new-model"));
    expect(q.pending("new-model")).toEqual({ agent_learnings: 2, agent_runs: 1, agent_memory: 1 });
  });

  it("re-embeds stale and missing rows, skips retired and too-short ones", async () => {
    const c = new FakeClient("local", "new-model");
    const batches: string[] = [];
    let done = null as Record<string, number> | null;
    const q = new ReembedQueue(db, () => c, {
      pauseMs: 0,
      passes: [],
      onBatch: ({ table, ids }) => batches.push(`${table}:${ids.sort().join(",")}`),
      onDone: (i) => { done = i.done; },
    });
    await q.run();
    expect(q.pending("new-model")).toEqual({ agent_learnings: 0, agent_runs: 0, agent_memory: 0 });
    const l1 = db.prepare("SELECT embedding, embedding_model FROM agent_learnings WHERE id = 'l1'").get() as { embedding: Buffer; embedding_model: string };
    expect(l1.embedding_model).toBe("new-model");
    expect(blobToVector(l1.embedding)).toEqual(["usar la copia".length, 1, 3]);
    const l3 = db.prepare("SELECT embedding_model FROM agent_learnings WHERE id = 'l3'").get() as { embedding_model: string };
    expect(l3.embedding_model).toBe("old-model");
    const r1 = db.prepare("SELECT goal_embedding_model FROM agent_runs WHERE id = 'r1'").get() as { goal_embedding_model: string };
    expect(r1.goal_embedding_model).toBe("");
    expect(batches).toEqual(["agent_learnings:l1,l4", "agent_runs:r2", "agent_memory:m1"]);
    expect(done).toEqual({ agent_learnings: 2, agent_runs: 1, agent_memory: 1 });
    // l2 already had the active model: never sent to the encoder.
    expect(c.calls.flat()).not.toContain("probar migración");
  });

  it("passes over a row that will not embed instead of blocking the rest", async () => {
    const c = new FakeClient("local", "new-model");
    c.failOn.add("usar la copia");
    const q = new ReembedQueue(db, () => c, { pauseMs: 0 });
    await q.run();
    expect(q.pending("new-model")).toEqual({ agent_learnings: 1, agent_runs: 0, agent_memory: 0 });
  });

  it("stops when the provider is down and keeps the rows for later", async () => {
    const c = new FakeClient("lmstudio", "new-model");
    c.down = true;
    const q = new ReembedQueue(db, () => c, { pauseMs: 0 });
    await q.run();
    const s = q.status();
    expect(s.lastError).toContain("connection refused");
    expect(s.pending.agent_learnings).toBe(2);
    c.down = false;
    await q.run();
    expect(q.pending("new-model").agent_learnings).toBe(0);
  });

  it("drops vectors of the wrong size", async () => {
    const c = new FakeClient("local", "new-model", 3);
    const q = new ReembedQueue(db, () => ({ ...c, embed: c.embed.bind(c), available: c.available.bind(c), dim: 4 } as EmbeddingsClient), { pauseMs: 0 });
    await q.run();
    expect(q.pending("new-model").agent_learnings).toBe(2);
  });

  it("restarts under the new model when the client swaps mid-run", async () => {
    let client: FakeClient = new FakeClient("lmstudio", "old-model");
    const q = new ReembedQueue(db, () => client, {
      pauseMs: 0,
      batchSize: 1,
      onBatch: () => { client = new FakeClient("local", "new-model"); },
    });
    await q.run();
    expect(q.pending("new-model")).toEqual({ agent_learnings: 0, agent_runs: 0, agent_memory: 0 });
  });

  it("folds a run asked for mid-run into one rerun", async () => {
    const c = new FakeClient("local", "new-model");
    const q = new ReembedQueue(db, () => c, { pauseMs: 0 });
    const a = q.run();
    const b = q.run();
    expect(b).toBe(a);
    await a;
    expect(q.status().running).toBe(false);
  });

  it("ends each run with the registered passes", async () => {
    const c = new FakeClient("local", "new-model");
    let ran = 0;
    const q = new ReembedQueue(db, () => c, { pauseMs: 0, passes: [{ name: "graph_nodes", run: async () => { ran++; return 7; } }] });
    await q.run();
    expect(ran).toBe(1);
    expect(q.status().done.graph_nodes).toBe(7);
  });

  it("ignores tables that do not exist", () => {
    const empty = new Database(":memory:");
    const q = new ReembedQueue(empty, () => new FakeClient("local", "m"), { targets: AGENT_REEMBED_TARGETS });
    expect(q.pending("m")).toEqual({});
  });
});

describe("EmbeddingsManager", () => {
  it("delegates and reads model/dim through after a swap", async () => {
    const lm = new FakeClient("lmstudio", "lm-model", 3);
    const local = new FakeClient("local", "local-model", 3);
    let next: EmbeddingsClient = local;
    const lastResort = new Set<EmbeddingsClient>([local]);
    const m = await EmbeddingsManager.create({
      build: async () => next,
      isLastResort: (c) => lastResort.has(c),
      reprobeMs: 60_000,
    });
    expect(m.model).toBe("local-model");
    expect(m.status().lastResort).toBe(true);
    await m.embed(["a"]);
    expect(local.calls.length).toBe(1);

    const swaps: string[] = [];
    m.onSwap((c) => swaps.push(c.model));
    // Same client again: no swap.
    expect(await m.rebuild("probe")).toBe(false);
    // LM Studio comes back.
    next = lm;
    expect(await m.rebuild("probe")).toBe(true);
    expect(m.model).toBe("lm-model");
    expect(m.provider).toBe("lmstudio");
    expect(m.status().lastResort).toBe(false);
    expect(swaps).toEqual(["lm-model"]);
    await m.embed(["b"]);
    expect(lm.calls.length).toBe(1);
    m.stop();
  });

  it("keeps one shared local instance across a switch, and tracks last-resort by build", async () => {
    const { sharedLocalEmbeddings } = await import("../src/core/embeddings/local.js");
    const a = sharedLocalEmbeddings({ id: "x/m", dim: 384 }, "fp32");
    expect(sharedLocalEmbeddings({ id: "x/m", dim: 384 }, "fp32")).toBe(a);
    expect(sharedLocalEmbeddings({ id: "x/m", dim: 384 }, "q8")).not.toBe(a);
    let lastResort = true;
    const swaps: string[] = [];
    const m = await EmbeddingsManager.create({ build: async () => a, isLastResort: () => lastResort, reprobeMs: 60_000 });
    m.onSwap((c) => swaps.push(c.model));
    expect(m.status().lastResort).toBe(true);
    lastResort = false; // "auto" with every link down → "local": same instance
    expect(await m.rebuild("EMBEDDINGS_PROVIDER changed")).toBe(false);
    expect(m.current()).toBe(a);
    expect(m.status().lastResort).toBe(false);
    expect(swaps).toEqual([]);
    m.stop();
  });

  it("keeps the current client when a rebuild fails", async () => {
    const local = new FakeClient("local", "local-model");
    let fail = false;
    const m = await EmbeddingsManager.create({
      build: async () => { if (fail) throw new Error("boom"); return local; },
    });
    fail = true;
    expect(await m.rebuild("setting changed")).toBe(false);
    expect(m.current()).toBe(local);
    m.stop();
  });

  it("runs the re-embed queue after a model swap", async () => {
    const db = new Database(":memory:");
    schema(db);
    seed(db);
    const a = new FakeClient("lmstudio", "old-model");
    const b = new FakeClient("local", "new-model");
    let next: EmbeddingsClient = a;
    const m = await EmbeddingsManager.create({ build: async () => next, reembedDelayMs: 60_000 });
    let finished: (() => void) | null = null;
    const done = new Promise<void>((r) => { finished = r; });
    m.attachReembed(new ReembedQueue(db, () => m, { pauseMs: 0, onDone: (i) => { if (i.model === "new-model") finished?.(); } }));
    next = b;
    await m.rebuild("EMBEDDINGS_PROVIDER changed");
    await done;
    const row = db.prepare("SELECT embedding_model FROM agent_learnings WHERE id = 'l1'").get() as { embedding_model: string };
    expect(row.embedding_model).toBe("new-model");
    m.stop();
  });
});
