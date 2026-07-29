import { createHash } from "node:crypto";
import type { GitLabConnectionsService, GitLabConnection } from "./connections-service.js";

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

export class GitLabRepoProvider {
  readonly name = "gitlab";

  constructor(private connections: GitLabConnectionsService) {}

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
      throw new Error(`GitLab connection not found: ${connectionId}`);
    }
  }

  async fetchOpenItems(repo: string, connectionId: string, maxPages = 50): Promise<RepoItem[]> {
    const conn = this.requireConnection(connectionId);
    const projectId = encodeURIComponent(repo);
    const out: RepoItem[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const issues = await this.get<GitLabIssueRaw[]>(
        conn,
        `/projects/${projectId}/issues?state=opened&per_page=100&page=${page}&order_by=created_at&sort=desc`,
      );
      if (issues.length === 0) break;
      for (const it of issues) out.push(toRepoItem(it, "issue"));
      if (issues.length < 100) break;
    }
    for (let page = 1; page <= maxPages; page++) {
      const mrs = await this.get<GitLabIssueRaw[]>(
        conn,
        `/projects/${projectId}/merge_requests?state=opened&per_page=100&page=${page}&order_by=created_at&sort=desc`,
      );
      if (mrs.length === 0) break;
      for (const mr of mrs) out.push(toRepoItem(mr, "pull_request"));
      if (mrs.length < 100) break;
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
      const mr = await this.get<GitLabIssueRaw>(
        conn,
        `/projects/${projectId}/merge_requests/${number}`,
      );
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
    const projectId = encodeURIComponent(repo);
    const fullBody = body.includes(marker) ? body : `${marker}\n${body}`;
    const item = await this.fetchItem(repo, number, connectionId);
    const base =
      item.kind === "issue"
        ? `/projects/${projectId}/issues/${number}/notes`
        : `/projects/${projectId}/merge_requests/${number}/notes`;

    for (let page = 1; page <= 20; page++) {
      const notes = await this.get<NoteRaw[]>(conn, `${base}?per_page=100&page=${page}&sort=asc`);
      if (notes.length === 0) break;
      const existing = notes.find((n) => !n.system && n.body.includes(marker));
      if (existing) {
        const updated = await this.put<NoteRaw>(conn, `${base}/${existing.id}`, { body: fullBody });
        return { id: String(updated.id), url: item.url };
      }
      if (notes.length < 100) break;
    }
    const created = await this.post<NoteRaw>(conn, base, { body: fullBody });
    return { id: String(created.id), url: item.url };
  }

  async closeItem(repo: string, number: number, connectionId: string): Promise<void> {
    const conn = this.requireConnection(connectionId);
    const projectId = encodeURIComponent(repo);
    const item = await this.fetchItem(repo, number, connectionId);
    const path =
      item.kind === "issue"
        ? `/projects/${projectId}/issues/${number}`
        : `/projects/${projectId}/merge_requests/${number}`;
    await this.put<unknown>(conn, path, { state_event: "close" });
  }

  async testConnection(connectionId: string): Promise<{ ok: boolean; detail: string }> {
    const conn = this.connections.get(connectionId);
    if (!conn) return { ok: false, detail: "connection not found" };
    try {
      const data = await this.get<{ id: number; username: string }>(conn, `/user`);
      const detail = `OK — user id=${data.id} (${data.username})`;
      this.connections.recordTest(connectionId, true, "");
      return { ok: true, detail };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.connections.recordTest(connectionId, false, msg);
      return { ok: false, detail: msg };
    }
  }

  // ── HTTP layer ──────────────────────────────────────────────────────

  private requireConnection(id: string): GitLabConnection {
    const conn = this.connections.get(id);
    if (!conn) throw new Error(`GitLab connection not found: ${id}`);
    return conn;
  }

  private async request<T>(
    conn: GitLabConnection,
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
    attempt = 1,
  ): Promise<T> {
    const url = `${conn.host.replace(/\/+$/, "")}/api/v4${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        "PRIVATE-TOKEN": conn.token,
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
    throw new Error(`GitLab ${method} ${path} ${res.status}: ${text.slice(0, 300)}`);
  }

  private get<T>(conn: GitLabConnection, path: string): Promise<T> {
    return this.request<T>(conn, "GET", path);
  }
  private post<T>(conn: GitLabConnection, path: string, body: unknown): Promise<T> {
    return this.request<T>(conn, "POST", path, body);
  }
  private put<T>(conn: GitLabConnection, path: string, body: unknown): Promise<T> {
    return this.request<T>(conn, "PUT", path, body);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function toRepoItem(raw: GitLabIssueRaw, kind: "issue" | "pull_request"): RepoItem {
  const state: "open" | "closed" = raw.state === "opened" ? "open" : "closed";
  return {
    number: raw.iid,
    kind,
    title: raw.title,
    body: raw.description ?? "",
    state,
    author: raw.author?.username ?? "",
    authorAssociation: "NONE",
    labels: raw.labels ?? [],
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    commentCount: raw.user_notes_count,
    snapshotHash: snapshotHash(raw, kind),
    url: raw.web_url,
  };
}

function snapshotHash(raw: GitLabIssueRaw, kind: string): string {
  const payload = JSON.stringify({
    kind,
    title: raw.title,
    state: raw.state,
    labels: [...(raw.labels ?? [])].sort().join(","),
    notes: raw.user_notes_count,
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
  const reset = res.headers.get("ratelimit-reset");
  if (reset) {
    const ms = Number(reset) * 1000 - Date.now();
    return Math.max(0, ms);
  }
  return 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
