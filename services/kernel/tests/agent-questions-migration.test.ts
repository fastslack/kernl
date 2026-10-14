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

describe("v57 — owed status and operator messages", () => {
  it("accepts 'owed', keeps existing rows and adds operator_messages", () => {
    const db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations.filter((m) => m.version < 57));
    db.run(`INSERT INTO agent_questions (id, from_agent_id, question, options, status, created_at, opinion_status)
            VALUES ('q1','a1','Ship?','[]','pending','2026-10-14T00:00:00Z','')`);
    runMigrations(db, "agents", agentsMigrations);
    db.run("UPDATE agent_questions SET status='owed', owed_at='2026-10-14T01:00:00Z' WHERE id='q1'");
    const row = db.query("SELECT status, owed_at, reminded_at, for_operator, opinion_status FROM agent_questions WHERE id='q1'").get() as Record<string, unknown>;
    expect(row).toEqual({ status: "owed", owed_at: "2026-10-14T01:00:00Z", reminded_at: null, for_operator: 0, opinion_status: "" });
    expect(() => db.run("UPDATE agent_questions SET status='bogus' WHERE id='q1'")).toThrow();
    db.run(`INSERT INTO operator_messages (id, question_id, channel, target, message_id, code, status, created_at)
            VALUES ('m1','q1','telegram','123','55',7,'sent','2026-10-14T01:00:00Z')`);
    expect((db.query("SELECT code FROM operator_messages").get() as { code: number }).code).toBe(7);
    db.close();
  });
});
