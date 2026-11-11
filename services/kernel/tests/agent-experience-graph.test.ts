import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { vectorToBlob } from "../src/core/ranking/relevance.js";
import {
  AgentExperienceGraph,
  luceneTerms,
  scoreSharedLearning,
} from "../src/modules/agents/services/experience-graph.js";
import { RelateGraphDriver } from "../src/core/db-drivers/builtins/relate-graph-driver.js";
import type { GraphDriver } from "../src/core/db-drivers/graph-driver.js";

describe("shared-learning scoring", () => {
  it("ranks relevance first, then confidence, tool overlap and office", () => {
    const base = { relevance: 0.6, confidence: 0.5, toolOverlap: 0, sameOffice: false };
    expect(scoreSharedLearning({ ...base, relevance: 0.8 })).toBeGreaterThan(scoreSharedLearning(base));
    expect(scoreSharedLearning({ ...base, toolOverlap: 2 })).toBeGreaterThan(scoreSharedLearning(base));
    expect(scoreSharedLearning({ ...base, sameOffice: true })).toBeGreaterThan(scoreSharedLearning(base));
    // Tool overlap saturates at three tools.
    expect(scoreSharedLearning({ ...base, toolOverlap: 9 })).toBe(scoreSharedLearning({ ...base, toolOverlap: 3 }));
  });

  it("turns a goal into plain search words", () => {
    expect(luceneTerms('Send the "weekly" report: (sales) + invoices!')).toBe("send weekly report sales invoices");
    expect(luceneTerms("a an to")).toBe("");
  });

  it("does nothing without a graph", async () => {
    const db = new Database(":memory:");
    const xp = new AgentExperienceGraph(db as never, () => null);
    expect(xp.available).toBe(false);
    expect(await xp.sync()).toEqual({ agents: 0, runs: 0, learnings: 0 });
    expect(
      await xp.findSharedLearnings({
        agentId: "a", flowId: "", projectId: null, goal: "x", goalVector: null, embeddingModel: null, tools: [],
      }),
    ).toEqual([]);
  });
});

// ── Against the real engine (opt-in, like relate-graph-driver.test.ts) ──

const DIM = 384;
function vec(seed: number): number[] {
  let s = seed;
  const v = Array.from({ length: DIM }, () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647 - 0.5;
  });
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}
function near(v: number[], eps = 0.05): number[] {
  const w = v.map((x, i) => x + eps * Math.sin(i));
  const n = Math.hypot(...w);
  return w.map((x) => x / n);
}

describe.skipIf(!process.env.RELATE_CLIENT_MODULE)("AgentExperienceGraph on Relate", () => {
  let db: Database;
  let graph: GraphDriver;
  let xp: AgentExperienceGraph;
  const MODEL = "Xenova/all-MiniLM-L6-v2";
  const now = "2026-11-11T10:00:00.000Z";

  function addAgent(id: string, name: string, flow = "") {
    db.prepare("INSERT INTO agents (id, name, flow_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, name, flow, now, now);
  }
  function addRun(id: string, agent: string, at: string, tools: string[] = [], status = "completed") {
    db.prepare(
      "INSERT INTO agent_runs (id, agent_id, goal, status, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, agent, `goal of ${id}`, status, at, at);
    tools.forEach((t, i) =>
      db.prepare(
        "INSERT INTO agent_run_steps (id, run_id, step_number, type, tool_name, created_at) VALUES (?, ?, ?, 'tool_call', ?, ?)",
      ).run(`${id}-s${i}`, id, i, t, at),
    );
  }
  function addLearning(
    id: string, agent: string, content: string, v: number[] | null,
    opts: { runs?: string[]; project?: string | null; active?: number; confidence?: number; type?: string; at?: string } = {},
  ) {
    db.prepare(
      `INSERT INTO agent_learnings (id, agent_id, type, content, confidence, source_runs, active, created_at, updated_at, embedding, embedding_model, project_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, agent, opts.type ?? "avoid", content, opts.confidence ?? 0.6, JSON.stringify(opts.runs ?? []),
      opts.active ?? 1, opts.at ?? now, opts.at ?? now, v ? vectorToBlob(v) : null, v ? MODEL : "", opts.project ?? null,
    );
  }

  beforeEach(async () => {
    db = new Database(":memory:");
    runMigrations(db as never, "agents", agentsMigrations);
    const driver = new RelateGraphDriver();
    driver.configure({ path: ":memory:" });
    await driver.start();
    graph = driver;
    xp = new AgentExperienceGraph(db as never, () => graph, () => MODEL);

    addAgent("a", "Mailer", "office-1");
    addAgent("b", "Reporter", "office-1");
    addAgent("c", "Outsider", "office-2");
    addRun("r1", "a", "2026-11-10T09:00:00.000Z", ["kernel_mail_send", "kernel_contacts_search"]);
    addRun("r2", "c", "2026-11-10T09:30:00.000Z", ["kernel_web_fetch"]);
    addLearning("l-mail", "a", "Do not send mail to contacts without an email address", vec(1), { runs: ["r1"] });
    addLearning("l-own", "b", "Reporter's own learning about mail", near(vec(1), 0.02));
    addLearning("l-proj", "a", "Project X uses a special SMTP relay", near(vec(1), 0.03), { project: "proj-x" });
    addLearning("l-off", "a", "Inactive mail learning", near(vec(1), 0.03), { active: 0 });
    addLearning("l-web", "c", "Web fetches time out on large pages", vec(2), { runs: ["r2"] });
  });

  const query = (over: Partial<Parameters<AgentExperienceGraph["findSharedLearnings"]>[0]> = {}) =>
    xp.findSharedLearnings({
      agentId: "b", flowId: "office-1", projectId: null, goal: "send the weekly mail to contacts",
      goalVector: near(vec(1)), embeddingModel: MODEL, tools: ["kernel_mail_send"], ...over,
    });

  it("backfills, then syncs only what changed", async () => {
    expect(await xp.sync()).toEqual({ agents: 3, runs: 2, learnings: 5 });
    const second = await xp.sync();
    expect(second.runs).toBe(0);
    expect(second.learnings).toBe(0);

    addRun("r3", "b", "2026-11-11T11:00:00.000Z", ["kernel_mail_send"]);
    expect((await xp.sync()).runs).toBe(1);
    const used = await graph.run(
      "MATCH (:AgentRun {id: 'r3'})-[u:USED]->(t:AgentTool) RETURN t.name AS t, u.calls AS c",
    );
    expect(used.records[0].get("t")).toBe("kernel_mail_send");
    expect(Number(used.records[0].get("c"))).toBe(1);
  });

  it("finds another agent's learning by meaning, with provenance", async () => {
    await xp.sync();
    const hits = await query();
    expect(hits.map((h) => h.id)).toEqual(["l-mail"]);
    expect(hits[0]).toMatchObject({ agentId: "a", agentName: "Mailer", toolOverlap: 1, sameOffice: true });
    expect(hits[0].relevance).toBeGreaterThan(0.8);
  });

  it("keeps the agent's own, inactive and other-project learnings out", async () => {
    await xp.sync();
    const ids = (await query()).map((h) => h.id);
    expect(ids).not.toContain("l-own");
    expect(ids).not.toContain("l-off");
    expect(ids).not.toContain("l-proj");
    // Inside that project, its learning is fair game.
    expect((await query({ projectId: "proj-x" })).map((h) => h.id)).toContain("l-proj");
  });

  it("ignores learnings that do not fit the goal", async () => {
    await xp.sync();
    const ids = (await query({ goalVector: vec(999) })).map((h) => h.id);
    expect(ids).toEqual([]);
  });

  it("falls back to full-text search without a goal vector", async () => {
    await xp.sync();
    const hits = await query({ goalVector: null, goal: "web fetches keep timing out on large pages" });
    expect(hits.map((h) => h.id)).toEqual(["l-web"]);
  });

  it("picks up an embedding that arrives after the learning was synced", async () => {
    addLearning("l-late", "c", "Late learning about mail contacts", null, { at: "2026-11-11T12:00:00.000Z" });
    await xp.sync();
    db.prepare("UPDATE agent_learnings SET embedding = ?, embedding_model = ? WHERE id = 'l-late'").run(
      vectorToBlob(near(vec(1), 0.01)), MODEL,
    );
    expect((await xp.sync()).learnings).toBe(1);
    expect((await query()).map((h) => h.id)).toContain("l-late");
  });
});
