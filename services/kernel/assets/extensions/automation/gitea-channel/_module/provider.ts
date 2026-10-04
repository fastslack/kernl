import {
  ForgeRepoProvider,
  forgeRequest,
  snapshotHash,
  upsertMarked,
  type CommentRef,
  type RepoItem,
} from "../../_lib/forge/index.js";
import type { GiteaConnectionsService, GiteaConnection } from "./connections-service.js";

interface GiteaIssueRaw {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  user: { login: string } | null;
  labels: Array<{ name: string }>;
  created_at: string;
  updated_at: string;
  comments: number;
  html_url: string;
  pull_request?: { url: string } | null;
}

interface CommentRaw {
  id: number;
  body: string;
  html_url: string;
}

export class GiteaRepoProvider extends ForgeRepoProvider<GiteaConnection> {
  readonly name = "gitea";
  protected readonly label = "Gitea";

  constructor(connections: GiteaConnectionsService) {
    super(connections);
  }

  protected details(c: GiteaConnection): Record<string, string> {
    return { host: c.host };
  }

  protected async whoami(conn: GiteaConnection): Promise<string> {
    const data = await this.get<{ id: number; login: string }>(conn, `/user`);
    return `OK — user id=${data.id} (${data.login}) at ${conn.host}`;
  }

  async fetchOpenItems(repo: string, connectionId: string, maxPages = 50): Promise<RepoItem[]> {
    const conn = this.requireConnection(connectionId);
    const out: RepoItem[] = [];
    // Gitea returns issues and PRs from the same endpoint when type=issues|pulls.
    // Type 'all' would conflate them; we query each separately for clarity.
    for (const type of ["issues", "pulls"] as const) {
      for (let page = 1; page <= maxPages; page++) {
        const items = await this.get<GiteaIssueRaw[]>(
          conn,
          `/repos/${repo}/issues?state=open&type=${type}&page=${page}&limit=50&sort=newest`,
        );
        if (items.length === 0) break;
        for (const it of items) {
          out.push(toRepoItem(it, type === "pulls" ? "pull_request" : "issue"));
        }
        if (items.length < 50) break;
      }
    }
    return out;
  }

  async fetchItem(repo: string, number: number, connectionId: string): Promise<RepoItem> {
    const conn = this.requireConnection(connectionId);
    const it = await this.get<GiteaIssueRaw>(conn, `/repos/${repo}/issues/${number}`);
    return toRepoItem(it, it.pull_request != null ? "pull_request" : "issue");
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
    const ref = (c: CommentRaw): CommentRef => ({ id: String(c.id), url: c.html_url });
    return upsertMarked({
      marker,
      pageSize: 50,
      listPage: (page) => this.get<CommentRaw[]>(conn, `/repos/${repo}/issues/${number}/comments?page=${page}&limit=50`),
      update: async (existing) =>
        ref(await this.request<CommentRaw>(conn, "PATCH", `/repos/${repo}/issues/comments/${existing.id}`, { body: fullBody })),
      create: async () =>
        ref(await this.request<CommentRaw>(conn, "POST", `/repos/${repo}/issues/${number}/comments`, { body: fullBody })),
    });
  }

  async closeItem(repo: string, number: number, connectionId: string): Promise<void> {
    const conn = this.requireConnection(connectionId);
    await this.request<unknown>(conn, "PATCH", `/repos/${repo}/issues/${number}`, { state: "closed" });
  }

  private request<T>(conn: GiteaConnection, method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
    return forgeRequest<T>({
      label: "Gitea",
      method,
      path,
      url: `${conn.host}/api/v1${path}`,
      headers: { Authorization: `token ${conn.token}`, Accept: "application/json" },
      body,
      retryOn: [429, 503],
    });
  }

  private get<T>(conn: GiteaConnection, path: string): Promise<T> {
    return this.request<T>(conn, "GET", path);
  }
}

function toRepoItem(raw: GiteaIssueRaw, kind: "issue" | "pull_request"): RepoItem {
  const labels = (raw.labels ?? []).map((l) => l.name);
  return {
    number: raw.number,
    kind,
    title: raw.title,
    body: raw.body ?? "",
    state: raw.state,
    author: raw.user?.login ?? "",
    // Gitea exposes no author_association. Default to NONE so triage's
    // maintainer guard treats every Gitea author as third-party (safe).
    authorAssociation: "NONE",
    labels,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    commentCount: raw.comments,
    snapshotHash: snapshotHash({
      title: raw.title,
      state: raw.state,
      labels: [...labels].sort().join(","),
      comments: raw.comments,
      updated_at: raw.updated_at,
    }),
    url: raw.html_url,
  };
}
