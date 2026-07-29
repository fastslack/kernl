import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { tableExists, safeAll, queryWithFallback, toRecord, today } from "../../../../../src/core/db/query-helpers.js";

// ── Communications ───────────────────────────────────

export interface DashboardComms {
  kpis: {
    total: number; drafts: number; sent: number; failed: number;
    archived: number; scheduled: number; channelsActive: number;
    threadCount: number; inbound: number; outbound: number;
  };
  pendingDrafts: Array<{
    id: string; channel: string; subject: string; recipients_to: string;
    updated_at: string; contact_name: string; has_attachments: boolean;
    account_label: string; age_hours: number;
  }>;
  recentSent: Array<{
    id: string; channel: string; subject: string; recipients_to: string;
    sent_at: string; contact_name: string; direction: string; account_label: string;
  }>;
  byChannel: Record<string, number>;
  byStatus: Record<string, number>;
  byDirection: Record<string, number>;
  failedMessages: Array<{
    id: string; channel: string; subject: string; recipients_to: string;
    error_message: string; contact_name: string; updated_at: string;
  }>;
  scheduledMessages: Array<{
    id: string; channel: string; subject: string; recipients_to: string;
    scheduled_at: string; contact_name: string;
  }>;
  velocity: Array<{ week: string; sent: number; received: number }>;
  threads: Array<{
    thread_id: string; subject: string; message_count: number;
    last_activity: string; contact_name: string;
  }>;
  topContacts: Array<{
    contact_id: string; name: string; total: number;
    sent_count: number; received_count: number; last_comm: string;
  }>;
  recentActivity: Array<{
    id: string; channel: string; subject: string; direction: string;
    status: string; contact_name: string; updated_at: string;
  }>;
  accounts?: Array<{
    id: string; label: string; email: string; type: string; provider: string;
    sent_count: number; failed_count: number; draft_count: number;
  }>;
  templates?: {
    total: number; byCategory: Record<string, number>;
    recent: Array<{ id: string; name: string; category: string; updated_at: string }>;
  };
  campaigns?: {
    total: number;
    byStatus: Record<string, number>;
    recent: Array<{
      id: string; name: string; status: string;
      total_recipients: number; sent_count: number; failed_count: number;
      created_at: string; template_name: string; account_label: string;
      completion_pct: number;
    }>;
  };
}

export function queryComms(db: SqliteDb): DashboardComms | null {
  if (!tableExists(db, "communications")) return null;
  {
    const todayStr = today();

    // ── Expanded KPIs ──
    const stats = db
      .prepare(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) as drafts,
           SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
           SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) as archived,
           SUM(CASE WHEN scheduled_at IS NOT NULL AND status IN ('draft','ready') THEN 1 ELSE 0 END) as scheduled,
           COUNT(DISTINCT channel) as channelsActive,
           COUNT(DISTINCT CASE WHEN thread_id <> '' AND thread_id <> id THEN thread_id END) as threadCount,
           SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END) as inbound,
           SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) as outbound
         FROM communications`,
      )
      .get() as {
        total: number; drafts: number; sent: number; failed: number;
        archived: number; scheduled: number; channelsActive: number;
        threadCount: number; inbound: number; outbound: number;
      };

    // ── Enhanced drafts with contact names, attachment info, age ──
    const pendingDrafts = queryWithFallback<DashboardComms["pendingDrafts"][number]>(db,
      `SELECT c.id, c.channel, c.subject, c.recipients_to, c.updated_at,
              COALESCE(ct.name, '') as contact_name,
              (EXISTS(SELECT 1 FROM comm_attachments ca WHERE ca.comm_id = c.id)) as has_attachments,
              COALESCE(ea.label, '') as account_label,
              ROUND((julianday('now') - julianday(c.created_at)) * 24) as age_hours
       FROM communications c
       LEFT JOIN contacts ct ON ct.id = c.contact_id
       LEFT JOIN email_accounts ea ON ea.id = c.account_id
       WHERE c.status IN ('draft', 'ready')
       ORDER BY c.updated_at DESC LIMIT 10`,
      `SELECT id, channel, subject, recipients_to, updated_at,
              '' as contact_name, 0 as has_attachments, '' as account_label,
              ROUND((julianday('now') - julianday(created_at)) * 24) as age_hours
       FROM communications WHERE status IN ('draft', 'ready')
       ORDER BY updated_at DESC LIMIT 10`,
    );

    // ── Enhanced sent with contact names, direction, account ──
    const recentSent = queryWithFallback<DashboardComms["recentSent"][number]>(db,
      `SELECT c.id, c.channel, c.subject, c.recipients_to, c.sent_at,
              COALESCE(ct.name, '') as contact_name,
              c.direction,
              COALESCE(ea.label, '') as account_label
       FROM communications c
       LEFT JOIN contacts ct ON ct.id = c.contact_id
       LEFT JOIN email_accounts ea ON ea.id = c.account_id
       WHERE c.status = 'sent'
       ORDER BY c.sent_at DESC LIMIT 10`,
      `SELECT id, channel, subject, recipients_to, sent_at,
              '' as contact_name, direction, '' as account_label
       FROM communications WHERE status = 'sent'
       ORDER BY sent_at DESC LIMIT 10`,
    );

    const byChannel = toRecord(
      db
        .prepare(`SELECT channel as key, COUNT(*) as count FROM communications GROUP BY channel`)
        .all() as Array<{ key: string; count: number }>,
    );

    const byStatus = toRecord(
      db
        .prepare(`SELECT status as key, COUNT(*) as count FROM communications GROUP BY status`)
        .all() as Array<{ key: string; count: number }>,
    );

    const byDirection = toRecord(
      db
        .prepare(`SELECT direction as key, COUNT(*) as count FROM communications GROUP BY direction`)
        .all() as Array<{ key: string; count: number }>,
    );

    // ── Failed messages ──
    const failedMessages = queryWithFallback<DashboardComms["failedMessages"][number]>(db,
      `SELECT c.id, c.channel, c.subject, c.recipients_to, c.error_message,
              COALESCE(ct.name, '') as contact_name, c.updated_at
       FROM communications c
       LEFT JOIN contacts ct ON ct.id = c.contact_id
       WHERE c.status = 'failed'
       ORDER BY c.updated_at DESC LIMIT 10`,
      `SELECT id, channel, subject, recipients_to, error_message,
              '' as contact_name, updated_at
       FROM communications WHERE status = 'failed'
       ORDER BY updated_at DESC LIMIT 10`,
    );

    // ── Scheduled messages ──
    const scheduledMessages = queryWithFallback<DashboardComms["scheduledMessages"][number]>(db,
      `SELECT c.id, c.channel, c.subject, c.recipients_to, c.scheduled_at,
              COALESCE(ct.name, '') as contact_name
       FROM communications c
       LEFT JOIN contacts ct ON ct.id = c.contact_id
       WHERE c.scheduled_at IS NOT NULL AND c.status IN ('draft','ready')
       ORDER BY c.scheduled_at ASC LIMIT 10`,
      `SELECT id, channel, subject, recipients_to, scheduled_at,
              '' as contact_name
       FROM communications
       WHERE scheduled_at IS NOT NULL AND status IN ('draft','ready')
       ORDER BY scheduled_at ASC LIMIT 10`,
    );

    // ── Velocity (8 weeks): sent outbound vs received inbound ──
    const velocity = db
      .prepare(
        `WITH RECURSIVE weeks(n, week_start) AS (
           SELECT 0, date(?, '-6 days', 'weekday 1', '-49 days')
           UNION ALL
           SELECT n+1, date(week_start, '+7 days') FROM weeks WHERE n < 7
         )
         SELECT
           w.week_start AS week,
           COALESCE(SUM(CASE WHEN c.direction = 'outbound' AND c.status = 'sent'
             AND c.sent_at >= w.week_start AND c.sent_at < date(w.week_start, '+7 days') THEN 1 ELSE 0 END), 0) AS sent,
           COALESCE(SUM(CASE WHEN c.direction = 'inbound'
             AND c.created_at >= w.week_start AND c.created_at < date(w.week_start, '+7 days') THEN 1 ELSE 0 END), 0) AS received
         FROM weeks w
         LEFT JOIN communications c ON 1=1
         GROUP BY w.week_start
         ORDER BY w.week_start`,
      )
      .all(todayStr) as DashboardComms["velocity"];

    // ── Active threads (grouped by thread_id, >1 message) ──
    const threads = queryWithFallback<DashboardComms["threads"][number]>(db,
      `SELECT c.thread_id,
              MIN(c.subject) as subject,
              COUNT(*) as message_count,
              MAX(COALESCE(c.sent_at, c.updated_at)) as last_activity,
              COALESCE(MIN(ct.name), '') as contact_name
       FROM communications c
       LEFT JOIN contacts ct ON ct.id = c.contact_id
       WHERE c.thread_id <> '' AND c.thread_id <> c.id
       GROUP BY c.thread_id
       HAVING COUNT(*) > 1
       ORDER BY last_activity DESC LIMIT 15`,
      `SELECT thread_id, MIN(subject) as subject, COUNT(*) as message_count,
              MAX(COALESCE(sent_at, updated_at)) as last_activity, '' as contact_name
       FROM communications
       WHERE thread_id <> '' AND thread_id <> id
       GROUP BY thread_id HAVING COUNT(*) > 1
       ORDER BY last_activity DESC LIMIT 15`,
    );

    // ── Top contacts by comm volume ──
    const topContacts = safeAll<DashboardComms["topContacts"][number]>(db,
      `SELECT c.contact_id,
              ct.name,
              COUNT(*) as total,
              SUM(CASE WHEN c.direction = 'outbound' THEN 1 ELSE 0 END) as sent_count,
              SUM(CASE WHEN c.direction = 'inbound' THEN 1 ELSE 0 END) as received_count,
              MAX(COALESCE(c.sent_at, c.updated_at)) as last_comm
       FROM communications c
       JOIN contacts ct ON ct.id = c.contact_id
       WHERE c.contact_id IS NOT NULL AND c.contact_id <> ''
       GROUP BY c.contact_id
       ORDER BY total DESC LIMIT 10`,
    );

    // ── Recent activity (last 20 of any status) ──
    const recentActivity = queryWithFallback<DashboardComms["recentActivity"][number]>(db,
      `SELECT c.id, c.channel, c.subject, c.direction, c.status,
              COALESCE(ct.name, '') as contact_name,
              c.updated_at
       FROM communications c
       LEFT JOIN contacts ct ON ct.id = c.contact_id
       ORDER BY c.updated_at DESC LIMIT 20`,
      `SELECT id, channel, subject, direction, status,
              '' as contact_name, updated_at
       FROM communications ORDER BY updated_at DESC LIMIT 20`,
    );

    const result: DashboardComms = {
      kpis: {
        total: stats.total ?? 0,
        drafts: stats.drafts ?? 0,
        sent: stats.sent ?? 0,
        failed: stats.failed ?? 0,
        archived: stats.archived ?? 0,
        scheduled: stats.scheduled ?? 0,
        channelsActive: stats.channelsActive ?? 0,
        threadCount: stats.threadCount ?? 0,
        inbound: stats.inbound ?? 0,
        outbound: stats.outbound ?? 0,
      },
      pendingDrafts,
      recentSent,
      byChannel,
      byStatus,
      byDirection,
      failedMessages,
      scheduledMessages,
      velocity,
      threads,
      topContacts,
      recentActivity,
    };

    // ── Email accounts (optional, Fase 2 table) ──
    const accountsRows = safeAll<NonNullable<DashboardComms["accounts"]>[number]>(db,
      `SELECT ea.id, ea.label, ea.email, ea.type, ea.provider,
              COALESCE(s.sent_count, 0) as sent_count,
              COALESCE(f.failed_count, 0) as failed_count,
              COALESCE(d.draft_count, 0) as draft_count
       FROM email_accounts ea
       LEFT JOIN (
         SELECT account_id, COUNT(*) as sent_count
         FROM communications WHERE status = 'sent' AND account_id IS NOT NULL
         GROUP BY account_id
       ) s ON s.account_id = ea.id
       LEFT JOIN (
         SELECT account_id, COUNT(*) as failed_count
         FROM communications WHERE status = 'failed' AND account_id IS NOT NULL
         GROUP BY account_id
       ) f ON f.account_id = ea.id
       LEFT JOIN (
         SELECT account_id, COUNT(*) as draft_count
         FROM communications WHERE status = 'draft' AND account_id IS NOT NULL
         GROUP BY account_id
       ) d ON d.account_id = ea.id
       ORDER BY ea.is_default DESC, ea.label`,
    );
    if (accountsRows.length > 0) result.accounts = accountsRows;

    // ── Templates (optional, Fase 2 table) ──
    if (tableExists(db, "email_templates")) {
      const tplTotal = (db.prepare("SELECT COUNT(*) as c FROM email_templates").get() as { c: number }).c;
      const tplByCategory = toRecord(
        db
          .prepare("SELECT category as key, COUNT(*) as count FROM email_templates GROUP BY category")
          .all() as Array<{ key: string; count: number }>,
      );
      const tplRecent = db
        .prepare(
          `SELECT id, name, category, updated_at FROM email_templates
           ORDER BY updated_at DESC LIMIT 5`,
        )
        .all() as NonNullable<DashboardComms["templates"]>["recent"];
      result.templates = { total: tplTotal, byCategory: tplByCategory, recent: tplRecent };
    }

    // ── Campaigns (optional, Fase 2 table) ──
    if (tableExists(db, "email_campaigns")) {
      const campTotal = (db.prepare("SELECT COUNT(*) as c FROM email_campaigns").get() as { c: number }).c;
      const campByStatus = toRecord(
        db
          .prepare("SELECT status as key, COUNT(*) as count FROM email_campaigns GROUP BY status")
          .all() as Array<{ key: string; count: number }>,
      );
      const campRecent = db
        .prepare(
          `SELECT ec.id, ec.name, ec.status, ec.total_recipients, ec.sent_count, ec.failed_count,
                  ec.created_at,
                  COALESCE(et.name, '') as template_name,
                  COALESCE(ea.label, '') as account_label,
                  CASE WHEN ec.total_recipients > 0
                    THEN ROUND(CAST(ec.sent_count AS REAL) / ec.total_recipients * 100)
                    ELSE 0 END as completion_pct
           FROM email_campaigns ec
           LEFT JOIN email_templates et ON et.id = ec.template_id
           LEFT JOIN email_accounts ea ON ea.id = ec.account_id
           ORDER BY ec.created_at DESC LIMIT 10`,
        )
        .all() as NonNullable<DashboardComms["campaigns"]>["recent"];
      result.campaigns = { total: campTotal, byStatus: campByStatus, recent: campRecent };
    }

    return result;
  }
}
