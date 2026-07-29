import { createHash } from "node:crypto";
import type { GiteaConnectionsService, GiteaConnection } from "./connections-service.js";

const USER_AGENT = "Kernl-triage/0.1";

interface RepoItem {
  number: number;
  kind: "issue" | "pull_request";
  title: string;
  body: string;
  state: "open" | "closed";
  author: string;
  authorAssociation: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  commentCount: number;
  snapshotHash: string;
  url: string;
}

interface CommentRef {
  id: string;
  url: string;
}

interface ConnectionSummary {
  id: string;
  name: string;
  details: Record<string, string>;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
}

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

export class GiteaRepoProvider {
  readonly name = "gitea";

  constructor(private connections: GiteaConnectionsService) {}

  // ── RepoProvider surface ────────────────────────────────────────────

  listConnections(): ConnectionSummary[] {
    return this.connections.list().map((c) => ({
      id: c.id,
      name: c.name,
      details: { host: c.host },
      lastTestAt: c.last_test_at,
      lastTestOk: c.last_test_ok == null ? null : c.last_test_ok === 1,
    }));
  }

  assertConnection(connectionId: string): void {
    if (!this.connections.get(connectionId)) {
      throw new Error(`Gitea connection not found: ${connectionId}`);
    }
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
    const kind = it.pull_request != null ? "pull_request" : "issue";
    return toRepoItem(it, kind);
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

    for (let page = 1; page <= 20; page++) {
      const comments = await this.get<CommentRaw[]>(
        conn,
        `/repos/${repo}/issues/${number}/comments?page=${page}&limit=50`,
      );
      if (comments.length === 0) break;
      const existing = comments.find((c) => c.body.includes(marker));
      if (existing) {
        const updated = await this.patch<CommentRaw>(
          conn,
          `/repos/${repo}/issues/comments/${existing.id}`,
          { body: fullBody },
        );
        return { id: String(updated.id), url: updated.html_url };
      }
      if (comments.length < 50) break;
    }

    const created = await this.post<CommentRaw>(
      conn,
      `/repos/${repo}/issues/${number}/comments`,
      { body: fullBody },
    );
    return { id: String(created.id), url: created.html_url };
  }

  async closeItem(repo: string, number: number, connectionId: string): Promise<void> {
    const conn = this.requireConnection(connectionId);
    await this.patch<unknown>(conn, `/repos/${repo}/issues/${number}`, { state: "closed" });
  }

  async testConnection(connectionId: string): Promise<{ ok: boolean; detail: string }> {
    const conn = this.connections.get(connectionId);
    if (!conn) return { ok: false, detail: "connection not found" };
    try {
      const data = await this.get<{ id: number; login: string }>(conn, `/user`);
      const detail = `OK — user id=${data.id} (${data.login}) at ${conn.host}`;
      this.connections.recordTest(connectionId, true, "");
      return { ok: true, detail };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.connections.recordTest(connectionId, false, msg);
      return { ok: false, detail: msg };
    }
  }

  // ── HTTP layer ──────────────────────────────────────────────────────

  private requireConnection(id: string): GiteaConnection {
    const conn = this.connections.get(id);
    if (!conn) throw new Error(`Gitea connection not found: ${id}`);
    return conn;
  }

  private async request<T>(
    conn: GiteaConnection,
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
    attempt = 1,
  ): Promise<T> {
    const url = `${conn.host}/api/v1${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `token ${conn.token}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.ok) {
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    }
    if ((res.status === 429 || res.status === 503) && attempt <= 3) {
      const waitMs = retryAfterMs(res);
      if (waitMs > 0 && waitMs <= 60_000) {
        await sleep(waitMs);
        return this.request<T>(conn, method, path, body, attempt + 1);
      }
    }
    const text = await res.text().catch(() => "");
    throw new Error(`Gitea ${method} ${path} ${res.status}: ${text.slice(0, 300)}`);
  }

  private get<T>(conn: GiteaConnection, path: string): Promise<T> {
    return this.request<T>(conn, "GET", path);
  }
  private post<T>(conn: GiteaConnection, path: string, body: unknown): Promise<T> {
    return this.request<T>(conn, "POST", path, body);
  }
  private patch<T>(conn: GiteaConnection, path: string, body: unknown): Promise<T> {
    return this.request<T>(conn, "PATCH", path, body);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

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
    snapshotHash: snapshotHash(raw, labels),
    url: raw.html_url,
  };
}

function snapshotHash(raw: GiteaIssueRaw, labels: string[]): string {
  const payload = JSON.stringify({
    title: raw.title,
    state: raw.state,
    labels: [...labels].sort().join(","),
    comments: raw.comments,
    updated_at: raw.updated_at,
  });
  return createHash("sha256").update(payload).digest("hex");
}

function retryAfterMs(res: Response): number {
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) {
    const n = Number(retryAfter);
    if (Number.isFinite(n)) return n * 1000;
  }
  return 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
