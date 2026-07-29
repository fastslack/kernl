import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { newId, isoNow } from "../../../../../src/core/helpers.js";

export interface Issue {
  id: string;
  provider: string;
  external_id: string;
  external_number: number;
  repo: string;
  title: string;
  body: string;
  state: string;
  author: string;
  assignees: string;
  milestone: string;
  is_pull_request: number;
  url: string;
  time_estimate: number;
  time_spent: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  synced_at: string;
}

export interface TimeEntry {
  id: string;
  issue_id: string;
  duration: number;
  description: string;
  logged_at: string;
  created_at: string;
}

export interface TokenRow {
  provider: string;
  token: string;
  base_url: string;
  username: string;
  updated_at: string;
}

export interface IssueLabel {
  issue_id: string;
  label: string;
  color: string;
}

export class IssueService {
  constructor(private db: SqliteDb) {}

  // ── Token management ───────────────────────────────────

  setToken(
    provider: string,
    token: string,
    baseUrl?: string,
    username?: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO issue_tokens (provider, token, base_url, username, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET
           token=excluded.token, base_url=excluded.base_url,
           username=excluded.username, updated_at=excluded.updated_at`,
      )
      .run(provider, token, baseUrl ?? "", username ?? "", isoNow());
  }

  getToken(provider: string): TokenRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM issue_tokens WHERE provider = ?`)
        .get(provider) as TokenRow | undefined) ?? null
    );
  }

  getConfiguredProviders(): string[] {
    return (
      this.db.prepare(`SELECT provider FROM issue_tokens`).all() as Array<{
        provider: string;
      }>
    ).map((r) => r.provider);
  }

  // ── CRUD ───────────────────────────────────────────────

  getIssue(id: string): (Issue & { labels: IssueLabel[]; timeEntries: TimeEntry[] }) | null {
    const issue = this.db
      .prepare(`SELECT * FROM issues WHERE id = ?`)
      .get(id) as Issue | undefined;
    if (!issue) return null;

    const labels = this.db
      .prepare(`SELECT * FROM issue_labels WHERE issue_id = ?`)
      .all(id) as IssueLabel[];

    const timeEntries = this.db
      .prepare(`SELECT * FROM issue_time_entries WHERE issue_id = ? ORDER BY logged_at DESC`)
      .all(id) as TimeEntry[];

    return { ...issue, labels, timeEntries };
  }

  listIssues(filters: {
    repo?: string;
    state?: string;
    provider?: string;
    label?: string;
    assignee?: string;
    is_pr?: boolean;
    limit?: number;
  }): Issue[] {
    const where: string[] = [];
    const params: unknown[] = [];

    if (filters.repo) {
      where.push("i.repo = ?");
      params.push(filters.repo);
    }
    if (filters.state) {
      where.push("i.state = ?");
      params.push(filters.state);
    }
    if (filters.provider) {
      where.push("i.provider = ?");
      params.push(filters.provider);
    }
    if (filters.label) {
      where.push("EXISTS (SELECT 1 FROM issue_labels il WHERE il.issue_id = i.id AND il.label = ?)");
      params.push(filters.label);
    }
    if (filters.assignee) {
      where.push("i.assignees LIKE ?");
      params.push(`%${filters.assignee}%`);
    }
    if (filters.is_pr !== undefined) {
      where.push("i.is_pull_request = ?");
      params.push(filters.is_pr ? 1 : 0);
    }

    const limit = filters.limit ?? 50;
    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    return this.db
      .prepare(
        `SELECT i.* FROM issues i ${whereClause}
         ORDER BY i.updated_at DESC LIMIT ?`,
      )
      .all(...params, limit) as Issue[];
  }

  // ── Stats ──────────────────────────────────────────────

  getStats(): {
    total: number;
    open: number;
    closed: number;
    merged: number;
    prs: number;
    byRepo: Array<{ repo: string; open: number; closed: number; merged: number }>;
    byProvider: Array<{ provider: string; count: number }>;
    byLabel: Array<{ label: string; count: number }>;
    byAssignee: Array<{ assignee: string; count: number }>;
  } {
    const totals = this.db
      .prepare(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN state = 'open' THEN 1 ELSE 0 END) as open,
           SUM(CASE WHEN state = 'closed' THEN 1 ELSE 0 END) as closed,
           SUM(CASE WHEN state = 'merged' THEN 1 ELSE 0 END) as merged,
           SUM(CASE WHEN is_pull_request = 1 THEN 1 ELSE 0 END) as prs
         FROM issues`,
      )
      .get() as { total: number; open: number; closed: number; merged: number; prs: number };

    const byRepo = this.db
      .prepare(
        `SELECT repo,
           SUM(CASE WHEN state = 'open' THEN 1 ELSE 0 END) as open,
           SUM(CASE WHEN state = 'closed' THEN 1 ELSE 0 END) as closed,
           SUM(CASE WHEN state = 'merged' THEN 1 ELSE 0 END) as merged
         FROM issues GROUP BY repo ORDER BY open DESC`,
      )
      .all() as Array<{ repo: string; open: number; closed: number; merged: number }>;

    const byProvider = this.db
      .prepare(
        `SELECT provider, COUNT(*) as count FROM issues GROUP BY provider`,
      )
      .all() as Array<{ provider: string; count: number }>;

    const byLabel = this.db
      .prepare(
        `SELECT label, COUNT(*) as count FROM issue_labels
         GROUP BY label ORDER BY count DESC LIMIT 20`,
      )
      .all() as Array<{ label: string; count: number }>;

    const byAssignee = this.db
      .prepare(
        `SELECT author as assignee, COUNT(*) as count FROM issues
         WHERE state = 'open' AND author <> ''
         GROUP BY author ORDER BY count DESC LIMIT 20`,
      )
      .all() as Array<{ assignee: string; count: number }>;

    return {
      total: totals.total ?? 0,
      open: totals.open ?? 0,
      closed: totals.closed ?? 0,
      merged: totals.merged ?? 0,
      prs: totals.prs ?? 0,
      byRepo,
      byProvider,
      byLabel,
      byAssignee,
    };
  }

  // ── Time tracking ──────────────────────────────────────

  logTime(issueId: string, duration: number, description: string): TimeEntry {
    const now = isoNow();
    const entry: TimeEntry = {
      id: newId(),
      issue_id: issueId,
      duration,
      description,
      logged_at: now,
      created_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO issue_time_entries (id, issue_id, duration, description, logged_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(entry.id, entry.issue_id, entry.duration, entry.description, entry.logged_at, entry.created_at);

    // Update accumulated time_spent on the issue
    this.db
      .prepare(`UPDATE issues SET time_spent = time_spent + ? WHERE id = ?`)
      .run(duration, issueId);

    return entry;
  }

  getTimeEntries(issueId: string): TimeEntry[] {
    return this.db
      .prepare(`SELECT * FROM issue_time_entries WHERE issue_id = ? ORDER BY logged_at DESC`)
      .all(issueId) as TimeEntry[];
  }

  getTimeReport(repo?: string): {
    totalEstimate: number;
    totalSpent: number;
    byIssue: Array<{ id: string; title: string; repo: string; estimate: number; spent: number }>;
  } {
    const whereClause = repo ? "WHERE repo = ?" : "";
    const params = repo ? [repo] : [];

    const totals = this.db
      .prepare(
        `SELECT SUM(time_estimate) as totalEstimate, SUM(time_spent) as totalSpent
         FROM issues ${whereClause}`,
      )
      .get(...params) as { totalEstimate: number | null; totalSpent: number | null };

    const byIssue = this.db
      .prepare(
        `SELECT id, title, repo, time_estimate as estimate, time_spent as spent
         FROM issues
         ${whereClause ? whereClause + " AND" : "WHERE"} (time_estimate > 0 OR time_spent > 0)
         ORDER BY time_spent DESC LIMIT 30`,
      )
      .all(...params) as Array<{
        id: string; title: string; repo: string; estimate: number; spent: number;
      }>;

    return {
      totalEstimate: totals.totalEstimate ?? 0,
      totalSpent: totals.totalSpent ?? 0,
      byIssue,
    };
  }

  // ── Velocity ───────────────────────────────────────────

  getVelocity(days: number = 30): Array<{
    period: string;
    opened: number;
    closed: number;
    netChange: number;
  }> {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE dates(d) AS (
           SELECT date('now', '-' || ? || ' days')
           UNION ALL
           SELECT date(d, '+7 days') FROM dates WHERE d < date('now')
         )
         SELECT
           d as period,
           (SELECT COUNT(*) FROM issues
            WHERE date(created_at) >= d AND date(created_at) < date(d, '+7 days')
            AND is_pull_request = 0) as opened,
           (SELECT COUNT(*) FROM issues
            WHERE date(closed_at) >= d AND date(closed_at) < date(d, '+7 days')
            AND is_pull_request = 0) as closed
         FROM dates`,
      )
      .all(days) as Array<{ period: string; opened: number; closed: number }>;

    return rows.map((r) => ({
      ...r,
      netChange: r.opened - r.closed,
    }));
  }

  // ── Repos management ───────────────────────────────────

  getTrackedRepos(): Array<{ provider: string; repo: string; lastSync: string; itemsSynced: number }> {
    return this.db
      .prepare(
        `SELECT provider, repo, last_sync_at as lastSync, items_synced as itemsSynced
         FROM issue_sync_meta ORDER BY last_sync_at DESC`,
      )
      .all() as Array<{ provider: string; repo: string; lastSync: string; itemsSynced: number }>;
  }

  getRepoSummary(): Array<{
    repo: string;
    provider: string;
    open: number;
    closed: number;
    avgCloseTimeDays: number;
  }> {
    return this.db
      .prepare(
        `SELECT repo, provider,
           SUM(CASE WHEN state = 'open' THEN 1 ELSE 0 END) as open,
           SUM(CASE WHEN state IN ('closed','merged') THEN 1 ELSE 0 END) as closed,
           COALESCE(AVG(
             CASE WHEN closed_at IS NOT NULL
               THEN CAST(julianday(closed_at) - julianday(created_at) AS REAL)
             END
           ), 0) as avgCloseTimeDays
         FROM issues GROUP BY repo, provider ORDER BY open DESC`,
      )
      .all() as Array<{
        repo: string; provider: string; open: number; closed: number; avgCloseTimeDays: number;
      }>;
  }
}
