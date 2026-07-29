import { readFileSync, statSync } from "node:fs";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { newId, isoNow } from "../../../../../src/core/helpers.js";
import type { LinkedInAccountRow, LinkedInPostRow } from "./types.js";

const LI_API = "https://api.linkedin.com/v2";
const LI_OAUTH_TOKEN = "https://www.linkedin.com/oauth/v2/accessToken";

export class LinkedInService {
  constructor(private db: SqliteDb) {}

  // ── Account CRUD ──────────────────────────────────

  addAccount(input: {
    urn: string;
    display_name?: string;
    account_type?: "person" | "organization";
    client_id?: string;
    client_secret?: string;
    access_token: string;
    refresh_token?: string;
    role?: "brand" | "founder" | "community" | "other";
  }): LinkedInAccountRow {
    const now = isoNow();
    const id = newId();
    // Normalize URN — accept either "abc123" or "urn:li:person:abc123".
    const urn = input.urn.startsWith("urn:li:") ? input.urn : `urn:li:${input.account_type ?? "person"}:${input.urn}`;
    this.db
      .prepare(
        `INSERT INTO linkedin_accounts
          (id, urn, display_name, account_type, client_id, client_secret, access_token, refresh_token, role, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        urn,
        input.display_name ?? "",
        input.account_type ?? "person",
        input.client_id ?? "",
        input.client_secret ?? "",
        input.access_token,
        input.refresh_token ?? "",
        input.role ?? "founder",
        now,
        now,
      );
    return this.getAccount(id)!;
  }

  getAccount(id: string): LinkedInAccountRow | undefined {
    return this.db
      .prepare("SELECT * FROM linkedin_accounts WHERE id = ?")
      .get(id) as LinkedInAccountRow | undefined;
  }

  listAccounts(): LinkedInAccountRow[] {
    return this.db
      .prepare("SELECT * FROM linkedin_accounts ORDER BY created_at DESC")
      .all() as LinkedInAccountRow[];
  }

  deleteAccount(id: string): boolean {
    const r = this.db.prepare("DELETE FROM linkedin_accounts WHERE id = ?").run(id);
    return r.changes > 0;
  }

  // ── OAuth ──────────────────────────────────

  /** Refresh access_token if refresh_token is set. */
  async refreshToken(accountId: string): Promise<string> {
    const acc = this.getAccount(accountId);
    if (!acc) throw new Error("Account not found");
    if (!acc.refresh_token) {
      throw new Error("Account has no refresh_token — re-issue OAuth flow and update via kernel_linkedin_set_token");
    }

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: acc.refresh_token,
      client_id: acc.client_id,
      client_secret: acc.client_secret,
    });

    const res = await fetch(LI_OAUTH_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`LinkedIn OAuth refresh failed (${res.status}): ${txt}`);
    }
    const data = (await res.json()) as { access_token: string; expires_in: number; refresh_token?: string };
    const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

    this.db
      .prepare(
        `UPDATE linkedin_accounts
           SET access_token = ?, refresh_token = COALESCE(?, refresh_token), token_expires_at = ?, updated_at = ?
           WHERE id = ?`,
      )
      .run(data.access_token, data.refresh_token ?? null, expiresAt, isoNow(), accountId);

    return data.access_token;
  }

  /** Manually update the access_token (when OAuth dance is done outside the kernel). */
  setToken(accountId: string, accessToken: string, expiresInSeconds?: number, refreshToken?: string): void {
    const expiresAt = expiresInSeconds
      ? new Date(Date.now() + expiresInSeconds * 1000).toISOString()
      : null;
    this.db
      .prepare(
        `UPDATE linkedin_accounts
           SET access_token = ?, refresh_token = COALESCE(?, refresh_token), token_expires_at = ?, updated_at = ?
           WHERE id = ?`,
      )
      .run(accessToken, refreshToken ?? null, expiresAt, isoNow(), accountId);
  }

  private async getToken(accountId: string): Promise<string> {
    const acc = this.getAccount(accountId);
    if (!acc) throw new Error("Account not found");
    if (!acc.access_token) throw new Error("Account has no access_token");
    const expired =
      acc.token_expires_at && new Date(acc.token_expires_at).getTime() < Date.now() + 60_000;
    if (expired && acc.refresh_token) return this.refreshToken(accountId);
    return acc.access_token;
  }

  // ── Profile lookup ──────────────────────────────────

  /** Fetch authenticated person URN + name. Uses /v2/userinfo (OIDC scope). */
  async fetchMe(accountId: string): Promise<{ urn: string; name: string }> {
    const token = await this.getToken(accountId);
    const res = await fetch(`${LI_API}/userinfo`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`LinkedIn /userinfo failed (${res.status})`);
    const data = (await res.json()) as { sub: string; name: string };
    const urn = `urn:li:person:${data.sub}`;

    this.db
      .prepare(
        `UPDATE linkedin_accounts SET urn = ?, display_name = ?, updated_at = ? WHERE id = ?`,
      )
      .run(urn, data.name, isoNow(), accountId);

    return { urn, name: data.name };
  }

  // ── Posting ──────────────────────────────────

  /** Create a UGC post — text only, or with an article link card. */
  async createTextPost(input: {
    account_id: string;
    text: string;
    article_url?: string;
    article_title?: string;
    article_desc?: string;
    visibility?: "PUBLIC" | "CONNECTIONS" | "LOGGED_IN";
  }): Promise<LinkedInPostRow> {
    const acc = this.getAccount(input.account_id);
    if (!acc) throw new Error("Account not found");

    const now = isoNow();
    const id = newId();
    const kind: "text" | "article" = input.article_url ? "article" : "text";
    const visibility = input.visibility ?? "PUBLIC";

    this.db
      .prepare(
        `INSERT INTO linkedin_posts
          (id, account_id, text, kind, article_url, article_title, article_desc, visibility, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
      )
      .run(
        id,
        input.account_id,
        input.text,
        kind,
        input.article_url ?? "",
        input.article_title ?? "",
        input.article_desc ?? "",
        visibility,
        now,
        now,
      );

    try {
      const token = await this.getToken(input.account_id);
      const body: Record<string, unknown> = {
        author: acc.urn,
        lifecycleState: "PUBLISHED",
        specificContent: {
          "com.linkedin.ugc.ShareContent": {
            shareCommentary: { text: input.text },
            shareMediaCategory: kind === "article" ? "ARTICLE" : "NONE",
            ...(kind === "article" && {
              media: [
                {
                  status: "READY",
                  originalUrl: input.article_url,
                  ...(input.article_title && { title: { text: input.article_title } }),
                  ...(input.article_desc && { description: { text: input.article_desc } }),
                },
              ],
            }),
          },
        },
        visibility: { "com.linkedin.ugc.MemberNetworkVisibility": visibility },
      };

      const res = await fetch(`${LI_API}/ugcPosts`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Restli-Protocol-Version": "2.0.0",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`LinkedIn post failed (${res.status}): ${txt}`);
      }
      const postUrn = res.headers.get("x-restli-id") ?? "";
      this.db
        .prepare(
          `UPDATE linkedin_posts
             SET status = 'published', post_urn = ?, published_at = ?, updated_at = ?
             WHERE id = ?`,
        )
        .run(postUrn, isoNow(), isoNow(), id);
    } catch (err) {
      this.db
        .prepare(
          `UPDATE linkedin_posts SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`,
        )
        .run(err instanceof Error ? err.message : String(err), isoNow(), id);
      throw err;
    }

    return this.getPost(id)!;
  }

  /**
   * Create a post with an image attachment. Two-step: register upload, PUT
   * image bytes, then create UGC post referencing the asset URN.
   */
  async createImagePost(input: {
    account_id: string;
    text: string;
    image_path: string;
    visibility?: "PUBLIC" | "CONNECTIONS" | "LOGGED_IN";
  }): Promise<LinkedInPostRow> {
    const acc = this.getAccount(input.account_id);
    if (!acc) throw new Error("Account not found");
    const stat = statSync(input.image_path);
    if (!stat.isFile()) throw new Error(`Image not found: ${input.image_path}`);

    const now = isoNow();
    const id = newId();
    const visibility = input.visibility ?? "PUBLIC";

    this.db
      .prepare(
        `INSERT INTO linkedin_posts
          (id, account_id, text, kind, image_path, visibility, status, created_at, updated_at)
         VALUES (?, ?, ?, 'image', ?, ?, 'draft', ?, ?)`,
      )
      .run(id, input.account_id, input.text, input.image_path, visibility, now, now);

    try {
      const token = await this.getToken(input.account_id);

      // Step 1 — register upload.
      const regRes = await fetch(`${LI_API}/assets?action=registerUpload`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          registerUploadRequest: {
            recipes: ["urn:li:digitalmediaRecipe:feedshare-image"],
            owner: acc.urn,
            serviceRelationships: [
              {
                relationshipType: "OWNER",
                identifier: "urn:li:userGeneratedContent",
              },
            ],
          },
        }),
      });
      if (!regRes.ok) {
        const txt = await regRes.text();
        throw new Error(`Image registerUpload failed (${regRes.status}): ${txt}`);
      }
      const regData = (await regRes.json()) as {
        value: {
          asset: string;
          uploadMechanism: {
            "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest": {
              uploadUrl: string;
            };
          };
        };
      };
      const uploadUrl =
        regData.value.uploadMechanism[
          "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"
        ].uploadUrl;
      const assetUrn = regData.value.asset;

      // Step 2 — PUT image bytes.
      const fileBuf = readFileSync(input.image_path);
      const upRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
        body: fileBuf,
      });
      if (!upRes.ok) {
        const txt = await upRes.text();
        throw new Error(`Image upload failed (${upRes.status}): ${txt}`);
      }

      // Step 3 — create UGC post referencing the asset.
      const body = {
        author: acc.urn,
        lifecycleState: "PUBLISHED",
        specificContent: {
          "com.linkedin.ugc.ShareContent": {
            shareCommentary: { text: input.text },
            shareMediaCategory: "IMAGE",
            media: [
              {
                status: "READY",
                media: assetUrn,
              },
            ],
          },
        },
        visibility: { "com.linkedin.ugc.MemberNetworkVisibility": visibility },
      };

      const postRes = await fetch(`${LI_API}/ugcPosts`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Restli-Protocol-Version": "2.0.0",
        },
        body: JSON.stringify(body),
      });
      if (!postRes.ok) {
        const txt = await postRes.text();
        throw new Error(`LinkedIn image post failed (${postRes.status}): ${txt}`);
      }
      const postUrn = postRes.headers.get("x-restli-id") ?? "";

      this.db
        .prepare(
          `UPDATE linkedin_posts
             SET status = 'published', post_urn = ?, published_at = ?, updated_at = ?
             WHERE id = ?`,
        )
        .run(postUrn, isoNow(), isoNow(), id);
    } catch (err) {
      this.db
        .prepare(
          `UPDATE linkedin_posts SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`,
        )
        .run(err instanceof Error ? err.message : String(err), isoNow(), id);
      throw err;
    }

    return this.getPost(id)!;
  }

  // ── Post bookkeeping ──────────────────────────────────

  getPost(id: string): LinkedInPostRow | undefined {
    return this.db
      .prepare("SELECT * FROM linkedin_posts WHERE id = ?")
      .get(id) as LinkedInPostRow | undefined;
  }

  listPosts(filters: { account_id?: string; status?: string; limit?: number } = {}): LinkedInPostRow[] {
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
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = Math.min(filters.limit ?? 50, 200);
    return this.db
      .prepare(`SELECT * FROM linkedin_posts ${clause} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, limit) as LinkedInPostRow[];
  }

  deletePost(id: string): boolean {
    const r = this.db.prepare("DELETE FROM linkedin_posts WHERE id = ?").run(id);
    return r.changes > 0;
  }
}
