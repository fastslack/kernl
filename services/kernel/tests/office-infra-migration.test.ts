import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { officeInfraMigrations } from "../src/modules/office-infra/migrations.js";

describe("office-infra migration", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, "office-infra", officeInfraMigrations);
  });

  it("creates the office_environments table", () => {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='office_environments'")
      .get();
    expect(row).toBeTruthy();
  });

  it("has the expected columns with defaults", () => {
    db.prepare(
      "INSERT INTO office_environments (flow_id, created_at, updated_at) VALUES (?, ?, ?)",
    ).run("flow-1", "2026-06-10T00:00:00Z", "2026-06-10T00:00:00Z");
    const row = db
      .prepare("SELECT * FROM office_environments WHERE flow_id = ?")
      .get("flow-1") as Record<string, unknown>;
    expect(row.image).toBe("oven/bun:1");
    expect(row.desired_state).toBe("stopped");
    expect(row.last_status).toBe("absent");
    expect(row.network).toBe("kernl_default");
    expect(row.ports_json).toBe("[]");
    expect(row.env_json).toBe("{}");
  });
});
