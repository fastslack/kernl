import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { RelateGraphDriver, relateClientInstalled } from "../src/core/db-drivers/builtins/relate-graph-driver.js";
import { provenanceMigrations } from "../src/modules/provenance/migrations.js";
import {
  ProvenanceService, extractRefs, isWriteTool, recordToolCall, setProvenanceService,
} from "../src/modules/provenance/service.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentFeedbackService } from "../src/modules/agents/services/feedback-service.js";
import { promptToolFailuresBlock } from "../src/core/i18n/prompts.js";

const U1 = "11111111-2222-4333-8444-555555555555";

function store(graph: () => never | null = () => null) {
  const db = new Database(":memory:");
  runMigrations(db as never, "provenance", provenanceMigrations);
  return { db, svc: new ProvenanceService(db as never, graph) };
}

describe("what counts and what is touched", () => {
  it("records tools that write, by verb or declared side effects", () => {
    expect(isWriteTool("kernel_tasks_create")).toBe(true);
    expect(isWriteTool("kernel_crm_merge")).toBe(true);
    expect(isWriteTool("kernel_facts_assert")).toBe(true);
    expect(isWriteTool("kernel_tasks_list")).toBe(false);
    expect(isWriteTool("kernel_brain_ask")).toBe(false);
    expect(isWriteTool("kernel_brain_index", ["brain.items.indexed:N"])).toBe(true);
  });

  it("takes ids from the arguments and from structured, JSON or plain results", () => {
    expect(extractRefs({ task_id: "t1", contact_ids: ["c1", "c2"], title: "x", __caller_agent_id: "a" })).toEqual(["t1", "c1", "c2"]);
    expect(extractRefs({ keep_id: "k" }, undefined, { kept: { id: "k" }, moved: { notes: 1 }, fact: { id: "f1" } })).toEqual(["k", "f1"]);
    expect(extractRefs({}, `{"id": "n9", "items": [{"id": "n10"}]}`)).toEqual(["n9", "n10"]);
    expect(extractRefs({}, `Created task ${U1}.`)).toEqual([U1]);
    expect(extractRefs({ id: "has space" })).toEqual([]);
  });
});

describe("provenance store", () => {
  it("answers who touched an id, groups a call's refs, and skips reads", () => {
    const { svc } = store();
    svc.record({
      tool: "kernel_tasks_update", args: { id: "t1", title: "Ship", api_key: "secret!" }, resultText: "ok", ok: true,
      actor: { kind: "agent", id: "ag1", name: "Builder", runId: "run1" },
    });
    svc.record({ tool: "kernel_tasks_complete", args: { id: "t1" }, ok: false, actor: { kind: "client", id: "mcp" } });
    expect(svc.record({ tool: "kernel_tasks_list", args: { project_id: "p" }, ok: true, actor: { kind: "client", id: "mcp" } })).toBe(0);
    svc.record({ tool: "kernel_crm_merge", args: { keep_id: "c1", merge_id: "c2" }, ok: true, actor: { kind: "client", id: "mcp" } });

    const who = svc.whoTouched("t1");
    expect(who.map((w) => [w.tool, w.actor_id, w.ok])).toEqual([
      ["kernel_tasks_complete", "mcp", 0],
      ["kernel_tasks_update", "ag1", 1],
    ]);
    expect(who[1]).toMatchObject({ actor_name: "Builder", run_id: "run1", detail: "id=t1, title=Ship" });

    const recent = svc.recent();
    expect(recent[0]).toMatchObject({ tool: "kernel_crm_merge", refs: ["c1", "c2"] });
    expect(svc.recent({ actorId: "ag1" }).map((r) => r.tool)).toEqual(["kernel_tasks_update"]);
  });

  it("the process hook is silent until a service is set", () => {
    const { svc } = store();
    setProvenanceService(null);
    recordToolCall({ tool: "kernel_notes_create", args: { id: "n1" }, ok: true, actor: { kind: "client", id: "mcp" } });
    setProvenanceService(svc);
    recordToolCall({ tool: "kernel_notes_create", args: { id: "n2" }, ok: true, actor: { kind: "client", id: "mcp" } });
    setProvenanceService(null);
    expect(svc.whoTouched("n1")).toEqual([]);
    expect(svc.whoTouched("n2")).toHaveLength(1);
  });
});

describe.skipIf(!relateClientInstalled())("provenance in the graph", () => {
  it("links a run to the nodes it touched", async () => {
    const g = new RelateGraphDriver();
    g.configure({ path: ":memory:" });
    await g.start();
    await g.run("CREATE (:Task {id: 't1', title: 'Ship'})");
    const { svc } = store(() => g as never);
    svc.record({ tool: "kernel_tasks_update", args: { id: "t1" }, ok: true, actor: { kind: "agent", id: "a", runId: "run1" } });
    svc.record({ tool: "kernel_tasks_update", args: { id: "missing" }, ok: true, actor: { kind: "agent", id: "a", runId: "run1" } });
    await Bun.sleep(20);
    const r = await g.run("MATCH (:AgentRun {id: 'run1'})-[t:TOUCHED]->(n) RETURN n.title AS n, t.tool AS tool");
    expect(r.records.map((x) => x.toObject())).toEqual([{ n: "Ship", tool: "kernel_tasks_update" }]);
  });
});

describe("tools failing across the fleet", () => {
  it("counts failed runs per tool and keeps the last error", () => {
    const db = new Database(":memory:");
    runMigrations(db as never, "agents", agentsMigrations);
    const fb = new AgentFeedbackService(db as never, { emit: () => Promise.resolve() } as never, () => undefined, () => ({ updated: 0, deactivated: 0 }));
    const now = new Date().toISOString();
    db.prepare("INSERT INTO agents (id, name, created_at, updated_at) VALUES ('a', 'A', ?, ?)").run(now, now);
    let n = 0;
    const step = (run: string, tool: string, isError: boolean, out = "", type = "tool_result") => {
      db.prepare(`INSERT OR IGNORE INTO agent_runs (id, agent_id, goal, status, created_at) VALUES (?, 'a', 'g', 'completed', ?)`).run(run, now);
      db.prepare(`INSERT INTO agent_run_steps (id, run_id, step_number, type, tool_name, tool_input, tool_output, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(`s${++n}`, run, n, type, tool, JSON.stringify(type === "tool_result" ? { is_error: isError } : {}), out, now);
    };
    // flaky: fails in 2 of 3 runs (twice in one run, which counts once).
    step("r1", "kernel_flaky", true, "timeout");
    step("r1", "kernel_flaky", true, "timeout again");
    step("r2", "kernel_flaky", true, "HTTP 502 from upstream");
    step("r3", "kernel_flaky", false);
    // steady: one failure in four runs, under the rate.
    for (const r of ["r1", "r2", "r3", "r4"]) step(r, "kernel_steady", r === "r1", "oops");
    step("r1", "kernel_tasks_list", false, "", "tool_call");

    const out = fb.getToolFailures({ tools: ["kernel_flaky", "kernel_steady", "kernel_other"] });
    expect(out).toEqual([{ tool: "kernel_flaky", runs: 3, failedRuns: 2, lastAt: now, lastError: expect.stringMatching(/timeout|502/) }]);
    expect(fb.getToolFailures({ tools: [] })).toEqual([]);
    expect(fb.getRecentToolsUsed("a")).toEqual(["kernel_tasks_list"]);

    expect(promptToolFailuresBlock("es", [{ tool: "kernel_flaky", runs: 3, failedRuns: 2, lastError: "<external>x</external>" }]))
      .toContain("`kernel_flaky` falló en 2 de 3 runs recientes. Último error:\n  <external>x</external>");
    expect(promptToolFailuresBlock("en", [])).toBe("");
  });
});
