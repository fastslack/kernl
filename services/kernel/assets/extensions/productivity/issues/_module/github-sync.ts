import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { IssueClient } from "./client.js";
import { newId, isoNow } from "../../../../../src/core/helpers.js";
import { log } from "../../../../../src/core/logger.js";

interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  user: { login: string } | null;
  assignees: Array<{ login: string }>;
  labels: Array<{ name: string; color: string }>;
  milestone: { title: string } | null;
  pull_request?: { url: string };
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export async function syncGitHubIssues(
  client: IssueClient,
  db: SqliteDb,
  repos: string[],
): Promise<{ synced: number; errors: string[] }> {
  let synced = 0;
  const errors: string[] = [];

  const upsertIssue = db.prepare(`
    INSERT INTO issues (id, provider, external_id, external_number, repo, title, body,
      state, author, assignees, milestone, is_pull_request, url,
      time_estimate, time_spent, created_at, updated_at, closed_at, synced_at, raw_json)
    VALUES (?, 'github', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, external_id) DO UPDATE SET
      title=excluded.title, body=excluded.body, state=excluded.state,
      author=excluded.author, assignees=excluded.assignees,
      milestone=excluded.milestone, is_pull_request=excluded.is_pull_request,
      url=excluded.url, updated_at=excluded.updated_at,
      closed_at=excluded.closed_at, synced_at=excluded.synced_at,
      raw_json=excluded.raw_json
  `);

  const deleteLabels = db.prepare(`DELETE FROM issue_labels WHERE issue_id = ?`);
  const insertLabel = db.prepare(
    `INSERT INTO issue_labels (issue_id, label, color) VALUES (?, ?, ?)`,
  );

  const findLocalId = db.prepare(
    `SELECT id FROM issues WHERE provider = 'github' AND external_id = ?`,
  );

  const upsertMeta = db.prepare(`
    INSERT INTO issue_sync_meta (provider, repo, last_sync_at, items_synced)
    VALUES ('github', ?, ?, ?)
    ON CONFLICT(provider, repo) DO UPDATE SET
      last_sync_at=excluded.last_sync_at, items_synced=excluded.items_synced
  `);

  for (const repo of repos) {
    try {
      // Get last sync time
      const meta = db
        .prepare(`SELECT last_sync_at FROM issue_sync_meta WHERE provider = 'github' AND repo = ?`)
        .get(repo) as { last_sync_at: string } | undefined;

      const params: Record<string, string> = { state: "all", per_page: "100" };
      if (meta?.last_sync_at) {
        params.since = meta.last_sync_at;
      }

      const items = await client.getPaginated<GitHubIssue>(
        `/repos/${repo}/issues`,
        params,
      );

      const now = isoNow();
      let repoSynced = 0;

      const tx = db.transaction(() => {
        for (const item of items) {
          const externalId = String(item.id);
          const existing = findLocalId.get(externalId) as { id: string } | undefined;
          const localId = existing?.id ?? newId();

          const state = item.state === "closed" ? "closed" : "open";
          const assignees = JSON.stringify(
            (item.assignees ?? []).map((a) => a.login),
          );

          upsertIssue.run(
            localId,
            externalId,
            item.number,
            repo,
            item.title,
            item.body ?? "",
            state,
            item.user?.login ?? "",
            assignees,
            item.milestone?.title ?? "",
            item.pull_request ? 1 : 0,
            item.html_url ?? "",
            item.created_at,
            item.updated_at,
            item.closed_at ?? null,
            now,
            JSON.stringify(item),
          );

          // Sync labels
          deleteLabels.run(localId);
          for (const label of item.labels ?? []) {
            insertLabel.run(localId, label.name, label.color ?? "");
          }

          repoSynced++;
        }

        upsertMeta.run(repo, now, repoSynced);
      });

      tx();
      synced += repoSynced;
      log.info(`GitHub sync ${repo}: ${repoSynced} issues`);
    } catch (err) {
      const msg = `GitHub sync ${repo}: ${err instanceof Error ? err.message : String(err)}`;
      log.error(msg);
      errors.push(msg);
    }
  }

  return { synced, errors };
}
