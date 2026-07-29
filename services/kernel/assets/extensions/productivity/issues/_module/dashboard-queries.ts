import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { tableExists, safeAll, safeGet, toRecord, today, daysFromNow } from "../../../../../src/core/db/query-helpers.js";

// ── Issues ───────────────────────────────────────────

export interface VelocityWeek {
  week: string;
  opened: number;
  closed: number;
  netChange: number;
}

export interface MilestoneProgress {
  milestone: string;
  total: number;
  open: number;
  closed: number;
  progressPct: number;
}

export interface AssigneeWorkload {
  assignee: string;
  openCount: number;
  estimateHours: number;
  spentHours: number;
}

export interface AgeAnalysis {
  avgCloseTimeDays: number;
  buckets: Array<{ label: string; count: number }>;
}

export interface StaleIssue {
  id: string;
  title: string;
  repo: string;
  updated_at: string;
  daysSinceUpdate: number;
}

export interface ActivityDay {
  day: number;
  dayName: string;
  created: number;
  closed: number;
}

export interface TimeByGroup {
  group: string;
  estimate: number;
  spent: number;
  burnRate: number;
}

export interface OverBudgetIssue {
  title: string;
  repo: string;
  estimate: number;
  spent: number;
  overBy: number;
}

export interface LabelTrend {
  label: string;
  thisWeek: number;
  lastWeek: number;
  change: number;
}

export interface ScopedDimension {
  scope: string;
  values: Array<{ value: string; total: number; open: number }>;
}

export interface WorkflowFunnel {
  stages: Array<{ name: string; count: number; pct: number }>;
  bottleneck: string | null;
}

export interface PriorityMatrix {
  byPriority: Array<{
    priority: string;
    open: number;
    closed: number;
    avgAgeDays: number;
    staleCount: number;
  }>;
  criticalOpen: number;
}

export interface RepoHealthEntry {
  repo: string;
  open: number;
  staleCount: number;
  stalePct: number;
  criticalOpen: number;
  avgAgeDays: number;
  healthScore: number;
}

export interface BacklogHealth {
  score: number;
  grade: string;
  factors: Array<{
    name: string;
    value: number;
    status: string;
    detail: string;
  }>;
}

export interface PersonalWorkload {
  assignee: string;
  openCount: number;
  byPriority: Record<string, number>;
  byType: Record<string, number>;
  byRepo: Array<{ repo: string; count: number }>;
  staleCount: number;
}

export interface ConfiguredProvider {
  provider: string;
  username: string;
  baseUrl: string;
  lastSync: string | null;
  repoCount: number;
}

export interface DashboardIssues {
  kpis: { total: number; open: number; closed: number; prs: number };
  providers: ConfiguredProvider[];
  byState: Array<{ state: string; count: number }>;
  byRepo: Array<{ repo: string; open: number; closed: number }>;
  byProvider: Array<{ provider: string; count: number }>;
  byLabel: Array<{ label: string; count: number }>;
  recentlyClosed: Array<{ title: string; repo: string; closed_at: string }>;
  timeTracking: { totalEstimate: number; totalSpent: number };
  velocity: VelocityWeek[];
  milestones: MilestoneProgress[];
  assigneeWorkload: AssigneeWorkload[];
  ageAnalysis: AgeAnalysis;
  staleIssues: StaleIssue[];
  activityHeatmap: ActivityDay[];
  timeByRepo: TimeByGroup[];
  timeByAssignee: TimeByGroup[];
  overBudget: OverBudgetIssue[];
  labelTrends: LabelTrend[];
  avgCloseTimeDays: number;
  staleCount: number;
  scopedDimensions: ScopedDimension[];
  workflowFunnel: WorkflowFunnel;
  priorityMatrix: PriorityMatrix;
  repoHealth: RepoHealthEntry[];
  backlogHealth: BacklogHealth;
  typeBreakdown: Array<{ type: string; open: number; closed: number }>;
  envBreakdown: Array<{ env: string; open: number; closed: number }>;
  personalWorkload: PersonalWorkload | null;
  insights: string[];
}

function issuesTableExists(db: SqliteDb): boolean {
  return tableExists(db, "issues");
}

// ── Scoped Label Intelligence ────────────────────────

export function parseScopedLabels(db: SqliteDb): ScopedDimension[] {
  const rows = db
    .prepare(
      `SELECT il.label,
              COUNT(*) as total,
              SUM(CASE WHEN i.state = 'open' THEN 1 ELSE 0 END) as open_count
       FROM issue_labels il
       JOIN issues i ON il.issue_id = i.id
       GROUP BY il.label
       ORDER BY total DESC`,
    )
    .all() as Array<{ label: string; total: number; open_count: number }>;

  const scopeMap = new Map<string, Array<{ value: string; total: number; open: number }>>();

  for (const row of rows) {
    const idx = row.label.indexOf("::");
    if (idx < 0) continue;
    const scope = row.label.slice(0, idx);
    const value = row.label.slice(idx + 2);
    if (!scopeMap.has(scope)) scopeMap.set(scope, []);
    scopeMap.get(scope)!.push({ value, total: row.total, open: row.open_count });
  }

  return Array.from(scopeMap.entries()).map(([scope, values]) => ({ scope, values }));
}

function buildWorkflowFunnel(db: SqliteDb): WorkflowFunnel {
  const stageOrder = ["Ready to start", "Working on it", "Ready to test", "Done"];
  const rows = db
    .prepare(
      `SELECT REPLACE(il.label, 'Status::', '') AS stage, COUNT(*) AS count
       FROM issue_labels il
       JOIN issues i ON il.issue_id = i.id
       WHERE il.label LIKE 'Status::%'
       GROUP BY stage`,
    )
    .all() as Array<{ stage: string; count: number }>;

  const stageMap = new Map<string, number>();
  for (const r of rows) stageMap.set(r.stage, r.count);

  const total = rows.reduce((s, r) => s + r.count, 0) || 1;
  const stages = stageOrder
    .filter((s) => stageMap.has(s))
    .map((name) => {
      const count = stageMap.get(name) ?? 0;
      return { name, count, pct: Math.round((count / total) * 100) };
    });

  // Add any Status:: values not in stageOrder
  for (const r of rows) {
    if (!stageOrder.includes(r.stage)) {
      stages.push({ name: r.stage, count: r.count, pct: Math.round((r.count / total) * 100) });
    }
  }

  // Bottleneck = stage with most issues excluding "Done"
  let bottleneck: string | null = null;
  let maxCount = 0;
  for (const s of stages) {
    if (s.name !== "Done" && s.count > maxCount) {
      maxCount = s.count;
      bottleneck = s.name;
    }
  }

  return { stages, bottleneck };
}

function buildPriorityMatrix(db: SqliteDb, todayStr: string): PriorityMatrix {
  const rows = db
    .prepare(
      `SELECT REPLACE(il.label, 'PRI::', '') AS priority,
              SUM(CASE WHEN i.state = 'open' THEN 1 ELSE 0 END) AS open,
              SUM(CASE WHEN i.state IN ('closed','merged') THEN 1 ELSE 0 END) AS closed,
              AVG(CASE WHEN i.state = 'open' THEN julianday(?) - julianday(i.created_at) ELSE NULL END) AS avgAge,
              SUM(CASE WHEN i.state = 'open' AND julianday(?) - julianday(i.updated_at) >= 14 THEN 1 ELSE 0 END) AS staleCount
       FROM issue_labels il
       JOIN issues i ON il.issue_id = i.id
       WHERE il.label LIKE 'PRI::%'
       GROUP BY priority`,
    )
    .all(todayStr, todayStr) as Array<{
    priority: string;
    open: number;
    closed: number;
    avgAge: number | null;
    staleCount: number;
  }>;

  const order = ["CRITICAL", "1", "2", "3"];
  const sorted = rows.sort((a, b) => {
    const ai = order.indexOf(a.priority);
    const bi = order.indexOf(b.priority);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });

  const byPriority = sorted.map((r) => ({
    priority: r.priority,
    open: r.open,
    closed: r.closed,
    avgAgeDays: Math.round((r.avgAge ?? 0) * 10) / 10,
    staleCount: r.staleCount,
  }));

  const criticalOpen = byPriority.find((p) => p.priority === "CRITICAL")?.open ?? 0;

  return { byPriority, criticalOpen };
}

function buildRepoHealth(db: SqliteDb, todayStr: string): RepoHealthEntry[] {
  const rows = db
    .prepare(
      `SELECT i.repo,
              SUM(CASE WHEN i.state = 'open' THEN 1 ELSE 0 END) AS open,
              SUM(CASE WHEN i.state = 'open' AND julianday(?) - julianday(i.updated_at) >= 14 THEN 1 ELSE 0 END) AS staleCount,
              AVG(CASE WHEN i.state = 'open' THEN julianday(?) - julianday(i.created_at) ELSE NULL END) AS avgAge
       FROM issues i
       GROUP BY i.repo
       HAVING open > 0
       ORDER BY open DESC`,
    )
    .all(todayStr, todayStr) as Array<{
    repo: string;
    open: number;
    staleCount: number;
    avgAge: number | null;
  }>;

  // Get PRI::CRITICAL open count per repo
  const critRows = db
    .prepare(
      `SELECT i.repo, COUNT(*) AS cnt
       FROM issues i
       JOIN issue_labels il ON il.issue_id = i.id
       WHERE i.state = 'open' AND il.label = 'PRI::CRITICAL'
       GROUP BY i.repo`,
    )
    .all() as Array<{ repo: string; cnt: number }>;
  const critMap = new Map<string, number>();
  for (const r of critRows) critMap.set(r.repo, r.cnt);

  return rows.map((r) => {
    const stalePct = r.open > 0 ? Math.round((r.staleCount / r.open) * 100) : 0;
    const criticalOpen = critMap.get(r.repo) ?? 0;
    const critRatio = r.open > 0 ? criticalOpen / r.open : 0;
    // Score: 100 - stalePct*0.6 - critRatio*30
    const healthScore = Math.max(0, Math.min(100, Math.round(100 - stalePct * 0.6 - critRatio * 30)));
    return {
      repo: r.repo,
      open: r.open,
      staleCount: r.staleCount,
      stalePct,
      criticalOpen,
      avgAgeDays: Math.round((r.avgAge ?? 0) * 10) / 10,
      healthScore,
    };
  }).sort((a, b) => a.healthScore - b.healthScore);
}

function buildBacklogHealth(
  totalOpen: number,
  staleCount: number,
  criticalOpen: number,
  velocity: VelocityWeek[],
): BacklogHealth {
  const stalePct = totalOpen > 0 ? (staleCount / totalOpen) * 100 : 0;
  const criticalRatio = totalOpen > 0 ? criticalOpen / totalOpen : 0;

  // Velocity trend: are we closing more than opening?
  let velocityTrending = 0;
  let negativeWeeks = 0;
  if (velocity.length >= 2) {
    const recent = velocity.slice(-4);
    for (const w of recent) {
      if (w.netChange > 0) velocityTrending++;
      if (w.netChange < 0) negativeWeeks++;
    }
  }

  // Calculate score
  let score = 100;
  score -= stalePct * 0.4;
  score -= criticalRatio * 20;
  score -= negativeWeeks * 10;
  score += velocityTrending * 5;
  score = Math.max(0, Math.min(100, Math.round(score)));

  const grade = score >= 80 ? "A" : score >= 60 ? "B" : score >= 40 ? "C" : score >= 20 ? "D" : "F";

  const factors: BacklogHealth["factors"] = [];

  // Stale rate factor
  const staleStatus = stalePct <= 20 ? "good" : stalePct <= 50 ? "warning" : "critical";
  factors.push({
    name: "Stale Rate",
    value: Math.round(stalePct),
    status: staleStatus,
    detail: `${Math.round(stalePct)}% of open issues idle 14+ days`,
  });

  // Critical backlog factor
  const critStatus = criticalOpen === 0 ? "good" : criticalOpen <= 3 ? "warning" : "critical";
  factors.push({
    name: "Critical Backlog",
    value: criticalOpen,
    status: critStatus,
    detail: `${criticalOpen} critical-priority issues open`,
  });

  // Velocity trend
  const velStatus = negativeWeeks === 0 ? "good" : negativeWeeks <= 2 ? "warning" : "critical";
  factors.push({
    name: "Velocity Trend",
    value: velocityTrending - negativeWeeks,
    status: velStatus,
    detail: negativeWeeks > 0
      ? `Backlog growing ${negativeWeeks} of last 4 weeks`
      : "Backlog stable or shrinking",
  });

  return { score, grade, factors };
}

function buildScopedBreakdown(
  db: SqliteDb,
  scope: string,
): Array<{ value: string; open: number; closed: number }> {
  const rows = db
    .prepare(
      `SELECT REPLACE(il.label, ?, '') AS value,
              SUM(CASE WHEN i.state = 'open' THEN 1 ELSE 0 END) AS open,
              SUM(CASE WHEN i.state IN ('closed','merged') THEN 1 ELSE 0 END) AS closed
       FROM issue_labels il
       JOIN issues i ON il.issue_id = i.id
       WHERE il.label LIKE ?
       GROUP BY value
       ORDER BY (open + closed) DESC`,
    )
    .all(scope + "::", scope + "::%") as Array<{ value: string; open: number; closed: number }>;
  return rows;
}

function buildPersonalWorkload(db: SqliteDb, todayStr: string): PersonalWorkload | null {
  // Find the top assignee by open issue count
  const top = db
    .prepare(
      `SELECT j.value AS assignee, COUNT(*) AS cnt
       FROM issues i, json_each(CASE WHEN i.assignees = '' THEN '[]' ELSE i.assignees END) j
       WHERE i.state = 'open'
       GROUP BY j.value
       ORDER BY cnt DESC
       LIMIT 1`,
    )
    .get() as { assignee: string; cnt: number } | undefined;

  if (!top) return null;

  const assignee = top.assignee;
  const openCount = top.cnt;

  // Priority breakdown
  const priRows = db
    .prepare(
      `SELECT REPLACE(il.label, 'PRI::', '') AS pri, COUNT(*) AS cnt
       FROM issues i
       JOIN json_each(CASE WHEN i.assignees = '' THEN '[]' ELSE i.assignees END) j ON j.value = ?
       JOIN issue_labels il ON il.issue_id = i.id
       WHERE i.state = 'open' AND il.label LIKE 'PRI::%'
       GROUP BY pri`,
    )
    .all(assignee) as Array<{ pri: string; cnt: number }>;
  const byPriority: Record<string, number> = {};
  for (const r of priRows) byPriority[r.pri] = r.cnt;

  // Type breakdown
  const typeRows = db
    .prepare(
      `SELECT REPLACE(il.label, 'Type::', '') AS typ, COUNT(*) AS cnt
       FROM issues i
       JOIN json_each(CASE WHEN i.assignees = '' THEN '[]' ELSE i.assignees END) j ON j.value = ?
       JOIN issue_labels il ON il.issue_id = i.id
       WHERE i.state = 'open' AND il.label LIKE 'Type::%'
       GROUP BY typ`,
    )
    .all(assignee) as Array<{ typ: string; cnt: number }>;
  const byType: Record<string, number> = {};
  for (const r of typeRows) byType[r.typ] = r.cnt;

  // Repo breakdown
  const repoRows = db
    .prepare(
      `SELECT i.repo, COUNT(*) AS count
       FROM issues i
       JOIN json_each(CASE WHEN i.assignees = '' THEN '[]' ELSE i.assignees END) j ON j.value = ?
       WHERE i.state = 'open'
       GROUP BY i.repo
       ORDER BY count DESC`,
    )
    .all(assignee) as Array<{ repo: string; count: number }>;

  // Stale count
  const stale = db
    .prepare(
      `SELECT COUNT(*) AS cnt
       FROM issues i
       JOIN json_each(CASE WHEN i.assignees = '' THEN '[]' ELSE i.assignees END) j ON j.value = ?
       WHERE i.state = 'open' AND julianday(?) - julianday(i.updated_at) >= 14`,
    )
    .get(assignee, todayStr) as { cnt: number };

  return {
    assignee,
    openCount,
    byPriority,
    byType,
    byRepo: repoRows,
    staleCount: stale.cnt,
  };
}

function generateInsights(
  totalOpen: number,
  staleCount: number,
  criticalOpen: number,
  velocity: VelocityWeek[],
  repoHealth: RepoHealthEntry[],
  funnel: WorkflowFunnel,
  personalWorkload: PersonalWorkload | null,
): string[] {
  const insights: string[] = [];
  const stalePct = totalOpen > 0 ? Math.round((staleCount / totalOpen) * 100) : 0;

  if (stalePct > 50) {
    insights.push(`⚠️ ${stalePct}% of open issues are stale (no updates in 14+ days)`);
  }

  if (criticalOpen > 0) {
    insights.push(`🔴 ${criticalOpen} critical-priority issue${criticalOpen > 1 ? "s" : ""} remain open`);
  }

  // Repo concentration
  if (totalOpen > 0 && repoHealth.length > 0) {
    const worst = repoHealth[repoHealth.length - 1]; // sorted by healthScore ASC, largest open is last
    const biggest = repoHealth.reduce((a, b) => (a.open > b.open ? a : b));
    const bigPct = Math.round((biggest.open / totalOpen) * 100);
    if (bigPct > 40) {
      insights.push(`📦 ${biggest.repo.split("/").pop()} concentrates ${bigPct}% of open backlog`);
    }
  }

  // Negative velocity trend
  if (velocity.length >= 3) {
    const recent = velocity.slice(-3);
    const negWeeks = recent.filter((w) => w.netChange < 0).length;
    if (negWeeks >= 3) {
      insights.push(`📉 Backlog is growing — more opened than closed for ${negWeeks} weeks`);
    }
  }

  // Personal workload concentration
  if (personalWorkload && totalOpen > 0) {
    const pct = Math.round((personalWorkload.openCount / totalOpen) * 100);
    if (pct > 30) {
      insights.push(
        `👤 ${personalWorkload.assignee} carries ${pct}% of open issues (${personalWorkload.openCount} total)`,
      );
    }
  }

  // Workflow bottleneck
  if (funnel.bottleneck) {
    const stuck = funnel.stages.find((s) => s.name === funnel.bottleneck);
    if (stuck && stuck.count > 5) {
      insights.push(`🔄 Bottleneck at '${funnel.bottleneck}' — ${stuck.count} issues stuck there`);
    }
  }

  return insights;
}

export function queryIssues(db: SqliteDb): DashboardIssues | null {
  if (!issuesTableExists(db)) return null;

  const todayStr = today();

  // ── Configured Providers ───────────────────────
  const providers: ConfiguredProvider[] = [];
  const tokenRows = safeAll<{ provider: string; username: string; base_url: string }>(db,
    `SELECT provider, username, base_url FROM issue_tokens`,
  );
  for (const row of tokenRows) {
    const syncMeta = safeGet(db,
      `SELECT last_sync_at FROM issue_sync_meta WHERE provider = ?`,
      [row.provider],
      undefined as { last_sync_at: string } | undefined,
    );
    const repoCount = safeGet(db,
      `SELECT COUNT(DISTINCT repo) as cnt FROM issues WHERE provider = ?`,
      [row.provider],
      { cnt: 0 },
    ).cnt;
    providers.push({
      provider: row.provider,
      username: row.username,
      baseUrl: row.base_url,
      lastSync: syncMeta?.last_sync_at ?? null,
      repoCount,
    });
  }

  // ── Existing data ──────────────────────────────
  const totals = db
    .prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN state = 'open' THEN 1 ELSE 0 END) as open,
         SUM(CASE WHEN state IN ('closed','merged') THEN 1 ELSE 0 END) as closed,
         SUM(CASE WHEN is_pull_request = 1 THEN 1 ELSE 0 END) as prs
       FROM issues`,
    )
    .get() as { total: number; open: number; closed: number; prs: number };

  const byState = db
    .prepare(`SELECT state, COUNT(*) as count FROM issues GROUP BY state`)
    .all() as Array<{ state: string; count: number }>;

  const byRepo = db
    .prepare(
      `SELECT repo,
         SUM(CASE WHEN state = 'open' THEN 1 ELSE 0 END) as open,
         SUM(CASE WHEN state IN ('closed','merged') THEN 1 ELSE 0 END) as closed
       FROM issues GROUP BY repo ORDER BY open DESC LIMIT 15`,
    )
    .all() as Array<{ repo: string; open: number; closed: number }>;

  const byProvider = db
    .prepare(`SELECT provider, COUNT(*) as count FROM issues GROUP BY provider`)
    .all() as Array<{ provider: string; count: number }>;

  const byLabel = db
    .prepare(
      `SELECT label, COUNT(*) as count FROM issue_labels
       GROUP BY label ORDER BY count DESC LIMIT 10`,
    )
    .all() as Array<{ label: string; count: number }>;

  const recentlyClosed = db
    .prepare(
      `SELECT title, repo, closed_at FROM issues
       WHERE closed_at IS NOT NULL AND is_pull_request = 0
       ORDER BY closed_at DESC LIMIT 10`,
    )
    .all() as Array<{ title: string; repo: string; closed_at: string }>;

  const time = db
    .prepare(
      `SELECT COALESCE(SUM(time_estimate), 0) as totalEstimate,
              COALESCE(SUM(time_spent), 0) as totalSpent
       FROM issues`,
    )
    .get() as { totalEstimate: number; totalSpent: number };

  // ── Velocity (8 weeks) ─────────────────────────
  const velocity = db
    .prepare(
      `WITH RECURSIVE weeks(n, week_start) AS (
         SELECT 0, date(?, '-6 days', 'weekday 1', '-49 days')
         UNION ALL
         SELECT n+1, date(week_start, '+7 days') FROM weeks WHERE n < 7
       )
       SELECT
         w.week_start AS week,
         COALESCE(SUM(CASE WHEN i.created_at >= w.week_start AND i.created_at < date(w.week_start, '+7 days') THEN 1 ELSE 0 END), 0) AS opened,
         COALESCE(SUM(CASE WHEN i.closed_at >= w.week_start AND i.closed_at < date(w.week_start, '+7 days') THEN 1 ELSE 0 END), 0) AS closed
       FROM weeks w
       LEFT JOIN issues i ON 1=1
       GROUP BY w.week_start
       ORDER BY w.week_start`,
    )
    .all(todayStr) as Array<{ week: string; opened: number; closed: number }>;

  const velocityData: VelocityWeek[] = velocity.map((v) => ({
    ...v,
    netChange: v.closed - v.opened,
  }));

  // ── Milestones ─────────────────────────────────
  const milestones = db
    .prepare(
      `SELECT
         milestone,
         COUNT(*) AS total,
         SUM(CASE WHEN state = 'open' THEN 1 ELSE 0 END) AS open,
         SUM(CASE WHEN state IN ('closed','merged') THEN 1 ELSE 0 END) AS closed
       FROM issues
       WHERE milestone <> ''
       GROUP BY milestone
       ORDER BY open DESC`,
    )
    .all() as Array<{ milestone: string; total: number; open: number; closed: number }>;

  const milestonesData: MilestoneProgress[] = milestones.map((m) => ({
    ...m,
    progressPct: m.total > 0 ? Math.round((m.closed / m.total) * 100) : 0,
  }));

  // ── Assignee Workload ──────────────────────────
  const assigneeWorkload = db
    .prepare(
      `SELECT
         j.value AS assignee,
         COUNT(*) AS openCount,
         COALESCE(SUM(i.time_estimate), 0) AS estimateSec,
         COALESCE(SUM(i.time_spent), 0) AS spentSec
       FROM issues i, json_each(CASE WHEN i.assignees = '' THEN '[]' ELSE i.assignees END) j
       WHERE i.state = 'open'
       GROUP BY j.value
       ORDER BY openCount DESC
       LIMIT 15`,
    )
    .all() as Array<{ assignee: string; openCount: number; estimateSec: number; spentSec: number }>;

  const assigneeData: AssigneeWorkload[] = assigneeWorkload.map((a) => ({
    assignee: a.assignee,
    openCount: a.openCount,
    estimateHours: Math.round(a.estimateSec / 3600 * 10) / 10,
    spentHours: Math.round(a.spentSec / 3600 * 10) / 10,
  }));

  // ── Age Analysis ───────────────────────────────
  const avgClose = db
    .prepare(
      `SELECT AVG(julianday(closed_at) - julianday(created_at)) AS avg_days
       FROM issues
       WHERE closed_at IS NOT NULL`,
    )
    .get() as { avg_days: number | null };

  const avgCloseTimeDays = Math.round((avgClose.avg_days ?? 0) * 10) / 10;

  const ageBuckets = db
    .prepare(
      `SELECT
         CASE
           WHEN julianday(?) - julianday(created_at) <= 7 THEN '0-7d'
           WHEN julianday(?) - julianday(created_at) <= 14 THEN '7-14d'
           WHEN julianday(?) - julianday(created_at) <= 30 THEN '14-30d'
           WHEN julianday(?) - julianday(created_at) <= 60 THEN '30-60d'
           ELSE '60d+'
         END AS label,
         COUNT(*) AS count
       FROM issues
       WHERE state = 'open'
       GROUP BY label
       ORDER BY MIN(julianday(?) - julianday(created_at))`,
    )
    .all(todayStr, todayStr, todayStr, todayStr, todayStr) as Array<{ label: string; count: number }>;

  const ageAnalysis: AgeAnalysis = { avgCloseTimeDays, buckets: ageBuckets };

  // ── Stale Issues (14+ days no update) ──────────
  const staleIssues = db
    .prepare(
      `SELECT
         id, title, repo, updated_at,
         CAST(julianday(?) - julianday(updated_at) AS INTEGER) AS daysSinceUpdate
       FROM issues
       WHERE state = 'open'
         AND julianday(?) - julianday(updated_at) >= 14
       ORDER BY daysSinceUpdate DESC
       LIMIT 20`,
    )
    .all(todayStr, todayStr) as StaleIssue[];

  const staleCount = staleIssues.length;

  // ── Activity Heatmap ───────────────────────────
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const heatmapRaw = db
    .prepare(
      `SELECT
         CAST(strftime('%w', created_at) AS INTEGER) AS day,
         COUNT(*) AS created,
         0 AS closed
       FROM issues GROUP BY day
       UNION ALL
       SELECT
         CAST(strftime('%w', closed_at) AS INTEGER) AS day,
         0 AS created,
         COUNT(*) AS closed
       FROM issues WHERE closed_at IS NOT NULL GROUP BY day`,
    )
    .all() as Array<{ day: number; created: number; closed: number }>;

  const heatmapMap = new Map<number, { created: number; closed: number }>();
  for (let d = 0; d < 7; d++) heatmapMap.set(d, { created: 0, closed: 0 });
  for (const r of heatmapRaw) {
    const cur = heatmapMap.get(r.day)!;
    cur.created += r.created;
    cur.closed += r.closed;
  }
  const activityHeatmap: ActivityDay[] = Array.from(heatmapMap.entries()).map(([d, v]) => ({
    day: d,
    dayName: dayNames[d],
    created: v.created,
    closed: v.closed,
  }));

  // ── Time Tracking by Repo ──────────────────────
  const timeByRepo = db
    .prepare(
      `SELECT repo AS grp,
              COALESCE(SUM(time_estimate), 0) AS estimate,
              COALESCE(SUM(time_spent), 0) AS spent
       FROM issues
       WHERE time_estimate > 0 OR time_spent > 0
       GROUP BY repo
       ORDER BY spent DESC LIMIT 10`,
    )
    .all() as Array<{ grp: string; estimate: number; spent: number }>;

  const timeByRepoData: TimeByGroup[] = timeByRepo.map((r) => ({
    group: r.grp,
    estimate: r.estimate,
    spent: r.spent,
    burnRate: r.estimate > 0 ? Math.round((r.spent / r.estimate) * 100) / 100 : 0,
  }));

  // ── Time Tracking by Assignee ──────────────────
  const timeByAssignee = db
    .prepare(
      `SELECT j.value AS grp,
              COALESCE(SUM(i.time_estimate), 0) AS estimate,
              COALESCE(SUM(i.time_spent), 0) AS spent
       FROM issues i, json_each(CASE WHEN i.assignees = '' THEN '[]' ELSE i.assignees END) j
       WHERE i.time_estimate > 0 OR i.time_spent > 0
       GROUP BY j.value
       ORDER BY spent DESC LIMIT 10`,
    )
    .all() as Array<{ grp: string; estimate: number; spent: number }>;

  const timeByAssigneeData: TimeByGroup[] = timeByAssignee.map((r) => ({
    group: r.grp,
    estimate: r.estimate,
    spent: r.spent,
    burnRate: r.estimate > 0 ? Math.round((r.spent / r.estimate) * 100) / 100 : 0,
  }));

  // ── Over Budget Issues ─────────────────────────
  const overBudget = db
    .prepare(
      `SELECT title, repo, time_estimate AS estimate, time_spent AS spent,
              (time_spent - time_estimate) AS overBy
       FROM issues
       WHERE time_estimate > 0 AND time_spent > time_estimate
       ORDER BY overBy DESC LIMIT 10`,
    )
    .all() as OverBudgetIssue[];

  // ── Label Trends ───────────────────────────────
  const weekAgo = daysFromNow(-7);
  const twoWeeksAgo = daysFromNow(-14);
  const labelTrends = db
    .prepare(
      `SELECT
         il.label,
         SUM(CASE WHEN i.created_at >= ? THEN 1 ELSE 0 END) AS thisWeek,
         SUM(CASE WHEN i.created_at >= ? AND i.created_at < ? THEN 1 ELSE 0 END) AS lastWeek
       FROM issue_labels il
       JOIN issues i ON i.id = il.issue_id
       WHERE i.created_at >= ?
       GROUP BY il.label
       ORDER BY thisWeek DESC
       LIMIT 10`,
    )
    .all(weekAgo, twoWeeksAgo, weekAgo, twoWeeksAgo) as Array<{ label: string; thisWeek: number; lastWeek: number }>;

  const labelTrendsData: LabelTrend[] = labelTrends.map((l) => ({
    ...l,
    change: l.thisWeek - l.lastWeek,
  }));

  // ── Scoped Label Intelligence ────────────────────
  const scopedDimensions = parseScopedLabels(db);
  const workflowFunnel = buildWorkflowFunnel(db);
  const priorityMatrix = buildPriorityMatrix(db, todayStr);
  const repoHealth = buildRepoHealth(db, todayStr);
  const totalOpen = totals.open ?? 0;

  // Get full stale count (not limited by LIMIT 20)
  const fullStaleCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM issues
         WHERE state = 'open' AND julianday(?) - julianday(updated_at) >= 14`,
      )
      .get(todayStr) as { cnt: number }
  ).cnt;

  const backlogHealth = buildBacklogHealth(
    totalOpen,
    fullStaleCount,
    priorityMatrix.criticalOpen,
    velocityData,
  );

  const typeRaw = buildScopedBreakdown(db, "Type");
  const typeBreakdown = typeRaw.map((r) => ({ type: r.value, open: r.open, closed: r.closed }));
  const envRaw = buildScopedBreakdown(db, "ENV");
  const envBreakdown = envRaw.map((r) => ({ env: r.value, open: r.open, closed: r.closed }));

  const personalWorkload = buildPersonalWorkload(db, todayStr);

  const insights = generateInsights(
    totalOpen,
    fullStaleCount,
    priorityMatrix.criticalOpen,
    velocityData,
    repoHealth,
    workflowFunnel,
    personalWorkload,
  );

  return {
    kpis: {
      total: totals.total ?? 0,
      open: totalOpen,
      closed: totals.closed ?? 0,
      prs: totals.prs ?? 0,
    },
    providers,
    byState,
    byRepo,
    byProvider,
    byLabel,
    recentlyClosed,
    timeTracking: time,
    velocity: velocityData,
    milestones: milestonesData,
    assigneeWorkload: assigneeData,
    ageAnalysis,
    staleIssues,
    activityHeatmap,
    timeByRepo: timeByRepoData,
    timeByAssignee: timeByAssigneeData,
    overBudget,
    labelTrends: labelTrendsData,
    avgCloseTimeDays,
    staleCount,
    scopedDimensions,
    workflowFunnel,
    priorityMatrix,
    repoHealth,
    backlogHealth,
    typeBreakdown,
    envBreakdown,
    personalWorkload,
    insights,
  };
}
