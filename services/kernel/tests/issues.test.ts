import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { issuesMigrations } from "../assets/extensions/productivity/issues/_module/migrations.js";
import { IssueService } from "../assets/extensions/productivity/issues/_module/service.js";
import { newId, isoNow } from "../src/core/helpers.js";

describe("Issues module", () => {
  let db: Database;
  let service: IssueService;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db, "issues", issuesMigrations);
    service = new IssueService(db);
  });

  afterEach(() => {
    db.close();
  });

  // ── Migrations ──────────────────────────────

  it("creates all required tables", () => {
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table'
         AND name IN ('issue_tokens','issues','issue_labels','issue_time_entries','issue_sync_meta')
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toEqual([
      "issue_labels",
      "issue_sync_meta",
      "issue_time_entries",
      "issue_tokens",
      "issues",
    ]);
  });

  // ── Token management ────────────────────────

  it("sets and gets a token", () => {
    service.setToken("github", "ghp_test123");
    const token = service.getToken("github");
    expect(token).not.toBeNull();
    expect(token!.token).toBe("ghp_test123");
    expect(token!.base_url).toBe("");
  });

  it("sets token with base_url for GitLab self-hosted", () => {
    service.setToken("gitlab", "glpat_test456", "https://gitlab.mycompany.com", "user1");
    const token = service.getToken("gitlab");
    expect(token!.base_url).toBe("https://gitlab.mycompany.com");
    expect(token!.username).toBe("user1");
  });

  it("updates existing token on conflict", () => {
    service.setToken("github", "old_token");
    service.setToken("github", "new_token");
    const token = service.getToken("github");
    expect(token!.token).toBe("new_token");
  });

  it("returns null for unconfigured provider", () => {
    expect(service.getToken("github")).toBeNull();
  });

  it("lists configured providers", () => {
    service.setToken("github", "gh_token");
    service.setToken("gitlab", "gl_token");
    const providers = service.getConfiguredProviders();
    expect(providers).toHaveLength(2);
    expect(providers).toContain("github");
    expect(providers).toContain("gitlab");
  });

  // ── Issue CRUD ──────────────────────────────

  function insertIssue(overrides: Partial<{
    id: string; provider: string; external_id: string; external_number: number;
    repo: string; title: string; state: string; is_pull_request: number;
    author: string; closed_at: string | null; time_estimate: number; time_spent: number;
  }> = {}) {
    const id = overrides.id ?? newId();
    const now = isoNow();
    db.prepare(`
      INSERT INTO issues (id, provider, external_id, external_number, repo, title, body,
        state, author, assignees, milestone, is_pull_request, url,
        time_estimate, time_spent, created_at, updated_at, closed_at, synced_at, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, '[]', '', ?, '', ?, ?, ?, ?, ?, ?, '')
    `).run(
      id,
      overrides.provider ?? "github",
      overrides.external_id ?? String(Math.floor(Math.random() * 100000)),
      overrides.external_number ?? 1,
      overrides.repo ?? "owner/repo",
      overrides.title ?? "Test issue",
      overrides.state ?? "open",
      overrides.author ?? "testuser",
      overrides.is_pull_request ?? 0,
      overrides.time_estimate ?? 0,
      overrides.time_spent ?? 0,
      now, now,
      overrides.closed_at ?? null,
      now,
    );
    return id;
  }

  it("gets an issue by id", () => {
    const id = insertIssue({ title: "Bug fix" });
    const issue = service.getIssue(id);
    expect(issue).not.toBeNull();
    expect(issue!.title).toBe("Bug fix");
    expect(issue!.labels).toEqual([]);
    expect(issue!.timeEntries).toEqual([]);
  });

  it("returns null for nonexistent issue", () => {
    expect(service.getIssue("nonexistent")).toBeNull();
  });

  it("lists issues with no filters", () => {
    insertIssue({ title: "Issue 1" });
    insertIssue({ title: "Issue 2" });
    const issues = service.listIssues({});
    expect(issues).toHaveLength(2);
  });

  it("filters issues by state", () => {
    insertIssue({ state: "open" });
    insertIssue({ state: "closed" });
    const open = service.listIssues({ state: "open" });
    expect(open).toHaveLength(1);
    expect(open[0].state).toBe("open");
  });

  it("filters issues by provider", () => {
    insertIssue({ provider: "github" });
    insertIssue({ provider: "gitlab" });
    const gh = service.listIssues({ provider: "github" });
    expect(gh).toHaveLength(1);
    expect(gh[0].provider).toBe("github");
  });

  it("filters issues by repo", () => {
    insertIssue({ repo: "owner/repo-a" });
    insertIssue({ repo: "owner/repo-b" });
    const results = service.listIssues({ repo: "owner/repo-a" });
    expect(results).toHaveLength(1);
  });

  it("filters issues by label", () => {
    const id1 = insertIssue({ title: "With label" });
    insertIssue({ title: "No label" });
    db.prepare(`INSERT INTO issue_labels (issue_id, label, color) VALUES (?, 'bug', '')`).run(id1);
    const results = service.listIssues({ label: "bug" });
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("With label");
  });

  it("respects limit", () => {
    for (let i = 0; i < 5; i++) insertIssue({});
    const results = service.listIssues({ limit: 3 });
    expect(results).toHaveLength(3);
  });

  // ── Upsert (ON CONFLICT) ───────────────────

  it("upserts issue on provider + external_id conflict", () => {
    const now = isoNow();
    db.prepare(`
      INSERT INTO issues (id, provider, external_id, external_number, repo, title, body,
        state, author, assignees, milestone, is_pull_request, url,
        time_estimate, time_spent, created_at, updated_at, closed_at, synced_at, raw_json)
      VALUES (?, 'github', '12345', 1, 'owner/repo', 'Original title', '', 'open', '', '[]', '', 0, '', 0, 0, ?, ?, NULL, ?, '')
    `).run(newId(), now, now, now);

    // Upsert with same provider + external_id
    db.prepare(`
      INSERT INTO issues (id, provider, external_id, external_number, repo, title, body,
        state, author, assignees, milestone, is_pull_request, url,
        time_estimate, time_spent, created_at, updated_at, closed_at, synced_at, raw_json)
      VALUES (?, 'github', '12345', 1, 'owner/repo', 'Updated title', '', 'closed', '', '[]', '', 0, '', 0, 0, ?, ?, ?, ?, '')
      ON CONFLICT(provider, external_id) DO UPDATE SET
        title=excluded.title, state=excluded.state, updated_at=excluded.updated_at,
        closed_at=excluded.closed_at, synced_at=excluded.synced_at
    `).run(newId(), now, now, now, now);

    const issues = service.listIssues({});
    expect(issues).toHaveLength(1);
    expect(issues[0].title).toBe("Updated title");
    expect(issues[0].state).toBe("closed");
  });

  // ── Stats ───────────────────────────────────

  it("returns correct stats by state", () => {
    insertIssue({ state: "open" });
    insertIssue({ state: "open" });
    insertIssue({ state: "closed" });
    insertIssue({ state: "merged", is_pull_request: 1 });

    const stats = service.getStats();
    expect(stats.total).toBe(4);
    expect(stats.open).toBe(2);
    expect(stats.closed).toBe(1);
    expect(stats.merged).toBe(1);
    expect(stats.prs).toBe(1);
  });

  it("returns stats by repo", () => {
    insertIssue({ repo: "owner/repo-a", state: "open" });
    insertIssue({ repo: "owner/repo-a", state: "closed" });
    insertIssue({ repo: "owner/repo-b", state: "open" });

    const stats = service.getStats();
    expect(stats.byRepo).toHaveLength(2);
  });

  it("returns stats by provider", () => {
    insertIssue({ provider: "github" });
    insertIssue({ provider: "gitlab" });

    const stats = service.getStats();
    expect(stats.byProvider).toHaveLength(2);
  });

  it("returns stats by label", () => {
    const id1 = insertIssue({});
    const id2 = insertIssue({});
    db.prepare(`INSERT INTO issue_labels (issue_id, label, color) VALUES (?, 'bug', '')`).run(id1);
    db.prepare(`INSERT INTO issue_labels (issue_id, label, color) VALUES (?, 'bug', '')`).run(id2);
    db.prepare(`INSERT INTO issue_labels (issue_id, label, color) VALUES (?, 'feature', '')`).run(id1);

    const stats = service.getStats();
    expect(stats.byLabel.find((l) => l.label === "bug")?.count).toBe(2);
    expect(stats.byLabel.find((l) => l.label === "feature")?.count).toBe(1);
  });

  // ── Time tracking ──────────────────────────

  it("logs time and accumulates on issue", () => {
    const id = insertIssue({});
    const entry = service.logTime(id, 3600, "Code review");
    expect(entry.duration).toBe(3600);
    expect(entry.description).toBe("Code review");

    const issue = service.getIssue(id);
    expect(issue!.time_spent).toBe(3600);
  });

  it("accumulates multiple time entries", () => {
    const id = insertIssue({});
    service.logTime(id, 1800, "First session");
    service.logTime(id, 1200, "Second session");

    const issue = service.getIssue(id);
    expect(issue!.time_spent).toBe(3000);
    expect(issue!.timeEntries).toHaveLength(2);
  });

  it("returns time entries for an issue", () => {
    const id = insertIssue({});
    service.logTime(id, 600, "Quick fix");
    const entries = service.getTimeEntries(id);
    expect(entries).toHaveLength(1);
    expect(entries[0].duration).toBe(600);
  });

  it("returns time report", () => {
    insertIssue({ time_estimate: 7200, time_spent: 3600, repo: "owner/repo" });
    insertIssue({ time_estimate: 3600, time_spent: 1800, repo: "owner/repo" });

    const report = service.getTimeReport("owner/repo");
    expect(report.totalEstimate).toBe(10800);
    expect(report.totalSpent).toBe(5400);
    expect(report.byIssue).toHaveLength(2);
  });

  // ── Velocity ────────────────────────────────

  it("returns velocity data", () => {
    const velocity = service.getVelocity(30);
    expect(Array.isArray(velocity)).toBe(true);
  });

  // ── Repos ───────────────────────────────────

  it("returns empty tracked repos when none synced", () => {
    expect(service.getTrackedRepos()).toHaveLength(0);
  });

  it("returns tracked repos after sync meta insert", () => {
    const now = isoNow();
    db.prepare(
      `INSERT INTO issue_sync_meta (provider, repo, last_sync_at, items_synced) VALUES ('github', 'owner/repo', ?, 10)`,
    ).run(now);

    const repos = service.getTrackedRepos();
    expect(repos).toHaveLength(1);
    expect(repos[0].repo).toBe("owner/repo");
    expect(repos[0].itemsSynced).toBe(10);
  });

  it("returns repo summary with avg close time", () => {
    const past = "2025-01-01T00:00:00.000Z";
    const closed = "2025-01-05T00:00:00.000Z";
    insertIssue({ repo: "owner/repo", state: "closed", closed_at: closed });

    // Override created_at for predictable avg
    db.prepare(`UPDATE issues SET created_at = ?`).run(past);

    const summary = service.getRepoSummary();
    expect(summary).toHaveLength(1);
    expect(summary[0].closed).toBe(1);
    expect(summary[0].avgCloseTimeDays).toBeGreaterThan(0);
  });

  // ── Labels with cascade ────────────────────

  it("deletes labels when issue is deleted", () => {
    const id = insertIssue({});
    db.prepare(`INSERT INTO issue_labels (issue_id, label, color) VALUES (?, 'bug', '')`).run(id);

    const before = db.prepare(`SELECT COUNT(*) as c FROM issue_labels`).get() as { c: number };
    expect(before.c).toBe(1);

    db.prepare(`DELETE FROM issues WHERE id = ?`).run(id);

    const after = db.prepare(`SELECT COUNT(*) as c FROM issue_labels`).get() as { c: number };
    expect(after.c).toBe(0);
  });

  // ── Empty state ────────────────────────────

  it("returns empty stats with no data", () => {
    const stats = service.getStats();
    expect(stats.total).toBe(0);
    expect(stats.open).toBe(0);
    expect(stats.byRepo).toHaveLength(0);
    expect(stats.byLabel).toHaveLength(0);
  });

  it("returns empty time report with no data", () => {
    const report = service.getTimeReport();
    expect(report.totalEstimate).toBe(0);
    expect(report.totalSpent).toBe(0);
    expect(report.byIssue).toHaveLength(0);
  });
});
