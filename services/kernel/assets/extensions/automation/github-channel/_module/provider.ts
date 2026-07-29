import { createSign, createHash } from "node:crypto";
import type { GitHubConnectionsService, GitHubConnection } from "./connections-service.js";

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "Kernl-triage/0.1";
const API_VERSION = "2022-11-28";
const TOKEN_REFRESH_MS = 50 * 60 * 1000;

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
}

export class GitHubRepoProvider {
  readonly name = "github";

  private tokenCache = new Map<string, { token: string; expiresAt: number }>();

  constructor(private connections: GitHubConnectionsService) {}

  // ── RepoProvider surface ────────────────────────────────────────────

  listConnections(): ConnectionSummary[] {
    return this.connections.list().map((c) => ({
      id: c.id,
      name: c.name,
      details: { app_id: c.app_id, installation_id: c.installation_id },
      lastTestAt: c.last_test_at,
      lastTestOk: c.last_test_ok == null ? null : c.last_test_ok === 1,
    }));
  }

  assertConnection(connectionId: string): void {
    if (!this.connections.get(connectionId)) {
      throw new Error(`GitHub connection not found: ${connectionId}`);
    }
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
    const it = await this.get<GitHubIssueRaw>(conn, `/repos/${repo}/issues/${number}`);
    return toRepoItem(it);
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
        `/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`,
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
      if (comments.length < 100) break;
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
      const data = await this.get<{ slug?: string; name?: string; id?: number }>(conn, `/app`);
      const detail = `OK — app id=${data.id ?? "?"} (${data.slug ?? data.name ?? "unnamed"})`;
      this.connections.recordTest(connectionId, true, "");
      return { ok: true, detail };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.connections.recordTest(connectionId, false, msg);
      return { ok: false, detail: msg };
    }
  }

  // ── HTTP layer ──────────────────────────────────────────────────────

  private requireConnection(id: string): GitHubConnection {
    const conn = this.connections.get(id);
    if (!conn) throw new Error(`GitHub connection not found: ${id}`);
    return conn;
  }

  private async request<T>(
    conn: GitHubConnection,
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
    attempt = 1,
  ): Promise<T> {
    const token = await this.installationToken(conn);
    const res = await fetch(`${GITHUB_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": USER_AGENT,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.ok) {
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    }
    if (res.status === 401 && attempt === 1) {
      this.tokenCache.delete(cacheKey(conn));
      return this.request<T>(conn, method, path, body, attempt + 1);
    }
    if ((res.status === 403 || res.status === 429) && attempt <= 3) {
      const waitMs = retryAfterMs(res);
      if (waitMs > 0 && waitMs <= 60_000) {
        await sleep(waitMs);
        return this.request<T>(conn, method, path, body, attempt + 1);
      }
    }
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub ${method} ${path} ${res.status}: ${text.slice(0, 300)}`);
  }

  private get<T>(conn: GitHubConnection, path: string): Promise<T> {
    return this.request<T>(conn, "GET", path);
  }
  private post<T>(conn: GitHubConnection, path: string, body: unknown): Promise<T> {
    return this.request<T>(conn, "POST", path, body);
  }
  private patch<T>(conn: GitHubConnection, path: string, body: unknown): Promise<T> {
    return this.request<T>(conn, "PATCH", path, body);
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
          "User-Agent": USER_AGENT,
        },
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`GitHub installation token ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = (await res.json()) as { token: string; expires_at: string };
    this.tokenCache.set(key, {
      token: data.token,
      expiresAt: Math.min(new Date(data.expires_at).getTime(), now + TOKEN_REFRESH_MS),
    });
    return data.token;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

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
    snapshotHash: snapshotHash(raw, labels),
    url: raw.html_url,
  };
}

function snapshotHash(raw: GitHubIssueRaw, labels: string[]): string {
  const payload = JSON.stringify({
    title: raw.title,
    state: raw.state,
    labels: [...labels].sort().join(","),
    comments: raw.comments,
    updated_at: raw.updated_at,
  });
  return createHash("sha256").update(payload).digest("hex");
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

function retryAfterMs(res: Response): number {
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) {
    const n = Number(retryAfter);
    if (Number.isFinite(n)) return n * 1000;
  }
  const reset = res.headers.get("x-ratelimit-reset");
  if (reset) {
    const ms = Number(reset) * 1000 - Date.now();
    return Math.max(0, ms);
  }
  return 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
