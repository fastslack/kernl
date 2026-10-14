import {
  ForgeRepoProvider,
  forgeRequest,
  snapshotHash,
  upsertMarked,
  countDiff,
  type ChangedFile,
  type CommentRef,
  type ForgeReader,
  type ItemDetail,
  type ItemNote,
  type ReadOptions,
  type RepoItem,
} from "../../_lib/forge/index.js";
import type { GitLabConnectionsService, GitLabConnection } from "./connections-service.js";

interface GitLabIssueRaw {
  iid: number;
  title: string;
  description: string | null;
  state: "opened" | "closed";
  author?: { username: string } | null;
  labels: string[];
  created_at: string;
  updated_at: string;
  user_notes_count: number;
  web_url: string;
}

interface NoteRaw {
  id: number;
  body: string;
  system: boolean;
  author?: { username: string } | null;
  created_at?: string;
}

interface GitLabMrRaw extends GitLabIssueRaw {
  state: "opened" | "closed";
  merged_at?: string | null;
  source_branch: string;
  target_branch: string;
  sha: string;
  draft?: boolean;
  work_in_progress?: boolean;
}

interface DiffRaw {
  old_path: string;
  new_path: string;
  new_file: boolean;
  deleted_file: boolean;
  renamed_file: boolean;
  diff: string;
}

export class GitLabRepoProvider extends ForgeRepoProvider<GitLabConnection> implements ForgeReader {
  readonly name = "gitlab";
  protected readonly label = "GitLab";

  constructor(connections: GitLabConnectionsService) {
    super(connections);
  }

  protected details(c: GitLabConnection): Record<string, string> {
    return { host: c.host };
  }

  protected async whoami(conn: GitLabConnection): Promise<string> {
    const data = await this.get<{ id: number; username: string }>(conn, `/user`);
    return `OK — user id=${data.id} (${data.username})`;
  }

  async fetchOpenItems(repo: string, connectionId: string, maxPages = 50): Promise<RepoItem[]> {
    const conn = this.requireConnection(connectionId);
    const projectId = encodeURIComponent(repo);
    const out: RepoItem[] = [];
    for (const [endpoint, kind] of [["issues", "issue"], ["merge_requests", "pull_request"]] as const) {
      for (let page = 1; page <= maxPages; page++) {
        const items = await this.get<GitLabIssueRaw[]>(
          conn,
          `/projects/${projectId}/${endpoint}?state=opened&per_page=100&page=${page}&order_by=created_at&sort=desc`,
        );
        if (items.length === 0) break;
        for (const it of items) out.push(toRepoItem(it, kind));
        if (items.length < 100) break;
      }
    }
    return out;
  }

  async fetchItem(repo: string, number: number, connectionId: string): Promise<RepoItem> {
    const conn = this.requireConnection(connectionId);
    const projectId = encodeURIComponent(repo);
    try {
      const issue = await this.get<GitLabIssueRaw>(conn, `/projects/${projectId}/issues/${number}`);
      return toRepoItem(issue, "issue");
    } catch {
      const mr = await this.get<GitLabIssueRaw>(conn, `/projects/${projectId}/merge_requests/${number}`);
      return toRepoItem(mr, "pull_request");
    }
  }

  async upsertMarkedComment(
    repo: string,
    number: number,
    marker: string,
    body: string,
    connectionId: string,
  ): Promise<CommentRef> {
    const conn = this.requireConnection(connectionId);
    const fullBody = body.includes(marker) ? body : `${marker}\n${body}`;
    const item = await this.fetchItem(repo, number, connectionId);
    const base = `${this.itemPath(repo, number, item.kind)}/notes`;
    // GitLab notes carry no URL of their own; point at the item.
    const ref = (n: NoteRaw): CommentRef => ({ id: String(n.id), url: item.url });
    return upsertMarked({
      marker,
      pageSize: 100,
      listPage: (page) => this.get<NoteRaw[]>(conn, `${base}?per_page=100&page=${page}&sort=asc`),
      matches: (n) => !n.system,
      update: async (existing) => ref(await this.request<NoteRaw>(conn, "PUT", `${base}/${existing.id}`, { body: fullBody })),
      create: async () => ref(await this.request<NoteRaw>(conn, "POST", base, { body: fullBody })),
    });
  }

  async closeItem(repo: string, number: number, connectionId: string): Promise<void> {
    const conn = this.requireConnection(connectionId);
    const item = await this.fetchItem(repo, number, connectionId);
    await this.request<unknown>(conn, "PUT", this.itemPath(repo, number, item.kind), { state_event: "close" });
  }

  async readIssue(project: string, number: number, connectionId: string, opts: ReadOptions): Promise<ItemDetail> {
    const conn = this.requireConnection(connectionId);
    const base = `/projects/${encodeURIComponent(project)}/issues/${number}`;
    const raw = await this.get<GitLabIssueRaw>(conn, base);
    return { ...detailOf(raw, "issue"), notes: await this.latestNotes(conn, base, opts.notes ?? 15) };
  }

  async readChange(project: string, number: number, connectionId: string, opts: ReadOptions): Promise<ItemDetail> {
    const conn = this.requireConnection(connectionId);
    const base = `/projects/${encodeURIComponent(project)}/merge_requests/${number}`;
    const raw = await this.get<GitLabMrRaw>(conn, base);
    const diffs = await this.get<DiffRaw[]>(conn, `${base}/diffs?per_page=100`);
    const files: ChangedFile[] = diffs.map((d) => ({
      path: d.new_path,
      old_path: d.renamed_file ? d.old_path : undefined,
      status: d.new_file ? "added" : d.deleted_file ? "deleted" : d.renamed_file ? "renamed" : "modified",
      ...countDiff(d.diff ?? ""),
      ...(opts.patch && d.diff ? { patch: d.diff } : {}),
    }));
    return {
      ...detailOf(raw, "merge_request"),
      state: raw.merged_at ? "merged" : raw.state,
      merged: !!raw.merged_at,
      draft: !!(raw.draft ?? raw.work_in_progress),
      source_branch: raw.source_branch,
      target_branch: raw.target_branch,
      head_sha: raw.sha,
      files,
      notes: await this.latestNotes(conn, base, opts.notes ?? 15),
    };
  }

  /** The latest `n` human notes, oldest first. */
  private async latestNotes(conn: GitLabConnection, base: string, n: number): Promise<ItemNote[]> {
    if (n <= 0) return [];
    const rows = await this.get<NoteRaw[]>(conn, `${base}/notes?sort=desc&order_by=created_at&per_page=100`);
    return rows.filter((r) => !r.system).slice(0, n).reverse()
      .map((r) => ({ author: r.author?.username ?? "", created_at: r.created_at ?? "", body: r.body ?? "" }));
  }

  private itemPath(repo: string, number: number, kind: RepoItem["kind"]): string {
    return `/projects/${encodeURIComponent(repo)}/${kind === "issue" ? "issues" : "merge_requests"}/${number}`;
  }

  private request<T>(conn: GitLabConnection, method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
    return forgeRequest<T>({
      label: "GitLab",
      method,
      path,
      url: `${conn.host.replace(/\/+$/, "")}/api/v4${path}`,
      headers: { "PRIVATE-TOKEN": conn.token, Accept: "application/json" },
      body,
      retryOn: [429, 503],
      resetHeader: "ratelimit-reset",
    });
  }

  private get<T>(conn: GitLabConnection, path: string): Promise<T> {
    return this.request<T>(conn, "GET", path);
  }
}

function detailOf(raw: GitLabIssueRaw, kind: ItemDetail["kind"]): ItemDetail {
  return {
    kind,
    number: raw.iid,
    title: raw.title,
    state: raw.state,
    url: raw.web_url,
    author: raw.author?.username ?? "",
    labels: raw.labels ?? [],
    created_at: raw.created_at,
    updated_at: raw.updated_at,
    body: raw.description ?? "",
    notes: [],
    notes_total: raw.user_notes_count ?? 0,
  };
}

function toRepoItem(raw: GitLabIssueRaw, kind: "issue" | "pull_request"): RepoItem {
  return {
    number: raw.iid,
    kind,
    title: raw.title,
    body: raw.description ?? "",
    state: raw.state === "opened" ? "open" : "closed",
    author: raw.author?.username ?? "",
    authorAssociation: "NONE",
    labels: raw.labels ?? [],
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    commentCount: raw.user_notes_count,
    snapshotHash: snapshotHash({
      kind,
      title: raw.title,
      state: raw.state,
      labels: [...(raw.labels ?? [])].sort().join(","),
      notes: raw.user_notes_count,
      updated_at: raw.updated_at,
    }),
    url: raw.web_url,
  };
}
