import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { KernlBugService } from "../src/modules/agents/kernl-bugs-service.js";

const KEY = "a".repeat(64);
let bugs: KernlBugService;
let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db, "agents", agentsMigrations);
  bugs = new KernlBugService(db, KEY);
});

describe("KernlBugService.report", () => {
  it("stores a redacted report", () => {
    const { bug, repeat } = bugs.report({
      title: "Results labelled with the wrong tool", area: "executor/claude-code",
      diagnosis: "token ghp_ABCDEFGHIJKLMNOPQRSTUVWX12 leaked", error: "x", source: "chief", run_id: "r1",
      context: { last: "mail maguirre@matware.nl" },
    });
    expect(repeat).toBe(false);
    expect(bug.status).toBe("new");
    expect(bug.occurrences).toBe(1);
    expect(bug.diagnosis).not.toContain("ghp_");
    expect(JSON.stringify(bug.context)).not.toContain("@matware");
  });

  it("folds the same failure into one report", () => {
    const a = bugs.report({ title: "t", area: "agents/api", error: "Run 1 failed after 15 turns", source: "chief", run_id: "r1" });
    const b = bugs.report({ title: "t", area: "agents/api", error: "Run 2 failed after 40 turns", source: "chief", run_id: "r2" });
    expect(b.repeat).toBe(true);
    expect(b.bug.id).toBe(a.bug.id);
    expect(b.bug.occurrences).toBe(2);
    expect(bugs.list()).toHaveLength(1);
  });

  it("merges the chief's diagnosis onto the operator's report of the same run", () => {
    const op = bugs.report({ title: "Scout: failed", error: "boom", source: "operator", run_id: "r9" });
    const chief = bugs.report({ title: "Stop never emits run_completed", area: "agents/operations",
      diagnosis: "agents.stop updates the row silently", error: "boom", source: "chief", run_id: "r9" });
    expect(chief.bug.id).toBe(op.bug.id);
    expect(chief.bug.title).toBe("Stop never emits run_completed");
    expect(chief.bug.area).toBe("agents/operations");
    expect(chief.bug.diagnosis).toContain("silently");
    expect(bugs.list()).toHaveLength(1);
  });
});

describe("KernlBugService status and settings", () => {
  it("updates and publishes", () => {
    const { bug } = bugs.report({ title: "t", error: "e", source: "operator" });
    expect(bugs.update(bug.id, { status: "dismissed" })?.status).toBe("dismissed");
    const pub = bugs.markPublished(bug.id, "https://github.com/fastslack/kernl/issues/7");
    expect(pub).toMatchObject({ status: "published", issue_url: "https://github.com/fastslack/kernl/issues/7" });
    expect(pub?.published_at).toBeTruthy();
    expect(bugs.list("published")).toHaveLength(1);
  });

  it("seals the token and never returns it", () => {
    expect(bugs.getSettings()).toEqual({ repo: "fastslack/kernl", token_set: false });
    expect(bugs.setSettings({ token: "ghp_secret123", repo: "me/fork" })).toEqual({ repo: "me/fork", token_set: true });
    const raw = db.query("SELECT value FROM kernl_bug_settings WHERE key = 'token'").get() as { value: string };
    expect(raw.value).not.toContain("ghp_secret123");
    expect(bugs.getToken()).toBe("ghp_secret123");
  });
});

describe("KernlBugService · review fixes", () => {
  it("folds the same error into one report whoever files it, whatever area they name", () => {
    const chief = bugs.report({ title: "Stop is silent", area: "agents/operations", error: "Stale run 12 cleaned up", source: "chief", run_id: "rA" });
    const op = bugs.report({ title: "Scout: Stale run", error: "Stale run 99 cleaned up", source: "operator", run_id: "rB" });
    expect(op.bug.id).toBe(chief.bug.id);
    expect(bugs.list()).toHaveLength(1);
  });
  it("remembers every run folded in, so a later diagnosis of that run merges", () => {
    const x = bugs.report({ title: "x", error: "boom 1", source: "operator", run_id: "r1" });
    bugs.report({ title: "x", error: "boom 2", source: "operator", run_id: "r2" });
    const chief = bugs.report({ title: "Real cause", area: "core", diagnosis: "d", error: "other text entirely", source: "chief", run_id: "r2" });
    expect(chief.bug.id).toBe(x.bug.id);
    expect(chief.bug.title).toBe("Real cause");
    expect(bugs.list()).toHaveLength(1);
  });
});
