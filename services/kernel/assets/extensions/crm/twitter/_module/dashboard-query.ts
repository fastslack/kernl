import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";

export function queryTwitter(db: SqliteDb): Record<string, unknown> {
  try {
    const accounts = db.prepare("SELECT * FROM twitter_accounts ORDER BY handle").all() as Array<Record<string, unknown>>;

    const postsByStatus = db
      .prepare(
        `SELECT status, COUNT(*) as count FROM twitter_posts GROUP BY status ORDER BY count DESC`,
      )
      .all() as Array<{ status: string; count: number }>;

    const postsByType = db
      .prepare(
        `SELECT post_type, COUNT(*) as count FROM twitter_posts GROUP BY post_type ORDER BY count DESC`,
      )
      .all() as Array<{ post_type: string; count: number }>;

    const recentPosts = db
      .prepare(
        `SELECT p.*, a.handle as account_handle
         FROM twitter_posts p
         LEFT JOIN twitter_accounts a ON a.id = p.account_id
         ORDER BY p.created_at DESC LIMIT 20`,
      )
      .all() as Array<Record<string, unknown>>;

    const queueCount = db
      .prepare("SELECT COUNT(*) as count FROM twitter_posts WHERE status IN ('queued','approved')")
      .get() as { count: number };

    const draftCount = db
      .prepare("SELECT COUNT(*) as count FROM twitter_posts WHERE status = 'draft'")
      .get() as { count: number };

    const postedCount = db
      .prepare("SELECT COUNT(*) as count FROM twitter_posts WHERE status = 'posted'")
      .get() as { count: number };

    const failedCount = db
      .prepare("SELECT COUNT(*) as count FROM twitter_posts WHERE status = 'failed'")
      .get() as { count: number };

    const totalLikes = db
      .prepare("SELECT COALESCE(SUM(metrics_likes),0) as total FROM twitter_posts WHERE status = 'posted'")
      .get() as { total: number };

    const totalImpressions = db
      .prepare("SELECT COALESCE(SUM(metrics_impressions),0) as total FROM twitter_posts WHERE status = 'posted'")
      .get() as { total: number };

    const unreadMentions = db
      .prepare("SELECT COUNT(*) as count FROM twitter_mentions WHERE replied = 0")
      .get() as { count: number };

    // Recent mentions
    const recentMentions = db
      .prepare(
        `SELECT m.*, a.handle as account_handle
         FROM twitter_mentions m
         LEFT JOIN twitter_accounts a ON a.id = m.account_id
         ORDER BY m.detected_at DESC LIMIT 10`,
      )
      .all() as Array<Record<string, unknown>>;

    // Metrics trends (latest snapshot per account)
    const latestMetrics = db
      .prepare(
        `SELECT ms.*, a.handle as account_handle
         FROM twitter_metrics_snapshots ms
         LEFT JOIN twitter_accounts a ON a.id = ms.account_id
         WHERE ms.snapshot_date = (
           SELECT MAX(ms2.snapshot_date) FROM twitter_metrics_snapshots ms2 WHERE ms2.account_id = ms.account_id
         )
         ORDER BY a.handle`,
      )
      .all() as Array<Record<string, unknown>>;

    // Posts today
    const today = new Date().toISOString().slice(0, 10);
    const postedToday = db
      .prepare(
        `SELECT COUNT(*) as count FROM twitter_posts WHERE status = 'posted' AND posted_at >= ?`,
      )
      .get(today) as { count: number };

    // Scheduled posts (future)
    const scheduledPosts = db
      .prepare(
        `SELECT p.*, a.handle as account_handle
         FROM twitter_posts p
         LEFT JOIN twitter_accounts a ON a.id = p.account_id
         WHERE p.status IN ('queued','approved') AND p.scheduled_at IS NOT NULL AND p.scheduled_at > ?
         ORDER BY p.scheduled_at LIMIT 10`,
      )
      .all(new Date().toISOString()) as Array<Record<string, unknown>>;

    return {
      accounts,
      kpis: {
        accounts: accounts.length,
        activeAccounts: accounts.filter((a: any) => a.status === "active").length,
        drafts: draftCount.count,
        queued: queueCount.count,
        posted: postedCount.count,
        failed: failedCount.count,
        postedToday: postedToday.count,
        totalLikes: totalLikes.total,
        totalImpressions: totalImpressions.total,
        unreadMentions: unreadMentions.count,
      },
      postsByStatus,
      postsByType,
      recentPosts,
      recentMentions,
      latestMetrics,
      scheduledPosts,
    };
  } catch {
    return {
      accounts: [],
      kpis: {
        accounts: 0, activeAccounts: 0, drafts: 0, queued: 0,
        posted: 0, failed: 0, postedToday: 0,
        totalLikes: 0, totalImpressions: 0, unreadMentions: 0,
      },
      postsByStatus: [],
      postsByType: [],
      recentPosts: [],
      recentMentions: [],
      latestMetrics: [],
      scheduledPosts: [],
    };
  }
}
