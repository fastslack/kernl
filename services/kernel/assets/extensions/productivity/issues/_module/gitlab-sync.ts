import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { IssueClient } from "./client.js";
import { newId, isoNow } from "../../../../../src/core/helpers.js";
import { log } from "../../../../../src/core/logger.js";

interface GitLabIssue {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  state: string;
  web_url: string;
  author: { username: string } | null;
  assignees: Array<{ username: string }>;
  labels: string[];
  milestone: { title: string } | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  time_stats?: {
    time_estimate: number;
    total_time_spent: number;
  };
}

interface GitLabMR {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  state: string;
  web_url: string;
  author: { username: string } | null;
  assignees: Array<{ username: string }>;
  labels: string[];
  milestone: { title: string } | null;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  closed_at: string | null;
  time_stats?: {
    time_estimate: number;
    total_time_spent: number;
  };
}

export async function syncGitLabIssues(
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
    VALUES (?, 'gitlab', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, external_id) DO UPDATE SET
      title=excluded.title, body=excluded.body, state=excluded.state,
      author=excluded.author, assignees=excluded.assignees,
      milestone=excluded.milestone, is_pull_request=excluded.is_pull_request,
      url=excluded.url, time_estimate=excluded.time_estimate,
      time_spent=excluded.time_spent, updated_at=excluded.updated_at,
      closed_at=excluded.closed_at, synced_at=excluded.synced_at,
      raw_json=excluded.raw_json
  `);

  const deleteLabels = db.prepare(`DELETE FROM issue_labels WHERE issue_id = ?`);
  const insertLabel = db.prepare(
    `INSERT INTO issue_labels (issue_id, label, color) VALUES (?, ?, ?)`,
  );

  const findLocalId = db.prepare(
    `SELECT id FROM issues WHERE provider = 'gitlab' AND external_id = ?`,
  );

  const upsertMeta = db.prepare(`
    INSERT INTO issue_sync_meta (provider, repo, last_sync_at, items_synced)
    VALUES ('gitlab', ?, ?, ?)
    ON CONFLICT(provider, repo) DO UPDATE SET
      last_sync_at=excluded.last_sync_at, items_synced=excluded.items_synced
  `);

  for (const repo of repos) {
    try {
      const encodedRepo = encodeURIComponent(repo);

      // Get last sync time
      const meta = db
        .prepare(`SELECT last_sync_at FROM issue_sync_meta WHERE provider = 'gitlab' AND repo = ?`)
        .get(repo) as { last_sync_at: string } | undefined;

      let repoSynced = 0;
      const now = isoNow();

      // Sync issues
      const issueParams: Record<string, string> = { state: "all", per_page: "100" };
      if (meta?.last_sync_at) {
        issueParams.updated_after = meta.last_sync_at;
      }

      const issues = await client.getPaginated<GitLabIssue>(
        `/projects/${encodedRepo}/issues`,
        issueParams,
      );

      // Sync merge requests
      const mrParams: Record<string, string> = { state: "all", per_page: "100" };
      if (meta?.last_sync_at) {
        mrParams.updated_after = meta.last_sync_at;
      }

      const mrs = await client.getPaginated<GitLabMR>(
        `/projects/${encodedRepo}/merge_requests`,
        mrParams,
      );

      const tx = db.transaction(() => {
        // Process issues
        for (const item of issues) {
          const externalId = String(item.id);
          const existing = findLocalId.get(externalId) as { id: string } | undefined;
          const localId = existing?.id ?? newId();

          const state = item.state === "closed" ? "closed" : "open";
          const assignees = JSON.stringify(
            (item.assignees ?? []).map((a) => a.username),
          );

          upsertIssue.run(
            localId,
            externalId,
            item.iid,
            repo,
            item.title,
            item.description ?? "",
            state,
            item.author?.username ?? "",
            assignees,
            item.milestone?.title ?? "",
            0, // is_pull_request
            item.web_url ?? "",
            item.time_stats?.time_estimate ?? 0,
            item.time_stats?.total_time_spent ?? 0,
            item.created_at,
            item.updated_at,
            item.closed_at ?? null,
            now,
            JSON.stringify(item),
          );

          // Sync labels
          deleteLabels.run(localId);
          for (const label of item.labels ?? []) {
            insertLabel.run(localId, label, "");
          }

          repoSynced++;
        }

        // Process merge requests
        for (const mr of mrs) {
          const externalId = `mr-${mr.id}`;
          const existing = findLocalId.get(externalId) as { id: string } | undefined;
          const localId = existing?.id ?? newId();

          const state = mr.state === "merged" ? "merged" : mr.state === "closed" ? "closed" : "open";
          const assignees = JSON.stringify(
            (mr.assignees ?? []).map((a) => a.username),
          );

          upsertIssue.run(
            localId,
            externalId,
            mr.iid,
            repo,
            mr.title,
            mr.description ?? "",
            state,
            mr.author?.username ?? "",
            assignees,
            mr.milestone?.title ?? "",
            1, // is_pull_request
            mr.web_url ?? "",
            mr.time_stats?.time_estimate ?? 0,
            mr.time_stats?.total_time_spent ?? 0,
            mr.created_at,
            mr.updated_at,
            mr.merged_at ?? mr.closed_at ?? null,
            now,
            JSON.stringify(mr),
          );

          deleteLabels.run(localId);
          for (const label of mr.labels ?? []) {
            insertLabel.run(localId, label, "");
          }

          repoSynced++;
        }

        upsertMeta.run(repo, now, repoSynced);
      });

      tx();
      synced += repoSynced;
      log.info(`GitLab sync ${repo}: ${repoSynced} items`);
    } catch (err) {
      const msg = `GitLab sync ${repo}: ${err instanceof Error ? err.message : String(err)}`;
      log.error(msg);
      errors.push(msg);
    }
  }

  return { synced, errors };
}
