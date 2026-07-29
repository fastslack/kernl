import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { newId, isoNow } from "../../../../../src/core/helpers.js";
import type { RedditAccountRow, RedditPostRow } from "./types.js";

const REDDIT_OAUTH = "https://www.reddit.com/api/v1/access_token";
const REDDIT_API = "https://oauth.reddit.com";

export class RedditService {
  constructor(private db: SqliteDb) {}

  // ── Account CRUD ──────────────────────────────────

  addAccount(input: {
    username: string;
    client_id: string;
    client_secret: string;
    password: string;
    user_agent?: string;
    role?: "brand" | "founder" | "community" | "other";
  }): RedditAccountRow {
    const now = isoNow();
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO reddit_accounts
          (id, username, client_id, client_secret, password, user_agent, role, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.username.replace(/^u\//, ""),
        input.client_id,
        input.client_secret,
        input.password,
        input.user_agent ?? `kernl:reddit:1.0 (by /u/${input.username})`,
        input.role ?? "founder",
        now,
        now,
      );
    return this.getAccount(id)!;
  }

  getAccount(id: string): RedditAccountRow | undefined {
    return this.db
      .prepare("SELECT * FROM reddit_accounts WHERE id = ?")
      .get(id) as RedditAccountRow | undefined;
  }

  getAccountByUsername(username: string): RedditAccountRow | undefined {
    return this.db
      .prepare("SELECT * FROM reddit_accounts WHERE username = ?")
      .get(username.replace(/^u\//, "")) as RedditAccountRow | undefined;
  }

  listAccounts(): RedditAccountRow[] {
    return this.db
      .prepare("SELECT * FROM reddit_accounts ORDER BY created_at DESC")
      .all() as RedditAccountRow[];
  }

  deleteAccount(id: string): boolean {
    const r = this.db.prepare("DELETE FROM reddit_accounts WHERE id = ?").run(id);
    return r.changes > 0;
  }

  // ── OAuth ──────────────────────────────────

  /** Acquire an access_token via OAuth2 password grant (script app). */
  async authenticate(accountId: string): Promise<string> {
    const acc = this.getAccount(accountId);
    if (!acc) throw new Error(`Account not found: ${accountId}`);
    if (!acc.client_id || !acc.client_secret || !acc.password) {
      throw new Error("Account missing client_id, client_secret, or password");
    }

    const basic = Buffer.from(`${acc.client_id}:${acc.client_secret}`).toString("base64");
    const body = new URLSearchParams({
      grant_type: "password",
      username: acc.username,
      password: acc.password,
    });

    const res = await fetch(REDDIT_OAUTH, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "User-Agent": acc.user_agent,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Reddit OAuth failed (${res.status}): ${txt}`);
    }

    const data = (await res.json()) as { access_token: string; expires_in: number };
    const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

    this.db
      .prepare(
        `UPDATE reddit_accounts SET access_token = ?, token_expires_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(data.access_token, expiresAt, isoNow(), accountId);

    return data.access_token;
  }

  /** Get a fresh token (auto-refreshes if expired). */
  private async getToken(accountId: string): Promise<string> {
    const acc = this.getAccount(accountId);
    if (!acc) throw new Error("Account not found");
    const expired =
      !acc.access_token ||
      !acc.token_expires_at ||
      new Date(acc.token_expires_at).getTime() < Date.now() + 60_000;
    if (expired) return this.authenticate(accountId);
    return acc.access_token;
  }

  // ── Reddit API actions ──────────────────────────────────

  /** Fetch /api/v1/me — current user info + karma. */
  async fetchMe(accountId: string): Promise<{
    name: string;
    comment_karma: number;
    link_karma: number;
    total_karma: number;
  }> {
    const acc = this.getAccount(accountId);
    if (!acc) throw new Error("Account not found");
    const token = await this.getToken(accountId);

    const res = await fetch(`${REDDIT_API}/api/v1/me`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": acc.user_agent,
      },
    });
    if (!res.ok) throw new Error(`Reddit /me failed (${res.status})`);
    const me = (await res.json()) as {
      name: string;
      comment_karma: number;
      link_karma: number;
      total_karma: number;
    };

    this.db
      .prepare(
        `UPDATE reddit_accounts SET karma_comment = ?, karma_post = ?, updated_at = ? WHERE id = ?`,
      )
      .run(me.comment_karma, me.link_karma, isoNow(), accountId);

    return me;
  }

  /** Submit a post (text or link) to a subreddit. */
  async submit(input: {
    account_id: string;
    subreddit: string;
    title: string;
    body?: string;
    url?: string;
    nsfw?: boolean;
    spoiler?: boolean;
  }): Promise<RedditPostRow> {
    const acc = this.getAccount(input.account_id);
    if (!acc) throw new Error("Account not found");

    const kind: "self" | "link" = input.url ? "link" : "self";
    const now = isoNow();
    const id = newId();

    this.db
      .prepare(
        `INSERT INTO reddit_posts
          (id, account_id, subreddit, title, body, url, kind, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
      )
      .run(
        id,
        input.account_id,
        input.subreddit.replace(/^r\//, ""),
        input.title,
        input.body ?? "",
        input.url ?? "",
        kind,
        now,
        now,
      );

    try {
      const token = await this.getToken(input.account_id);
      const form = new URLSearchParams({
        sr: input.subreddit.replace(/^r\//, ""),
        kind,
        title: input.title,
        api_type: "json",
      });
      if (kind === "self") form.set("text", input.body ?? "");
      if (kind === "link") form.set("url", input.url!);
      if (input.nsfw) form.set("nsfw", "true");
      if (input.spoiler) form.set("spoiler", "true");

      const res = await fetch(`${REDDIT_API}/api/submit`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": acc.user_agent,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form,
      });

      if (!res.ok) {
        const errTxt = await res.text();
        throw new Error(`Reddit submit failed (${res.status}): ${errTxt}`);
      }

      // Reddit returns either { json: { errors: [...], data: { url, name, id } } }
      // or an HTML page when account is restricted — handle both.
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("application/json")) {
        throw new Error(`Reddit returned non-JSON response (likely auth or rate limit)`);
      }

      const data = (await res.json()) as {
        json: { errors: unknown[][]; data?: { url: string; name: string; id: string } };
      };

      if (data.json.errors && data.json.errors.length > 0) {
        throw new Error(`Reddit errors: ${JSON.stringify(data.json.errors)}`);
      }

      const submitted = data.json.data!;
      this.db
        .prepare(
          `UPDATE reddit_posts
             SET status = 'published',
                 reddit_id = ?, permalink = ?, published_at = ?, updated_at = ?
             WHERE id = ?`,
        )
        .run(submitted.name, submitted.url, isoNow(), isoNow(), id);
    } catch (err) {
      this.db
        .prepare(
          `UPDATE reddit_posts SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`,
        )
        .run(err instanceof Error ? err.message : String(err), isoNow(), id);
      throw err;
    }

    return this.getPost(id)!;
  }

  /** Fetch a subreddit feed (read-only). */
  async fetchSubreddit(input: {
    account_id: string;
    subreddit: string;
    sort?: "new" | "hot" | "top" | "rising";
    limit?: number;
  }): Promise<
    Array<{ id: string; title: string; author: string; score: number; url: string; permalink: string }>
  > {
    const acc = this.getAccount(input.account_id);
    if (!acc) throw new Error("Account not found");
    const token = await this.getToken(input.account_id);
    const sub = input.subreddit.replace(/^r\//, "");
    const sort = input.sort ?? "new";
    const limit = Math.min(input.limit ?? 25, 100);

    const res = await fetch(`${REDDIT_API}/r/${sub}/${sort}?limit=${limit}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": acc.user_agent,
      },
    });
    if (!res.ok) throw new Error(`Reddit fetch failed (${res.status})`);
    const data = (await res.json()) as {
      data: { children: Array<{ data: { id: string; title: string; author: string; score: number; url: string; permalink: string } }> };
    };
    return data.data.children.map((c) => ({
      id: c.data.id,
      title: c.data.title,
      author: c.data.author,
      score: c.data.score,
      url: c.data.url,
      permalink: `https://reddit.com${c.data.permalink}`,
    }));
  }

  // ── Post bookkeeping ──────────────────────────────────

  getPost(id: string): RedditPostRow | undefined {
    return this.db
      .prepare("SELECT * FROM reddit_posts WHERE id = ?")
      .get(id) as RedditPostRow | undefined;
  }

  listPosts(filters: {
    account_id?: string;
    status?: string;
    subreddit?: string;
    limit?: number;
  } = {}): RedditPostRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filters.account_id) {
      where.push("account_id = ?");
      params.push(filters.account_id);
    }
    if (filters.status) {
      where.push("status = ?");
      params.push(filters.status);
    }
    if (filters.subreddit) {
      where.push("subreddit = ?");
      params.push(filters.subreddit.replace(/^r\//, ""));
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = Math.min(filters.limit ?? 50, 200);
    return this.db
      .prepare(`SELECT * FROM reddit_posts ${clause} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, limit) as RedditPostRow[];
  }

  deletePost(id: string): boolean {
    const r = this.db.prepare("DELETE FROM reddit_posts WHERE id = ?").run(id);
    return r.changes > 0;
  }
}
