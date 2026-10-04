import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";

describe("agents migration 45 — agent_questions triage", () => {
  it("keeps legacy rows and accepts the triage status", () => {
    const db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations.filter((m) => m.version < 45));
    db.run(`INSERT INTO agent_questions (id, from_agent_id, question, options, status, selected_option, selected_index, created_at)
            VALUES ('q1','a1','old?','[]','answered','Yes',0,'2026-01-01T00:00:00Z'),
                   ('q2','a1','open?','[]','pending','',-1,'2026-01-02T00:00:00Z')`);

    runMigrations(db, "agents", agentsMigrations);

    const rows = db.prepare("SELECT id, status, selected_option, answered_by, chief_note, triage_started_at FROM agent_questions ORDER BY id").all();
    expect(rows).toEqual([
      { id: "q1", status: "answered", selected_option: "Yes", answered_by: "human", chief_note: "", triage_started_at: null },
      { id: "q2", status: "pending", selected_option: "", answered_by: "", chief_note: "", triage_started_at: null },
    ]);
    db.run(`INSERT INTO agent_questions (id, from_agent_id, question, status, created_at) VALUES ('q3','a1','t?','triage','2026-01-03T00:00:00Z')`);
    expect(() => db.run(`INSERT INTO agent_questions (id, from_agent_id, question, status, created_at) VALUES ('q4','a1','x','bogus','2026-01-03T00:00:00Z')`)).toThrow();
    db.close();
  });
});
