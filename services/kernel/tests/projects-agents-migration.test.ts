import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";

function cols(db: Database, table: string): Array<{ name: string; notnull: number; dflt_value: unknown }> {
  return db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number; dflt_value: unknown }>;
}

describe("agents migration v51 — project scoping", () => {
  it("adds a nullable project_id to every scoped table", () => {
    const db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    for (const t of ["agent_runs", "agent_memory", "agent_learnings", "agent_office_inbox", "agent_schedules"]) {
      const c = cols(db, t).find((x) => x.name === "project_id");
      expect(c, `${t}.project_id`).toBeDefined();
      expect(c!.notnull).toBe(0);
    }
    const pp = cols(db, "agent_schedules").find((x) => x.name === "per_project");
    expect(pp?.notnull).toBe(1);
    db.close();
  });
});
