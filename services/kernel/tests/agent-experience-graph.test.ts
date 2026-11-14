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
import { RelateGraphDriver, relateClientInstalled } from "../src/core/db-drivers/builtins/relate-graph-driver.js";
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

  it("a sync still running on a store that was switched out does not hold up the new store's", async () => {
    const db = new Database(":memory:");
    runMigrations(db as never, "agents", agentsMigrations);
    // The old store never answers: its driver was stopped mid-pass.
    const old = { capabilities: { cypher: true }, run: () => new Promise(() => {}) } as unknown as GraphDriver;
    const fresh = { capabilities: { cypher: true }, run: async () => ({ records: [] }) } as unknown as GraphDriver;
    let active: GraphDriver = old;
    const xp = new AgentExperienceGraph(db as never, () => active);
    void xp.sync();
    active = fresh;
    const done = await Promise.race([xp.sync(), new Promise((r) => setTimeout(() => r("held up"), 500))]);
    expect(done).toEqual({ agents: 0, runs: 0, learnings: 0 });
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

describe.skipIf(!relateClientInstalled())("AgentExperienceGraph on Relate", () => {
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

  it("counts failed tool results as USED errors, and resyncs a store synced before that", async () => {
    addRun("r4", "b", "2026-11-11T12:00:00.000Z", ["kernel_mail_send", "kernel_mail_send"]);
    const result = (n: number, isError: boolean) =>
      db.prepare(
        `INSERT INTO agent_run_steps (id, run_id, step_number, type, tool_name, tool_input, created_at)
         VALUES (?, 'r4', ?, 'tool_result', 'kernel_mail_send', ?, ?)`,
      ).run(`r4-res${n}`, 10 + n, JSON.stringify({ is_error: isError }), now);
    result(1, true);
    result(2, false);
    const errorsOf = async (run: string) => Number((await graph.run(
      `MATCH (:AgentRun {id: $run})-[u:USED]->(:AgentTool {name: 'kernel_mail_send'}) RETURN u.errors AS e`, { run },
    )).records[0].get("e"));

    await xp.sync();
    expect(await errorsOf("r4")).toBe(1);

    // A store whose runs were synced by the old count is synced again once.
    await graph.run("MATCH (s:AgentXpSync {id: 'agents'}) SET s.runs_version = 1");
    await graph.run("MATCH (:AgentRun {id: 'r4'})-[u:USED]->() SET u.errors = 0");
    expect((await xp.sync()).runs).toBe(3);
    expect(await errorsOf("r4")).toBe(1);
    expect((await xp.sync()).runs).toBe(0);
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
    const ids = (await query({ goalVector: vec(999), goal: "rotate the quarterly backup keys" })).map((h) => h.id);
    expect(ids).toEqual([]);
  });

  it("does not compare vectors across embedding models, but still finds by words", async () => {
    await xp.sync();
    // Same direction, different model: the vector leg must not match it…
    const byVectorOnly = await query({ embeddingModel: "other-model", goal: "zzz unrelated words" });
    expect(byVectorOnly).toEqual([]);
    // …while the words of the goal still reach it.
    const byWords = await query({ embeddingModel: "other-model" });
    expect(byWords.map((h) => h.id)).toContain("l-mail");
  });

  it("falls back to full-text search without a goal vector", async () => {
    await xp.sync();
    const hits = await query({ goalVector: null, goal: "web fetches keep timing out on large pages" });
    expect(hits.map((h) => h.id)).toEqual(["l-web"]);
  });

  it("projects what each run was given as RECALLED, and measures whether a lesson helped", async () => {
    // b's runs after l-mail exists: two carried it (one failed), two did not (one failed).
    addRun("rb1", "b", "2026-11-11T11:00:00.000Z");
    addRun("rb2", "b", "2026-11-11T11:10:00.000Z", [], "failed");
    addRun("rb3", "b", "2026-11-11T11:20:00.000Z");
    addRun("rb4", "b", "2026-11-11T11:30:00.000Z", [], "failed");
    addRun("rb0", "b", "2026-11-09T08:00:00.000Z"); // before the lesson: not compared
    const give = db.prepare("INSERT INTO agent_run_learnings (run_id, learning_id, shared) VALUES (?, ?, ?)");
    give.run("rb1", "l-mail", 1);
    give.run("rb2", "l-mail", 1);
    give.run("rb1", "l-own", 0);
    // A first sync writes runs before learnings: the edge must survive that order.
    await xp.sync();
    const edges = await graph.run(
      "MATCH (r:AgentRun)-[c:RECALLED]->(l:AgentLearning) RETURN r.id AS r, l.id AS l, c.shared AS s, l.content AS content ORDER BY r, l",
    );
    expect(edges.records.map((x) => [x.get("r"), x.get("l"), x.get("s")])).toEqual([
      ["rb1", "l-mail", true], ["rb1", "l-own", false], ["rb2", "l-mail", true],
    ]);
    expect(edges.records[0].get("content")).toContain("email address");

    const impact = (await xp.learningImpact("l-mail"))!;
    expect(impact.owner).toEqual({ id: "a", name: "Mailer" });
    expect(impact.with).toEqual({ runs: 2, ok: 1 });
    expect(impact.without).toEqual({ runs: 2, ok: 1 });
    expect(impact.agents).toEqual([{ id: "b", name: "Reporter", runs: 2, ok: 1, shared: true }]);
    expect(typeof impact.query_ms).toBe("number");
    expect(await xp.learningImpact("nope")).toBeNull();
  });

  it("follows a lesson's lineage, and lays out the library with how often each lesson was carried", async () => {
    // l-mail (a, from r1) → carried by b's rb1, which produced l-b1 → carried by c's rc1 (failed).
    addRun("rb1", "b", "2026-11-11T11:00:00.000Z");
    addRun("rc1", "c", "2026-11-11T12:00:00.000Z", [], "failed");
    addRun("rc2", "c", "2026-11-11T12:30:00.000Z");
    addLearning("l-b1", "b", "Confirm the address before mailing", near(vec(1), 0.04), { runs: ["rb1"], at: "2026-11-11T11:05:00.000Z" });
    const give = db.prepare("INSERT INTO agent_run_learnings (run_id, learning_id, shared) VALUES (?, ?, 1)");
    give.run("rb1", "l-mail");
    give.run("rc2", "l-mail");
    give.run("rc1", "l-b1");
    await xp.sync();

    const lin = (await xp.learningLineage("l-mail"))!;
    expect(lin.nodes.map((n) => [n.id, n.depth, n.owner.name])).toEqual([["l-mail", 0, "Mailer"], ["l-b1", 1, "Reporter"]]);
    expect(lin.nodes[0].from_runs).toEqual(["r1"]);
    const uses = Object.fromEntries(lin.nodes[0].uses.map((u) => [u.run, u]));
    expect(uses.rb1).toMatchObject({ agent: "b", status: "completed", child: "l-b1" });
    expect(uses.rc2).toMatchObject({ agent: "c", child: null });
    expect(lin.nodes[1].uses).toEqual([expect.objectContaining({ run: "rc1", agent: "c", status: "failed" })]);
    expect(await xp.learningLineage("nope")).toBeNull();

    const lib = (await xp.learningLibrary("office-1"))!;
    expect(lib.agents.map((a) => a.name).sort()).toEqual(["Mailer", "Reporter"]);
    const mail = lib.agents.find((a) => a.id === "a")!.books.find((b) => b.id === "l-mail")!;
    expect(mail).toMatchObject({ uses: 2, shared_uses: 2, last_used: "2026-11-11T12:30:00.000Z", active: true });
    const all = (await xp.learningLibrary())!;
    expect(all.agents.map((a) => a.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("lays the lessons out as a constellation: alike lessons linked and grouped, by Relate's cosine", async () => {
    await xp.sync();
    const c = (await xp.learningConstellation())!;
    expect(c.stars.length).toBe(5);
    // The four mail lessons are near-copies of one vector: their links are the strongest,
    // and they share a group. (The test's web vector correlates with them at ~0.7.)
    const mail = ["l-mail", "l-own", "l-proj", "l-off"];
    const inMail = (l: { a: string; b: string }) => mail.includes(l.a) && mail.includes(l.b);
    const minMail = Math.min(...c.links.filter(inMail).map((l) => l.s));
    const maxWeb = Math.max(...c.links.filter((l) => !inMail(l)).map((l) => l.s));
    expect(minMail).toBeGreaterThan(0.95);
    expect(maxWeb).toBeLessThan(minMail);
    const groupOf = new Map(c.stars.map((st) => [st.id, st.group]));
    expect(new Set(mail.map((id) => groupOf.get(id))).size).toBe(1);
    expect(c.groups[0].name).toContain("mail");
    for (const st of c.stars) { expect(Math.abs(st.x)).toBeLessThanOrEqual(1); expect(Math.abs(st.y)).toBeLessThanOrEqual(1); }
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

  it("re-projects learnings re-embedded under a new model, without an updated_at bump", async () => {
    let active = MODEL;
    const xp2 = new AgentExperienceGraph(db as never, () => graph, () => active);
    await xp2.sync();
    // The active model changes; nothing is re-embedded yet, so nothing moves.
    active = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
    expect((await xp2.sync()).learnings).toBe(0);
    // The re-embed queue rewrites one row's vector (updated_at untouched).
    db.prepare("UPDATE agent_learnings SET embedding = ?, embedding_model = ? WHERE id = 'l-mail'").run(
      vectorToBlob(vec(1)), active,
    );
    expect((await xp2.sync()).learnings).toBe(1);
    expect((await xp2.sync()).learnings).toBe(0);
    const hits = await xp2.findSharedLearnings({
      agentId: "b", flowId: "office-1", projectId: null, goal: "zzz unrelated words",
      goalVector: near(vec(1)), embeddingModel: active, tools: [],
    });
    expect(hits.map((h) => h.id)).toEqual(["l-mail"]);
  });
});
