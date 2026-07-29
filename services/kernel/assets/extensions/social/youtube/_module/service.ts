import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { newId, isoNow } from "../../../../../src/core/helpers.js";
import type { YouTubeAccountRow, YouTubeVideoRow } from "./types.js";

const GOOGLE_OAUTH_TOKEN = "https://oauth2.googleapis.com/token";
const YT_API = "https://www.googleapis.com/youtube/v3";
const YT_UPLOAD = "https://www.googleapis.com/upload/youtube/v3/videos";

export class YouTubeService {
  constructor(private db: SqliteDb) {}

  // ── Account CRUD ──────────────────────────────────

  addAccount(input: {
    channel_id: string;
    channel_title?: string;
    client_id: string;
    client_secret: string;
    refresh_token: string;
    role?: "brand" | "founder" | "community" | "other";
  }): YouTubeAccountRow {
    const now = isoNow();
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO youtube_accounts
          (id, channel_id, channel_title, client_id, client_secret, refresh_token, role, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.channel_id,
        input.channel_title ?? "",
        input.client_id,
        input.client_secret,
        input.refresh_token,
        input.role ?? "brand",
        now,
        now,
      );
    return this.getAccount(id)!;
  }

  getAccount(id: string): YouTubeAccountRow | undefined {
    return this.db
      .prepare("SELECT * FROM youtube_accounts WHERE id = ?")
      .get(id) as YouTubeAccountRow | undefined;
  }

  listAccounts(): YouTubeAccountRow[] {
    return this.db
      .prepare("SELECT * FROM youtube_accounts ORDER BY created_at DESC")
      .all() as YouTubeAccountRow[];
  }

  deleteAccount(id: string): boolean {
    const r = this.db.prepare("DELETE FROM youtube_accounts WHERE id = ?").run(id);
    return r.changes > 0;
  }

  // ── OAuth ──────────────────────────────────

  /** Refresh access_token using stored refresh_token. */
  async refreshToken(accountId: string): Promise<string> {
    const acc = this.getAccount(accountId);
    if (!acc) throw new Error(`Account not found: ${accountId}`);
    if (!acc.refresh_token) throw new Error("Account missing refresh_token");

    const body = new URLSearchParams({
      client_id: acc.client_id,
      client_secret: acc.client_secret,
      refresh_token: acc.refresh_token,
      grant_type: "refresh_token",
    });

    const res = await fetch(GOOGLE_OAUTH_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Google OAuth refresh failed (${res.status}): ${txt}`);
    }
    const data = (await res.json()) as { access_token: string; expires_in: number };
    const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

    this.db
      .prepare(
        `UPDATE youtube_accounts SET access_token = ?, token_expires_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(data.access_token, expiresAt, isoNow(), accountId);

    return data.access_token;
  }

  private async getToken(accountId: string): Promise<string> {
    const acc = this.getAccount(accountId);
    if (!acc) throw new Error("Account not found");
    const expired =
      !acc.access_token ||
      !acc.token_expires_at ||
      new Date(acc.token_expires_at).getTime() < Date.now() + 60_000;
    if (expired) return this.refreshToken(accountId);
    return acc.access_token;
  }

  // ── Channel info ──────────────────────────────────

  async fetchChannel(accountId: string): Promise<{
    id: string;
    title: string;
    subscribers: number;
    views: number;
    videos: number;
  }> {
    const token = await this.getToken(accountId);
    const res = await fetch(`${YT_API}/channels?part=snippet,statistics&mine=true`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`YouTube channels fetch failed (${res.status})`);
    const data = (await res.json()) as {
      items?: Array<{
        id: string;
        snippet: { title: string };
        statistics: { subscriberCount?: string; viewCount?: string; videoCount?: string };
      }>;
    };
    if (!data.items || data.items.length === 0) {
      throw new Error("No channel returned for this account");
    }
    const ch = data.items[0];
    const stats = {
      id: ch.id,
      title: ch.snippet.title,
      subscribers: Number(ch.statistics.subscriberCount ?? 0),
      views: Number(ch.statistics.viewCount ?? 0),
      videos: Number(ch.statistics.videoCount ?? 0),
    };

    this.db
      .prepare(
        `UPDATE youtube_accounts
           SET channel_id = ?, channel_title = ?, subscribers = ?, total_views = ?, total_videos = ?, updated_at = ?
           WHERE id = ?`,
      )
      .run(stats.id, stats.title, stats.subscribers, stats.views, stats.videos, isoNow(), accountId);

    return stats;
  }

  // ── Upload ──────────────────────────────────

  /**
   * Upload a video using YouTube resumable upload (single-shot for simplicity —
   * for very large files, split-chunk uploads can be added later).
   */
  async upload(input: {
    account_id: string;
    file_path: string;
    title: string;
    description?: string;
    tags?: string[];
    category_id?: string;
    privacy?: "public" | "unlisted" | "private";
  }): Promise<YouTubeVideoRow> {
    const stat = statSync(input.file_path);
    if (!stat.isFile()) throw new Error(`File not found: ${input.file_path}`);

    const now = isoNow();
    const id = newId();
    const tagsCsv = (input.tags ?? []).join(",");
    const privacy = input.privacy ?? "private";
    const categoryId = input.category_id ?? "22"; // 22 = People & Blogs

    this.db
      .prepare(
        `INSERT INTO youtube_videos
          (id, account_id, title, description, tags, category_id, privacy, status, file_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?, ?)`,
      )
      .run(
        id,
        input.account_id,
        input.title,
        input.description ?? "",
        tagsCsv,
        categoryId,
        privacy,
        input.file_path,
        now,
        now,
      );

    try {
      const token = await this.getToken(input.account_id);
      const metadata = {
        snippet: {
          title: input.title,
          description: input.description ?? "",
          tags: input.tags ?? [],
          categoryId,
        },
        status: { privacyStatus: privacy },
      };

      // Step 1 — initiate resumable upload (gets upload URL).
      const initRes = await fetch(
        `${YT_UPLOAD}?uploadType=resumable&part=snippet,status`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json; charset=UTF-8",
            "X-Upload-Content-Length": String(stat.size),
            "X-Upload-Content-Type": "video/*",
          },
          body: JSON.stringify(metadata),
        },
      );
      if (!initRes.ok) {
        const txt = await initRes.text();
        throw new Error(`Upload init failed (${initRes.status}): ${txt}`);
      }
      const uploadUrl = initRes.headers.get("location");
      if (!uploadUrl) throw new Error("Upload init returned no Location header");

      this.db
        .prepare(`UPDATE youtube_videos SET upload_url = ?, updated_at = ? WHERE id = ?`)
        .run(uploadUrl, isoNow(), id);

      // Step 2 — upload the file body.
      const fileBuf = readFileSync(input.file_path);
      const uploadRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "video/*",
          "Content-Length": String(stat.size),
        },
        body: fileBuf,
      });
      if (!uploadRes.ok) {
        const txt = await uploadRes.text();
        throw new Error(`Upload body failed (${uploadRes.status}): ${txt}`);
      }
      const result = (await uploadRes.json()) as { id: string };

      this.db
        .prepare(
          `UPDATE youtube_videos
             SET video_id = ?, status = 'uploaded', published_at = ?, updated_at = ?
             WHERE id = ?`,
        )
        .run(result.id, isoNow(), isoNow(), id);
    } catch (err) {
      this.db
        .prepare(
          `UPDATE youtube_videos SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`,
        )
        .run(err instanceof Error ? err.message : String(err), isoNow(), id);
      throw err;
    }

    return this.getVideo(id)!;
  }

  /** Update title / description / tags / privacy of an already-uploaded video. */
  async updateVideo(input: {
    account_id: string;
    video_id: string; // YouTube video ID
    title?: string;
    description?: string;
    tags?: string[];
    category_id?: string;
    privacy?: "public" | "unlisted" | "private";
  }): Promise<void> {
    const token = await this.getToken(input.account_id);

    // Fetch current snippet first (YouTube API requires full snippet on update).
    const cur = await fetch(
      `${YT_API}/videos?part=snippet,status&id=${encodeURIComponent(input.video_id)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!cur.ok) throw new Error(`Video fetch failed (${cur.status})`);
    const curData = (await cur.json()) as {
      items?: Array<{
        snippet: { title: string; description: string; tags?: string[]; categoryId: string };
        status: { privacyStatus: string };
      }>;
    };
    if (!curData.items || curData.items.length === 0) throw new Error("Video not found");
    const cur0 = curData.items[0];

    const body = {
      id: input.video_id,
      snippet: {
        title: input.title ?? cur0.snippet.title,
        description: input.description ?? cur0.snippet.description,
        tags: input.tags ?? cur0.snippet.tags ?? [],
        categoryId: input.category_id ?? cur0.snippet.categoryId,
      },
      status: {
        privacyStatus: input.privacy ?? cur0.status.privacyStatus,
      },
    };

    const res = await fetch(`${YT_API}/videos?part=snippet,status`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Video update failed (${res.status}): ${txt}`);
    }
  }

  // ── Video bookkeeping ──────────────────────────────────

  getVideo(id: string): YouTubeVideoRow | undefined {
    return this.db
      .prepare("SELECT * FROM youtube_videos WHERE id = ?")
      .get(id) as YouTubeVideoRow | undefined;
  }

  listVideos(filters: { account_id?: string; status?: string; limit?: number } = {}): YouTubeVideoRow[] {
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
      .prepare(`SELECT * FROM youtube_videos ${clause} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, limit) as YouTubeVideoRow[];
  }

  /** Fetch stats for a published video from YouTube API. */
  async syncVideoStats(input: { account_id: string; video_id: string }): Promise<{
    views: number;
    likes: number;
    comments: number;
  }> {
    const token = await this.getToken(input.account_id);
    const res = await fetch(
      `${YT_API}/videos?part=statistics&id=${encodeURIComponent(input.video_id)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new Error(`Stats fetch failed (${res.status})`);
    const data = (await res.json()) as {
      items?: Array<{ statistics: { viewCount?: string; likeCount?: string; commentCount?: string } }>;
    };
    if (!data.items || data.items.length === 0) throw new Error("Video not found");
    const s = data.items[0].statistics;
    const stats = {
      views: Number(s.viewCount ?? 0),
      likes: Number(s.likeCount ?? 0),
      comments: Number(s.commentCount ?? 0),
    };

    this.db
      .prepare(
        `UPDATE youtube_videos
           SET views = ?, likes = ?, comments_count = ?, updated_at = ?
           WHERE video_id = ? AND account_id = ?`,
      )
      .run(stats.views, stats.likes, stats.comments, isoNow(), input.video_id, input.account_id);

    return stats;
  }
}
