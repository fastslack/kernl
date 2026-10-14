import { createSign } from "node:crypto";
import {
  ForgeRepoProvider,
  FORGE_USER_AGENT,
  forgeRequest,
  snapshotHash,
  upsertMarked,
  type ChangedFile,
  type CommentRef,
  type ForgeReader,
  type ItemDetail,
  type ItemNote,
  type ReadOptions,
  type RepoItem,
} from "../../_lib/forge/index.js";
import type { GitHubConnectionsService, GitHubConnection } from "./connections-service.js";

const GITHUB_API = "https://api.github.com";
const API_VERSION = "2022-11-28";
const TOKEN_REFRESH_MS = 50 * 60 * 1000;

interface GitHubIssueRaw {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  user: { login: string } | null;
  author_association: string;
  labels: Array<{ name: string } | string>;
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
  user?: { login: string } | null;
  created_at?: string;
}

interface PullRaw {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  user: { login: string } | null;
  labels: Array<{ name: string }>;
  created_at: string;
  updated_at: string;
  html_url: string;
  merged: boolean;
  draft?: boolean;
  head: { ref: string; sha: string };
  base: { ref: string };
}

interface PullFileRaw {
  filename: string;
  previous_filename?: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  patch?: string;
}

export class GitHubRepoProvider extends ForgeRepoProvider<GitHubConnection> implements ForgeReader {
  readonly name = "github";
  protected readonly label = "GitHub";

  private tokenCache = new Map<string, { token: string; expiresAt: number }>();

  constructor(connections: GitHubConnectionsService) {
    super(connections);
  }

  protected details(c: GitHubConnection): Record<string, string> {
    return { app_id: c.app_id, installation_id: c.installation_id };
  }

  protected async whoami(conn: GitHubConnection): Promise<string> {
    const data = await this.get<{ slug?: string; name?: string; id?: number }>(conn, `/app`);
    return `OK — app id=${data.id ?? "?"} (${data.slug ?? data.name ?? "unnamed"})`;
  }

  async fetchOpenItems(repo: string, connectionId: string, maxPages = 50): Promise<RepoItem[]> {
    const conn = this.requireConnection(connectionId);
    const out: RepoItem[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const items = await this.get<GitHubIssueRaw[]>(
        conn,
        `/repos/${repo}/issues?state=open&per_page=100&page=${page}&sort=created&direction=desc`,
      );
      if (items.length === 0) break;
      for (const it of items) out.push(toRepoItem(it));
      if (items.length < 100) break;
    }
    return out;
  }

  async fetchItem(repo: string, number: number, connectionId: string): Promise<RepoItem> {
    const conn = this.requireConnection(connectionId);
    return toRepoItem(await this.get<GitHubIssueRaw>(conn, `/repos/${repo}/issues/${number}`));
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
      pageSize: 100,
      listPage: (page) => this.get<CommentRaw[]>(conn, `/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`),
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

  async readIssue(project: string, number: number, connectionId: string, opts: ReadOptions): Promise<ItemDetail> {
    const conn = this.requireConnection(connectionId);
    const raw = await this.get<GitHubIssueRaw>(conn, `/repos/${project}/issues/${number}`);
    const labels = raw.labels.map((l) => (typeof l === "string" ? l : l.name));
    return {
      kind: raw.pull_request != null ? "merge_request" : "issue",
      number: raw.number, title: raw.title, state: raw.state, url: raw.html_url,
      author: raw.user?.login ?? "", labels, created_at: raw.created_at, updated_at: raw.updated_at,
      body: raw.body ?? "", notes_total: raw.comments,
      notes: await this.latestComments(conn, project, number, raw.comments, opts.notes ?? 15),
    };
  }

  async readChange(project: string, number: number, connectionId: string, opts: ReadOptions): Promise<ItemDetail> {
    const conn = this.requireConnection(connectionId);
    const pr = await this.get<PullRaw>(conn, `/repos/${project}/pulls/${number}`);
    const issue = await this.get<GitHubIssueRaw>(conn, `/repos/${project}/issues/${number}`);
    const rows = await this.get<PullFileRaw[]>(conn, `/repos/${project}/pulls/${number}/files?per_page=100`);
    const files: ChangedFile[] = rows.map((f) => ({
      path: f.filename,
      old_path: f.previous_filename,
      status: f.status === "removed" ? "deleted" : f.status === "added" ? "added" : f.status === "renamed" ? "renamed" : "modified",
      additions: f.additions,
      deletions: f.deletions,
      ...(opts.patch && f.patch ? { patch: f.patch } : {}),
    }));
    return {
      kind: "merge_request",
      number: pr.number, title: pr.title, state: pr.merged ? "merged" : pr.state, url: pr.html_url,
      author: pr.user?.login ?? "", labels: pr.labels.map((l) => l.name),
      created_at: pr.created_at, updated_at: pr.updated_at, body: pr.body ?? "",
      merged: pr.merged, draft: !!pr.draft,
      source_branch: pr.head.ref, target_branch: pr.base.ref, head_sha: pr.head.sha, files,
      notes_total: issue.comments,
      notes: await this.latestComments(conn, project, number, issue.comments, opts.notes ?? 15),
    };
  }

  /** The latest `n` comments, oldest first: GitHub lists them oldest first, so read the last page(s). */
  private async latestComments(conn: GitHubConnection, project: string, number: number, total: number, n: number): Promise<ItemNote[]> {
    if (n <= 0 || total <= 0) return [];
    const lastPage = Math.max(1, Math.ceil(total / 100));
    let rows = await this.get<CommentRaw[]>(conn, `/repos/${project}/issues/${number}/comments?per_page=100&page=${lastPage}`);
    if (rows.length < n && lastPage > 1) {
      rows = [...(await this.get<CommentRaw[]>(conn, `/repos/${project}/issues/${number}/comments?per_page=100&page=${lastPage - 1}`)), ...rows];
    }
    return rows.slice(-n).map((c) => ({ author: c.user?.login ?? "", created_at: c.created_at ?? "", body: c.body ?? "" }));
  }

  private request<T>(conn: GitHubConnection, method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
    return forgeRequest<T>({
      label: "GitHub",
      method,
      path,
      url: `${GITHUB_API}${path}`,
      headers: async () => ({
        Authorization: `Bearer ${await this.installationToken(conn)}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": API_VERSION,
      }),
      body,
      retryOn: [403, 429],
      resetHeader: "x-ratelimit-reset",
      // An expired installation token: drop it, and the one retry mints a new one.
      onUnauthorized: () => {
        this.tokenCache.delete(cacheKey(conn));
        return true;
      },
    });
  }

  private get<T>(conn: GitHubConnection, path: string): Promise<T> {
    return this.request<T>(conn, "GET", path);
  }

  // ── Auth ────────────────────────────────────────────────────────────

  private async installationToken(conn: GitHubConnection): Promise<string> {
    const key = cacheKey(conn);
    const now = Date.now();
    const cached = this.tokenCache.get(key);
    if (cached && cached.expiresAt > now) return cached.token;

    const jwt = signAppJwt(conn.app_id, conn.private_key_pem);
    const res = await fetch(
      `${GITHUB_API}/app/installations/${conn.installation_id}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": API_VERSION,
          "User-Agent": FORGE_USER_AGENT,
        },
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GitHub installation token ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = (await res.json()) as { token: string; expires_at: string };
    this.tokenCache.set(key, {
      token: data.token,
      expiresAt: Math.min(new Date(data.expires_at).getTime(), now + TOKEN_REFRESH_MS),
    });
    return data.token;
  }
}

function cacheKey(conn: GitHubConnection): string {
  return `${conn.id}:${conn.app_id}:${conn.installation_id}`;
}

function toRepoItem(raw: GitHubIssueRaw): RepoItem {
  const labels = raw.labels.map((l) => (typeof l === "string" ? l : l.name));
  return {
    number: raw.number,
    kind: raw.pull_request != null ? "pull_request" : "issue",
    title: raw.title,
    body: raw.body ?? "",
    state: raw.state,
    author: raw.user?.login ?? "",
    authorAssociation: raw.author_association ?? "NONE",
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

function signAppJwt(appId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: appId };
  const enc = (obj: unknown): string => base64url(JSON.stringify(obj));
  const signingInput = `${enc(header)}.${enc(payload)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${base64urlBuffer(signer.sign(privateKeyPem))}`;
}

function base64url(text: string): string {
  return base64urlBuffer(Buffer.from(text, "utf8"));
}

function base64urlBuffer(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
