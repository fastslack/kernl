import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { timeTrackingMigrations } from "../assets/extensions/productivity/time-tracking/_module/migrations/001_time_tracking.js";
import { TimeTrackingService } from "../assets/extensions/productivity/time-tracking/_module/service.js";
// graph driver mocked as null in tests

describe("TimeTrackingService", () => {
  let db: Database;
  let service: TimeTrackingService;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db, "time-tracking", timeTrackingMigrations);
    service = new TimeTrackingService(db, () => null);
  });
  afterEach(() => db.close());

  it("starts a timer", () => {
    const entry = service.start({ description: "Working on feature" });
    expect(entry.id).toBeTruthy();
    expect(entry.end_time).toBeNull();
    expect(entry.duration_minutes).toBeNull();
  });

  it("stops a running timer", () => {
    const entry = service.start({ description: "Coding" });
    const stopped = service.stop(entry.id);
    expect(stopped?.end_time).toBeTruthy();
    expect(stopped?.duration_minutes).toBeTypeOf("number");
  });

  it("auto-stops previous timer on new start", () => {
    const first = service.start({ description: "First" });
    service.start({ description: "Second" });
    const updated = db.prepare("SELECT * FROM time_entries WHERE id = ?").get(first.id) as any;
    expect(updated.end_time).toBeTruthy();
  });

  it("logs manual entry with computed duration", () => {
    const entry = service.log({
      description: "Meeting",
      start_time: "2026-02-26T10:00:00Z",
      end_time: "2026-02-26T11:30:00Z",
    });
    expect(entry.duration_minutes).toBe(90);
  });

  it("generates a report", () => {
    service.log({ description: "Task A", start_time: "2026-02-26T10:00:00Z", end_time: "2026-02-26T11:00:00Z", tags: "dev" });
    service.log({ description: "Task B", start_time: "2026-02-26T14:00:00Z", end_time: "2026-02-26T15:30:00Z", tags: "meeting" });
    const report = service.report();
    expect(report.total_minutes).toBe(150);
    expect(report.entries_count).toBe(2);
    expect(report.by_tag).toHaveLength(2);
  });

  it("filters by date range", () => {
    service.log({ start_time: "2026-02-25T10:00:00Z", end_time: "2026-02-25T11:00:00Z" });
    service.log({ start_time: "2026-02-26T10:00:00Z", end_time: "2026-02-26T11:00:00Z" });
    const filtered = service.list({ from_date: "2026-02-26" });
    expect(filtered).toHaveLength(1);
  });
});
