import { type SqliteDb, type KernelConfig, type PatchColumn, newId, isoNow, buildPatch } from "@kernl/extension-sdk";
import type {
  TwitterAccountRow,
  TwitterPostRow,
  TwitterMentionRow,
  TwitterMetricsSnapshotRow,
  TwitterPostAnalyticsRow,
  TwitterAccountStateRow,
} from "./types.js";

// Vault key convention for xactions auth cookies.
// Stored as 'x-cookie/<handle>' in the kernel_vault module (encrypted at rest).
function vaultKeyFor(handle: string): string {
  return `x-cookie/${handle.replace(/^@/, "")}`;
}

/**
 * Account columns that hold credentials. auth_cookie_ref carries the
 * auth_token cookie itself (kernel_twitter_set_cookie stores it inline), so it
 * is as secret as the API keys.
 */
export const ACCOUNT_SECRET_FIELDS = ["api_key", "api_secret", "access_token", "access_secret", "auth_cookie_ref"] as const;
export type AccountSecretField = (typeof ACCOUNT_SECRET_FIELDS)[number];

/**
 * What a client sees in place of a stored secret. Sending it back on an update
 * (as the edit form does for untouched fields) keeps the stored value.
 */
export const SECRET_MASK = "••••";

/** An account row as it may leave the kernel for a client. */
export type PublicTwitterAccount = TwitterAccountRow & { [K in AccountSecretField as `has_${K}`]: boolean };

/**
 * The account with every credential replaced by SECRET_MASK (or "" when
 * unset) plus a `has_<field>` flag. Every response that reaches the dashboard
 * goes through this; the publisher and the MCP tools read the raw row.
 */
export function publicAccount(row: TwitterAccountRow): PublicTwitterAccount {
  const out: Record<string, unknown> = { ...row };
  for (const field of ACCOUNT_SECRET_FIELDS) {
    const set = typeof row[field] === "string" && row[field] !== "";
    out[field] = set ? SECRET_MASK : "";
    out[`has_${field}`] = set;
  }
  return out as unknown as PublicTwitterAccount;
}

/** The twitter_accounts columns updateAccount may write. */
const ACCOUNT_PATCH: Record<string, PatchColumn> = {
  handle: "text",
  display_name: "text",
  api_key: "text",
  api_secret: "text",
  access_token: "text",
  access_secret: "text",
  status: "text",
  driver: "text",
  auth_cookie_ref: "text",
  last_login_at: "text",
  voice_persona: "text",
  role: "text",
  partner_account_id: "text",
};

/** The twitter_posts columns updatePost may write. */
const POST_PATCH: Record<string, PatchColumn> = {
  content: "text",
  post_type: "text",
  status: "text",
  scheduled_at: "text",
  reply_to_x_id: "text",
  quote_x_id: "text",
  error_message: "text",
};

export class TwitterService {
  constructor(
    private db: SqliteDb,
    private config: KernelConfig,
  ) {}

  // ── Account CRUD ──────────────────────────────────

  addAccount(input: {
    handle: string;
    display_name?: string;
    api_key?: string;
    api_secret?: string;
    access_token?: string;
    access_secret?: string;
    driver?: string;
    voice_persona?: string;
    role?: string;
    partner_account_id?: string;
  }): TwitterAccountRow {
    const now = isoNow();
    const id = newId();
    const driver = input.driver ?? "api";

    this.db
      .prepare(
        `INSERT INTO twitter_accounts
           (id, handle, display_name, api_key, api_secret, access_token, access_secret,
            driver, voice_persona, role, partner_account_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.handle,
        input.display_name ?? "",
        input.api_key ?? "",
        input.api_secret ?? "",
        input.access_token ?? "",
        input.access_secret ?? "",
        driver,
        input.voice_persona ?? "",
        input.role ?? "brand",
        input.partner_account_id ?? "",
        now,
        now,
      );

    // Initialize account state row in default phase
    this.db
      .prepare(
        `INSERT INTO twitter_account_state (account_id, phase, phase_started_at, updated_at)
         VALUES (?, 'seeding', ?, ?)`,
      )
      .run(id, now, now);

    return this.db.prepare("SELECT * FROM twitter_accounts WHERE id = ?").get(id) as TwitterAccountRow;
  }

  getAccount(id: string): TwitterAccountRow | undefined {
    return this.db.prepare("SELECT * FROM twitter_accounts WHERE id = ?").get(id) as TwitterAccountRow | undefined;
  }

  listAccounts(): TwitterAccountRow[] {
    return this.db.prepare("SELECT * FROM twitter_accounts ORDER BY handle").all() as TwitterAccountRow[];
  }

  updateAccount(
    id: string,
    changes: Partial<{
      handle: string;
      display_name: string;
      api_key: string;
      api_secret: string;
      access_token: string;
      access_secret: string;
      status: string;
      driver: string;
      auth_cookie_ref: string;
      last_login_at: string;
      voice_persona: string;
      role: string;
      partner_account_id: string;
    }>,
  ): TwitterAccountRow | undefined {
    const account = this.getAccount(id);
    if (!account) return undefined;

    const { sets, params: vals } = buildPatch(changes, ACCOUNT_PATCH);
    if (sets.length === 0) return account;

    sets.push("updated_at = ?");
    vals.push(isoNow());
    vals.push(id);

    this.db.prepare(`UPDATE twitter_accounts SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
    return this.getAccount(id);
  }

  // ── Cookie storage (xactions driver) ──────────────────
  // Cookies live in kernel_vault under key 'x-cookie/<handle>'. The vault is
  // encrypted at rest; this service only stores the vault key reference, not
  // the cookie itself, in twitter_accounts.auth_cookie_ref.

  /** Compute the vault key for a given account. Stable: a re-set re-uses the same key. */
  vaultKeyForAccount(id: string): string | null {
    const account = this.getAccount(id);
    if (!account) return null;
    return vaultKeyFor(account.handle);
  }

  /** Persist that an account now has a cookie in the vault. The caller writes the cookie to vault; this just records the ref. */
  recordCookieRef(id: string): TwitterAccountRow | undefined {
    const account = this.getAccount(id);
    if (!account) return undefined;
    const ref = vaultKeyFor(account.handle);
    this.db
      .prepare(`UPDATE twitter_accounts SET auth_cookie_ref = ?, updated_at = ? WHERE id = ?`)
      .run(ref, isoNow(), id);
    return this.getAccount(id);
  }

  /** Record that x_login succeeded against this cookie. */
  markLoginSuccess(id: string): TwitterAccountRow | undefined {
    const account = this.getAccount(id);
    if (!account) return undefined;
    const now = isoNow();
    this.db
      .prepare(`UPDATE twitter_accounts SET last_login_at = ?, updated_at = ? WHERE id = ?`)
      .run(now, now, id);
    return this.getAccount(id);
  }

  // ── Account state (campaign phase + crisis tracking) ──

  getAccountState(id: string): TwitterAccountStateRow | undefined {
    return this.db
      .prepare("SELECT * FROM twitter_account_state WHERE account_id = ?")
      .get(id) as TwitterAccountStateRow | undefined;
  }

  setPhase(id: string, phase: string): TwitterAccountStateRow | undefined {
    const state = this.getAccountState(id);
    if (!state) return undefined;
    const now = isoNow();
    this.db
      .prepare(
        `UPDATE twitter_account_state SET phase = ?, phase_started_at = ?, updated_at = ? WHERE account_id = ?`,
      )
      .run(phase, now, now, id);
    return this.getAccountState(id);
  }

  triggerCrisisRecovery(id: string, oonPct7d: number, muteRate7d: number): TwitterAccountStateRow | undefined {
    const state = this.getAccountState(id);
    if (!state) return undefined;
    const now = isoNow();
    this.db
      .prepare(
        `UPDATE twitter_account_state
         SET phase = 'crisis_recovery', phase_started_at = ?, crisis_triggered_at = ?,
             oon_pct_7d = ?, mute_rate_7d = ?, updated_at = ?
         WHERE account_id = ?`,
      )
      .run(now, now, oonPct7d, muteRate7d, now, id);
    return this.getAccountState(id);
  }

  updateRollingKpis(id: string, oonPct7d: number, muteRate7d: number): TwitterAccountStateRow | undefined {
    const state = this.getAccountState(id);
    if (!state) return undefined;
    this.db
      .prepare(
        `UPDATE twitter_account_state
         SET oon_pct_7d = ?, mute_rate_7d = ?, updated_at = ?
         WHERE account_id = ?`,
      )
      .run(oonPct7d, muteRate7d, isoNow(), id);
    return this.getAccountState(id);
  }

  // ── Post Management ───────────────────────────────

  createPost(input: {
    account_id: string;
    content: string;
    post_type?: string;
    status?: string;
    scheduled_at?: string;
    reply_to_x_id?: string;
    quote_x_id?: string;
    format?: string;
    signal_target?: string;
    phase?: string;
    campaign_anchor?: number;
    parent_post_id?: string;
  }): TwitterPostRow {
    const now = isoNow();
    const id = newId();

    this.db
      .prepare(
        `INSERT INTO twitter_posts
         (id, account_id, content, post_type, status, scheduled_at, reply_to_x_id, quote_x_id,
          format, signal_target, phase, campaign_anchor, parent_post_id,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.account_id,
        input.content,
        input.post_type ?? "tweet",
        input.status ?? "draft",
        input.scheduled_at ?? null,
        input.reply_to_x_id ?? "",
        input.quote_x_id ?? "",
        input.format ?? "",
        input.signal_target ?? "",
        input.phase ?? "",
        input.campaign_anchor ?? 0,
        input.parent_post_id ?? null,
        now,
        now,
      );

    return this.db.prepare("SELECT * FROM twitter_posts WHERE id = ?").get(id) as TwitterPostRow;
  }

  /** Persist auditor output: score 0-100 and notes. */
  recordAudit(id: string, score: number, notes: string): TwitterPostRow | undefined {
    const post = this.getPost(id);
    if (!post) return undefined;
    this.db
      .prepare(`UPDATE twitter_posts SET audit_score = ?, audit_notes = ?, updated_at = ? WHERE id = ?`)
      .run(score, notes, isoNow(), id);
    return this.getPost(id);
  }

  // ── Per-post analytics snapshots ──────────────────────

  recordAnalyticsSnapshot(input: {
    post_id: string;
    impressions?: number;
    oon_impressions?: number;
    likes?: number;
    retweets?: number;
    replies?: number;
    quotes?: number;
    bookmarks?: number;
    profile_clicks?: number;
    mute_count?: number;
    block_count?: number;
    snapshot_at?: string;
  }): TwitterPostAnalyticsRow {
    const id = newId();
    const now = isoNow();
    const impressions = input.impressions ?? 0;
    const oonImpressions = input.oon_impressions ?? 0;
    const oonPct = impressions > 0 ? oonImpressions / impressions : 0;
    const muteCount = input.mute_count ?? 0;
    const blockCount = input.block_count ?? 0;
    const muteRate = impressions > 0 ? (muteCount + blockCount) / impressions : 0;
    const engagements =
      (input.likes ?? 0) + (input.retweets ?? 0) + (input.replies ?? 0) +
      (input.quotes ?? 0) + (input.bookmarks ?? 0);
    const engagementRate = impressions > 0 ? engagements / impressions : 0;

    this.db
      .prepare(
        `INSERT INTO twitter_post_analytics
         (id, post_id, snapshot_at, impressions, oon_impressions, oon_pct,
          likes, retweets, replies, quotes, bookmarks, profile_clicks,
          mute_count, block_count, mute_rate, engagement_rate, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.post_id,
        input.snapshot_at ?? now,
        impressions,
        oonImpressions,
        oonPct,
        input.likes ?? 0,
        input.retweets ?? 0,
        input.replies ?? 0,
        input.quotes ?? 0,
        input.bookmarks ?? 0,
        input.profile_clicks ?? 0,
        muteCount,
        blockCount,
        muteRate,
        engagementRate,
        now,
      );

    return this.db
      .prepare("SELECT * FROM twitter_post_analytics WHERE id = ?")
      .get(id) as TwitterPostAnalyticsRow;
  }

  /** Latest analytics snapshot per post; used by the Engagement Tracker. */
  listLatestAnalytics(accountId: string, days: number = 7): TwitterPostAnalyticsRow[] {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    return this.db
      .prepare(
        `SELECT a.* FROM twitter_post_analytics a
         JOIN twitter_posts p ON p.id = a.post_id
         WHERE p.account_id = ? AND a.snapshot_at >= ?
         AND a.id IN (
           SELECT id FROM twitter_post_analytics a2
           WHERE a2.post_id = a.post_id
           ORDER BY a2.snapshot_at DESC LIMIT 1
         )
         ORDER BY a.snapshot_at DESC`,
      )
      .all(accountId, since) as TwitterPostAnalyticsRow[];
  }

  /** Compute rolling OON % and mute rate over the last N days for an account. */
  computeRollingKpis(accountId: string, days: number = 7): { oon_pct_7d: number; mute_rate_7d: number } {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(a.impressions), 0)     AS imp,
           COALESCE(SUM(a.oon_impressions), 0) AS oon,
           COALESCE(SUM(a.mute_count), 0)      AS mutes,
           COALESCE(SUM(a.block_count), 0)     AS blocks
         FROM twitter_post_analytics a
         JOIN twitter_posts p ON p.id = a.post_id
         WHERE p.account_id = ? AND a.snapshot_at >= ?`,
      )
      .get(accountId, since) as { imp: number; oon: number; mutes: number; blocks: number };

    const oonPct = row.imp > 0 ? row.oon / row.imp : 0;
    const muteRate = row.imp > 0 ? (row.mutes + row.blocks) / row.imp : 0;
    return { oon_pct_7d: oonPct, mute_rate_7d: muteRate };
  }

  updatePost(
    id: string,
    changes: Partial<{
      content: string;
      post_type: string;
      status: string;
      scheduled_at: string | null;
      reply_to_x_id: string;
      quote_x_id: string;
      error_message: string;
    }>,
  ): TwitterPostRow | undefined {
    const post = this.getPost(id);
    if (!post) return undefined;

    const { sets, params: vals } = buildPatch(changes, POST_PATCH);
    if (sets.length === 0) return post;

    sets.push("updated_at = ?");
    vals.push(isoNow());
    vals.push(id);

    this.db.prepare(`UPDATE twitter_posts SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
    return this.getPost(id);
  }

  getPost(id: string): TwitterPostRow | undefined {
    return this.db.prepare("SELECT * FROM twitter_posts WHERE id = ?").get(id) as TwitterPostRow | undefined;
  }

  listPosts(opts?: {
    status?: string;
    account_id?: string;
    post_type?: string;
    limit?: number;
    offset?: number;
  }): TwitterPostRow[] {
    const wheres: string[] = [];
    const vals: unknown[] = [];

    if (opts?.status) { wheres.push("status = ?"); vals.push(opts.status); }
    if (opts?.account_id) { wheres.push("account_id = ?"); vals.push(opts.account_id); }
    if (opts?.post_type) { wheres.push("post_type = ?"); vals.push(opts.post_type); }

    const where = wheres.length > 0 ? `WHERE ${wheres.join(" AND ")}` : "";
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;

    return this.db
      .prepare(`SELECT * FROM twitter_posts ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...vals, limit, offset) as TwitterPostRow[];
  }

  approvePost(id: string): TwitterPostRow | undefined {
    const post = this.getPost(id);
    if (!post) return undefined;
    if (post.status !== "queued" && post.status !== "draft") return undefined;

    this.db
      .prepare("UPDATE twitter_posts SET status = 'approved', updated_at = ? WHERE id = ?")
      .run(isoNow(), id);
    return this.getPost(id);
  }

  getQueue(accountId?: string): TwitterPostRow[] {
    if (accountId) {
      return this.db
        .prepare("SELECT * FROM twitter_posts WHERE status = 'queued' AND account_id = ? ORDER BY scheduled_at, created_at")
        .all(accountId) as TwitterPostRow[];
    }
    return this.db
      .prepare("SELECT * FROM twitter_posts WHERE status = 'queued' ORDER BY scheduled_at, created_at")
      .all() as TwitterPostRow[];
  }

  publishPost(id: string, xPostId: string): TwitterPostRow | undefined {
    const post = this.getPost(id);
    if (!post) return undefined;

    const now = isoNow();
    this.db
      .prepare(
        "UPDATE twitter_posts SET status = 'posted', x_post_id = ?, posted_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(xPostId, now, now, id);
    return this.getPost(id);
  }

  deletePost(id: string): boolean {
    const result = this.db.prepare("DELETE FROM twitter_posts WHERE id = ?").run(id);
    return result.changes > 0;
  }

  updatePostMetrics(
    id: string,
    metrics: { impressions: number; likes: number; retweets: number; replies: number },
  ): void {
    this.db
      .prepare(
        `UPDATE twitter_posts SET
           metrics_impressions = ?, metrics_likes = ?, metrics_retweets = ?, metrics_replies = ?,
           updated_at = ?
         WHERE id = ?`,
      )
      .run(metrics.impressions, metrics.likes, metrics.retweets, metrics.replies, isoNow(), id);
  }

  // ── Mention Tracking ──────────────────────────────

  addMention(input: {
    account_id: string;
    x_post_id: string;
    author_handle: string;
    author_name?: string;
    content: string;
    detected_at?: string;
  }): TwitterMentionRow {
    const now = isoNow();
    const id = newId();

    this.db
      .prepare(
        `INSERT INTO twitter_mentions (id, account_id, x_post_id, author_handle, author_name, content, detected_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.account_id,
        input.x_post_id,
        input.author_handle,
        input.author_name ?? "",
        input.content,
        input.detected_at ?? now,
        now,
      );

    return this.db.prepare("SELECT * FROM twitter_mentions WHERE id = ?").get(id) as TwitterMentionRow;
  }

  listMentions(opts?: {
    account_id?: string;
    unread_only?: boolean;
    limit?: number;
    offset?: number;
  }): TwitterMentionRow[] {
    const wheres: string[] = [];
    const vals: unknown[] = [];

    if (opts?.account_id) { wheres.push("account_id = ?"); vals.push(opts.account_id); }
    if (opts?.unread_only) { wheres.push("replied = 0"); }

    const where = wheres.length > 0 ? `WHERE ${wheres.join(" AND ")}` : "";
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;

    return this.db
      .prepare(`SELECT * FROM twitter_mentions ${where} ORDER BY detected_at DESC LIMIT ? OFFSET ?`)
      .all(...vals, limit, offset) as TwitterMentionRow[];
  }

  markMentionReplied(mentionId: string, replyPostId: string): boolean {
    const result = this.db
      .prepare("UPDATE twitter_mentions SET replied = 1, reply_post_id = ? WHERE id = ?")
      .run(replyPostId, mentionId);
    return result.changes > 0;
  }

  // ── Metrics ───────────────────────────────────────

  snapshotMetrics(input: {
    account_id: string;
    followers: number;
    following: number;
    tweets_count: number;
    snapshot_date?: string;
  }): TwitterMetricsSnapshotRow {
    const now = isoNow();
    const id = newId();
    const snapshotDate = input.snapshot_date ?? now.slice(0, 10);

    this.db
      .prepare(
        `INSERT INTO twitter_metrics_snapshots (id, account_id, followers, following, tweets_count, snapshot_date, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.account_id, input.followers, input.following, input.tweets_count, snapshotDate, now);

    return this.db.prepare("SELECT * FROM twitter_metrics_snapshots WHERE id = ?").get(id) as TwitterMetricsSnapshotRow;
  }

  getMetricsTrend(accountId: string, days: number = 30): TwitterMetricsSnapshotRow[] {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return this.db
      .prepare(
        "SELECT * FROM twitter_metrics_snapshots WHERE account_id = ? AND snapshot_date >= ? ORDER BY snapshot_date",
      )
      .all(accountId, since) as TwitterMetricsSnapshotRow[];
  }

  // ── Performance Report ────────────────────────────

  getPerformanceReport(accountId: string, days: number = 30): {
    total_posts: number;
    total_impressions: number;
    total_likes: number;
    total_retweets: number;
    total_replies: number;
    avg_impressions: number;
    avg_likes: number;
    avg_retweets: number;
    avg_replies: number;
    top_posts: TwitterPostRow[];
    posts_by_type: Array<{ post_type: string; count: number }>;
    posts_by_status: Array<{ status: string; count: number }>;
  } {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const agg = this.db
      .prepare(
        `SELECT
           COUNT(*) as total_posts,
           COALESCE(SUM(metrics_impressions), 0) as total_impressions,
           COALESCE(SUM(metrics_likes), 0) as total_likes,
           COALESCE(SUM(metrics_retweets), 0) as total_retweets,
           COALESCE(SUM(metrics_replies), 0) as total_replies,
           COALESCE(AVG(metrics_impressions), 0) as avg_impressions,
           COALESCE(AVG(metrics_likes), 0) as avg_likes,
           COALESCE(AVG(metrics_retweets), 0) as avg_retweets,
           COALESCE(AVG(metrics_replies), 0) as avg_replies
         FROM twitter_posts
         WHERE account_id = ? AND status = 'posted' AND posted_at >= ?`,
      )
      .get(accountId, since) as {
      total_posts: number;
      total_impressions: number;
      total_likes: number;
      total_retweets: number;
      total_replies: number;
      avg_impressions: number;
      avg_likes: number;
      avg_retweets: number;
      avg_replies: number;
    };

    const topPosts = this.db
      .prepare(
        `SELECT * FROM twitter_posts
         WHERE account_id = ? AND status = 'posted' AND posted_at >= ?
         ORDER BY (metrics_likes + metrics_retweets + metrics_replies) DESC
         LIMIT 5`,
      )
      .all(accountId, since) as TwitterPostRow[];

    const postsByType = this.db
      .prepare(
        `SELECT post_type, COUNT(*) as count
         FROM twitter_posts
         WHERE account_id = ? AND posted_at >= ?
         GROUP BY post_type ORDER BY count DESC`,
      )
      .all(accountId, since) as Array<{ post_type: string; count: number }>;

    const postsByStatus = this.db
      .prepare(
        `SELECT status, COUNT(*) as count
         FROM twitter_posts
         WHERE account_id = ?
         GROUP BY status ORDER BY count DESC`,
      )
      .all(accountId) as Array<{ status: string; count: number }>;

    return {
      ...agg,
      top_posts: topPosts,
      posts_by_type: postsByType,
      posts_by_status: postsByStatus,
    };
  }
}
