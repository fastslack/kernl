import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { brainMigrations } from "../src/modules/brain/migrations.js";
import { provenanceMigrations } from "../src/modules/provenance/migrations.js";
import { FactStore } from "../src/modules/brain/facts.js";
import { ProvenanceService } from "../src/modules/provenance/service.js";
import { explainBelief, type Explanation } from "../src/modules/brain/explain.js";

/** Facts and provenance on one clock that the test moves. */
function world() {
  const db = new Database(":memory:");
  runMigrations(db as never, "brain", brainMigrations);
  runMigrations(db as never, "provenance", provenanceMigrations);
  let now = "2026-01-01T00:00:00.000Z";
  const clock = () => now;
  const facts = new FactStore(db as never, () => null, clock);
  const prov = new ProvenanceService(db as never, () => null, clock);
  const at = (t: string) => { now = new Date(t).toISOString(); };
  /** Assert as an agent would: through a recorded tool call. */
  const assertBy = (actor: string, input: Parameters<FactStore["assert"]>[0]) => {
    const out = facts.assert(input);
    prov.record({
      tool: "kernel_facts_assert", args: { subject: input.subject, predicate: input.predicate, object: input.object },
      structured: { fact: { id: out.fact.id } }, ok: true,
      actor: { kind: "agent", id: actor.toLowerCase(), name: actor, runId: `run-${actor}` },
    });
    return out;
  };
  return { db, facts, prov, at, assertBy };
}

describe("what Kernl believed then", () => {
  it("does not see an ending Kernl only learned later", () => {
    const { facts, at } = world();
    at("2026-10-02T10:00:00Z");
    facts.assert({ subject: "Person:l", subjectName: "Lucía", predicate: "works_at", object: "Andina", validFrom: "2026-09-01" });
    at("2026-11-12T09:00:00Z");
    facts.assert({ subject: "Person:l", predicate: "works_at", object: "Delta", validFrom: "2026-11-01" });

    // On Nov 10 Kernl still believed Andina, although she had left on Nov 1.
    expect(facts.query({ subject: "Person:l", asOf: "2026-11-10", knownAt: "2026-11-10" }).map((f) => f.object)).toEqual(["Andina"]);
    expect(facts.query({ subject: "Person:l", knownAt: "2026-11-10" }).map((f) => f.object)).toEqual(["Andina"]);
    // Knowing what it knows now, it was Delta on Nov 10.
    expect(facts.query({ subject: "Person:l", asOf: "2026-11-10" }).map((f) => f.object)).toEqual(["Delta"]);
  });

  it("a retraction is dated by when Kernl made it", () => {
    const { facts, at } = world();
    at("2026-03-01T00:00:00Z");
    const f = facts.assert({ subject: "me", predicate: "lives_in", object: "Rosario", validFrom: "2026-01-01" });
    at("2026-06-01T00:00:00Z");
    facts.retract(f.fact.id, "ended", "2026-04-01");
    expect(facts.get(f.fact.id)?.ended_at).toBe("2026-06-01T00:00:00.000Z");
    expect(facts.query({ subject: "me", asOf: "2026-05-01", knownAt: "2026-05-01" }).map((x) => x.object)).toEqual(["Rosario"]);
    expect(facts.query({ subject: "me", asOf: "2026-05-01" })).toEqual([]);
  });

  it("dates the endings recorded before the column existed", () => {
    const db = new Database(":memory:");
    runMigrations(db as never, "brain", brainMigrations.filter((m) => m.version < 3));
    db.run(`INSERT INTO facts (id, subject, predicate, object, valid_from, valid_to, ended_by, recorded_at)
            VALUES ('a', 's', 'p', 'x', '2026-01-01', '2026-02-01', 'b', '2026-01-01'),
                   ('b', 's', 'p', 'y', '2026-02-01', NULL, NULL, '2026-03-05'),
                   ('c', 's', 'q', 'z', '2026-01-01', '2026-02-01', NULL, '2026-01-01')`);
    runMigrations(db as never, "brain", brainMigrations);
    const rows = db.query("SELECT id, ended_at FROM facts ORDER BY id").all();
    expect(rows).toEqual([
      { id: "a", ended_at: "2026-03-05" },
      { id: "b", ended_at: null },
      { id: "c", ended_at: "2026-02-01" },
    ]);
  });
});

describe("kernel_facts_explain", () => {
  /** Lucía changed jobs on Nov 1; the proposal went out Nov 10; Kernl heard on Nov 12. */
  function lucia() {
    const w = world();
    w.at("2026-10-02T10:00:00Z");
    w.assertBy("Ana · CRM", {
      subject: "Person:l", subjectName: "Lucía Ferreyra", predicate: "works_at", object: "Andina Logística",
      validFrom: "2026-09-01", source: "email signature",
    });
    w.assertBy("Ana · CRM", { subject: "Person:l", predicate: "email", object: "lucia@andina.example", validFrom: "2026-09-01" });
    w.assertBy("Ana · CRM", { subject: "Person:l", predicate: "role", object: "Head of purchasing", validFrom: "2026-09-01" });
    w.at("2026-11-10T14:30:00Z");
    w.prov.record({
      tool: "kernel_email_send", args: { draft_id: "mail-1", to: "lucia@andina.example", subject: "Proposal" },
      ok: true, actor: { kind: "agent", id: "bruno", name: "Bruno · Sales", runId: "run-b" },
    });
    w.at("2026-11-12T09:00:00Z");
    w.assertBy("Ana · CRM", { subject: "Person:l", predicate: "works_at", object: "Delta Norte", validFrom: "2026-11-01", source: "email from her new address" });
    w.assertBy("Ana · CRM", { subject: "Person:l", predicate: "email", object: "lucia@deltanorte.example", validFrom: "2026-11-01" });
    return w;
  }

  it("finds the moment from the action and calls the difference late information", () => {
    const w = lucia();
    const e = explainBelief(w.facts, w.prov, { name: "Lucía", actionRef: "mail-1" }) as Explanation;
    expect(e.status).toBe("explained");
    expect(e.at).toBe("2026-11-10T14:30:00.000Z");
    expect(e.action).toMatchObject({ actor_name: "Bruno · Sales", tool: "kernel_email_send" });
    expect(e.verdict).toBe("late_information");

    const job = e.findings.find((f) => f.predicate === "works_at")!;
    expect(job.verdict).toBe("late_information");
    expect(job.believed.map((f) => f.object)).toEqual(["Andina Logística"]);
    expect(job.actual.map((f) => f.object)).toEqual(["Delta Norte"]);
    expect(job.believed[0].written_by).toMatchObject({ actor_name: "Ana · CRM", tool: "kernel_facts_assert" });
    expect(job.lag_days).toBe(2);
    expect(job.sentence).toContain("written by Ana · CRM");
    expect(job.sentence).toContain("from email signature");
    expect(job.sentence).toContain("The information was late, not the reasoning.");

    expect(e.findings.find((f) => f.predicate === "role")?.verdict).toBe("consistent");
    // The differences come first, after the action.
    expect(e.summary[0]).toContain("Bruno · Sales called kernel_email_send");
    expect(e.findings.at(-1)?.verdict).toBe("consistent");
  });

  it("one predicate, an explicit moment, and nothing to blame when nothing differed", () => {
    const w = lucia();
    const e = explainBelief(w.facts, w.prov, { subject: "Person:l", predicate: "role", at: "2026-11-10" }) as Explanation;
    expect(e.verdict).toBe("consistent");
    expect(e.findings.map((f) => f.predicate)).toEqual(["role"]);
  });

  it("a belief later corrected is a wrong belief", () => {
    const w = world();
    w.at("2026-05-01T00:00:00Z");
    w.assertBy("Ana", { subject: "Person:m", subjectName: "Mateo", predicate: "birthday", object: "03-04" });
    w.at("2026-07-01T00:00:00Z");
    w.assertBy("Ana", { subject: "Person:m", predicate: "birthday", object: "04-03", mode: "correction" });
    const e = explainBelief(w.facts, w.prov, { subject: "Person:m", at: "2026-06-01" }) as Explanation;
    expect(e.verdict).toBe("wrong_belief");
    expect(e.findings[0]).toMatchObject({ lag_days: 30 });
    expect(e.findings[0].sentence).toContain("the stored fact was wrong");
  });

  it("asks which one when a name matches several, and says what is missing", () => {
    const w = world();
    w.facts.assert({ subject: "Person:a", subjectName: "Ana Paz", predicate: "p", object: "x" });
    w.facts.assert({ subject: "Person:b", subjectName: "Ana Gil", predicate: "p", object: "y" });
    expect(explainBelief(w.facts, w.prov, { name: "Ana", at: "2026-01-01" })).toMatchObject({
      status: "ambiguous", candidates: [{ subject: "Person:a", subject_name: "Ana Paz" }, { subject: "Person:b", subject_name: "Ana Gil" }],
    });
    expect(() => explainBelief(w.facts, w.prov, { name: "Nadie", at: "2026-01-01" })).toThrow(/no facts/);
    w.facts.assert({ subject: "Person:c", subjectName: "Lucía Ferreyra", predicate: "p", object: "z" });
    expect(w.facts.findSubjects("lucia")).toEqual([{ subject: "Person:c", subject_name: "Lucía Ferreyra" }]);
    expect(() => explainBelief(w.facts, w.prov, { subject: "Person:a" })).toThrow(/at or action_ref/);
    expect(() => explainBelief(w.facts, w.prov, { subject: "Person:a", actionRef: "nope" })).toThrow(/no recorded action/);
  });
});
