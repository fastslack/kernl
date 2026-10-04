import {
  ForgeRepoProvider,
  forgeRequest,
  snapshotHash,
  upsertMarked,
  type CommentRef,
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
}

export class GitLabRepoProvider extends ForgeRepoProvider<GitLabConnection> {
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
