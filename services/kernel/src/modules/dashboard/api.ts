import type { SqliteDb } from "../../core/db/sqlite.js";
import type { GraphDriver } from "../../core/db-drivers/graph-driver.js";
import type { SystemRegistry } from "../../core/system-registry.js";
import { tableExists, safeGet, safeAll, today, daysFromNow } from "./query-helpers.js";
import { CronExpressionParser } from "cron-parser";

// ── Module queries: re-exported for DASHBOARD-INTERNAL callers ─────
//
// Callers INTERNAL to the dashboard module (api-routes.ts, rpc-actions.ts) use
// these re-exports. NO consumer outside the module uses them — verified with
// grep: every feature module imports straight from its own `dashboard-queries.ts`.
//
// Progression of the dashboard inversion:
//   ✓ Rutas HTTP duplicadas (`/api/dashboard/<channel>`) removidas de
//     `api-routes.ts` — ahora las auto-genera `DashboardRegistry.registerAllRoutes()`
//     for the ~18 modules that declare `getDashboardDescriptor()`.
//   ⏳ Pending: migrate `rpc-actions.ts` to the same pattern (iterate the registry
//     de tener casos hardcoded). Requiere inyectar `dashboardRegistry` en
//     `DashboardRpcDeps` and generate per-channel RpcActions automatically.
//   ⏳ Pending: once rpc-actions migrates, these re-exports can be deleted.
//
// Los 4 "core KPI" (tasks/crm/reminders/shopping) no migran — son agregados en
// `queryFullDashboard()` for the dashboard's main view.

// Imports of the 4 core KPI queries — used internally by queryFullDashboard
// composition AND re-exported below for the dashboard's HTTP routes.
import { queryTasks, type DashboardTasks } from "../../../assets/extensions/productivity/tasks/_module/dashboard-queries.js";
import { queryCrm, type DashboardCrm } from "../../../assets/extensions/people/crm/_module/dashboard-queries.js";
import { queryReminders, type DashboardReminders } from "../../../assets/extensions/productivity/reminders/_module/dashboard-queries.js";
import {
  queryShopping,
  type DashboardShoppingItem,
  type DashboardShoppingList,
  type DashboardShopping,
} from "../../../assets/extensions/home/shopping/_module/dashboard-queries.js";

// Re-exports for dashboard-internal callers + tests that consume via this barrel.
export { queryTasks, type DashboardTasks };
export { queryCrm, type DashboardCrm };
export { queryReminders, type DashboardReminders };
export { queryShopping, type DashboardShoppingItem, type DashboardShoppingList, type DashboardShopping };
// Agents/chat dashboard queries are owned by their modules; dashboard callers
// import them directly from the owning module's dashboard-queries.js (one-way
// aggregation dep) rather than through this barrel.
// time-tracking + web-intel queries still flow through here because
// api-routes registers legacy kebab-case URLs (`/api/dashboard/time-tracking`,
// `/api/dashboard/web-intel`) against them. Every other extension's dashboard
// query is auto-routed by DashboardRegistry now, so its re-export was deleted.
export { type DashboardTimeTracking, queryTimeTracking } from "../../../assets/extensions/productivity/time-tracking/_module/dashboard-queries.js";
export { type DashboardWebIntel, queryWebIntel } from "./web-intel-query.js";

// ── Cross-module types ──────────────────────────────

export interface DashboardKpis {
  tasks: { total: number; open: number; done: number; blocked: number };
  contacts: { total: number };
  reminders: { total: number; active: number };
  shopping: { products: number; lowStock: number };
  issues: { total: number; open: number; closed: number; prs: number } | null;
}

export interface FullDashboard {
  generatedAt: string;
  kpis: DashboardKpis;
  // The 4 core KPI types are also re-exported by name above so consumers
  // can `import { DashboardTasks } from "../dashboard/api.js"` without
  // reaching back into the extension's source path.
  tasks: DashboardTasks;
  crm: DashboardCrm;
  reminders: DashboardReminders;
  shopping: DashboardShopping;
}

export interface AgendaItem {
  type: "task" | "reminder" | "event" | "issue" | "interaction" | "purchase";
  id: string;
  title: string;
  date: string;
  time: string | null;
  priority: string | null;
  meta: string | null;
}

export interface AgendaDay {
  date: string;
  dayOfWeek: string;
  isToday: boolean;
  isPast: boolean;
  items: AgendaItem[];
}

export interface WorkloadDay {
  date: string;
  taskCount: number;
  issueCount: number;
  reminderCount: number;
  total: number;
}

export interface DashboardAgenda {
  overdue: AgendaItem[];
  days: AgendaDay[];
  workloadForecast: WorkloadDay[];
}

export interface CrossModuleIntel {
  authorContactMatches: Array<{ author: string; contactName: string; contactId: string }>;
  velocityComparison: { tasksPerWeek: number; issuesPerWeek: number };
  workloadForecast: {
    openTasks: number;
    openIssues: number;
    estimatedHoursRemaining: number;
    estimatedDaysToClear: number;
  };
}

export interface PipelineStatus {
  enrichment: { ran: boolean; emailDomainsSet: number; sameDomainRels: number; sameCompanyRels: number };
  gds: { ran: boolean; communities: number; components: number; nodesWithPageRank: number };
  embeddings: { ran: boolean; contactsWithEmbedding: number; totalContacts: number };
}

export interface DashboardAnalytics {
  contactInsights: {
    total: number;
    withEmail: number;
    withPhone: number;
    withCompany: number;
    emailPct: number;
    phonePct: number;
    companyPct: number;
    byRelationship: Record<string, number>;
    bySource: Record<string, number>;
    withoutInteraction: number;
  };
  topDomains: Array<{ domain: string; count: number }>;
  topCompanies: Array<{ company: string; count: number }>;
  network: {
    available: boolean;
    totalNodes: number;
    totalRelationships: number;
    components: number;
    communities: number;
    influencers: Array<{ name: string; company: string | null; score: number }>;
    bridges: Array<{ name: string; company: string | null; score: number }>;
    topCommunities: Array<{
      communityId: number;
      size: number;
      dominantCompany: string | null;
      dominantDomain: string | null;
      members: string[];
    }>;
    relationshipBreakdown: Record<string, number>;
  };
  pipeline: PipelineStatus | null;
}

export interface CalendarEvent {
  id: string;
  type: string;
  title: string;
  time: string | null;
  color: string;
  extra: string | null;
}

export interface CalendarData {
  start: string;
  dayCount: number;
  days: Record<string, CalendarEvent[]>;
  overdue: CalendarEvent[];
  systemProcesses: Array<{
    name: string; module: string; intervalMs?: number; nextRunAt?: string;
    type?: string; description?: string; status?: string; lastRunAt?: string; runCount?: number;
  }>;
}

// ── Cross-module queries ────────────────────────────

export function queryKpis(db: SqliteDb): DashboardKpis {
  const taskStats = db
    .prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN status != 'done' THEN 1 ELSE 0 END) as open,
         SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done,
         SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) as blocked
       FROM tasks WHERE deleted_at IS NULL`,
    )
    .get() as { total: number; open: number; done: number; blocked: number };

  const contactTotal = (
    db.prepare(`SELECT COUNT(*) as count FROM contacts`).get() as { count: number }
  ).count;

  const reminderStats = db
    .prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active
       FROM reminders`,
    )
    .get() as { total: number; active: number };

  const productCount = (
    db.prepare(`SELECT COUNT(*) as count FROM products`).get() as { count: number }
  ).count;
  const lowStockCount = (
    db
      .prepare(`SELECT COUNT(*) as count FROM products WHERE current_stock < min_stock AND min_stock > 0`)
      .get() as { count: number }
  ).count;

  const issueStats = safeGet(db,
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN state = 'open' THEN 1 ELSE 0 END) as open,
       SUM(CASE WHEN state IN ('closed','merged') THEN 1 ELSE 0 END) as closed,
       SUM(CASE WHEN is_pull_request = 1 THEN 1 ELSE 0 END) as prs
     FROM issues`, [],
    null as { total: number; open: number; closed: number; prs: number } | null,
  );
  const issues: DashboardKpis["issues"] = issueStats
    ? { total: issueStats.total ?? 0, open: issueStats.open ?? 0, closed: issueStats.closed ?? 0, prs: issueStats.prs ?? 0 }
    : null;

  return {
    tasks: {
      total: taskStats.total ?? 0,
      open: taskStats.open ?? 0,
      done: taskStats.done ?? 0,
      blocked: taskStats.blocked ?? 0,
    },
    contacts: { total: contactTotal },
    reminders: { total: reminderStats.total ?? 0, active: reminderStats.active ?? 0 },
    shopping: { products: productCount, lowStock: lowStockCount },
    issues,
  };
}

export function queryFullDashboard(db: SqliteDb): FullDashboard {
  return {
    generatedAt: new Date().toISOString(),
    kpis: queryKpis(db),
    tasks: queryTasks(db),
    crm: queryCrm(db),
    reminders: queryReminders(db),
    shopping: queryShopping(db),
  };
}

export function queryAgenda(db: SqliteDb): DashboardAgenda {
  const todayStr = today();
  const rangeEnd = daysFromNow(14);
  const threeDaysAgo = daysFromNow(-3);
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  // ── Overdue items ──────────────────────────────
  const overdue: AgendaItem[] = [];

  // Overdue tasks
  const overdueTasks = db
    .prepare(
      `SELECT id, title, due_date, priority FROM tasks
       WHERE status NOT IN ('done') AND due_date IS NOT NULL AND due_date < ? AND deleted_at IS NULL
       ORDER BY due_date LIMIT 20`,
    )
    .all(todayStr) as Array<{ id: string; title: string; due_date: string; priority: string }>;
  for (const t of overdueTasks) {
    overdue.push({ type: "task", id: t.id, title: t.title, date: t.due_date, time: null, priority: t.priority, meta: null });
  }

  // Overdue reminders
  const now = new Date().toISOString();
  const overdueReminders = db
    .prepare(
      `SELECT id, title, trigger_at FROM reminders
       WHERE status IN ('active','snoozed') AND trigger_at < ?
       ORDER BY trigger_at LIMIT 20`,
    )
    .all(now) as Array<{ id: string; title: string; trigger_at: string }>;
  for (const r of overdueReminders) {
    const d = r.trigger_at.split("T")[0];
    const t = r.trigger_at.split("T")[1]?.slice(0, 5) ?? null;
    overdue.push({ type: "reminder", id: r.id, title: r.title, date: d, time: t, priority: null, meta: null });
  }

  // ── Build 14-day calendar ──────────────────────
  const dayMap = new Map<string, AgendaItem[]>();
  for (let i = 0; i < 14; i++) {
    dayMap.set(daysFromNow(i), []);
  }

  // Tasks with due_date in range
  const rangeTasks = db
    .prepare(
      `SELECT id, title, due_date, priority, status FROM tasks
       WHERE status NOT IN ('done') AND due_date >= ? AND due_date < ? AND deleted_at IS NULL
       ORDER BY due_date`,
    )
    .all(todayStr, rangeEnd) as Array<{ id: string; title: string; due_date: string; priority: string; status: string }>;
  for (const t of rangeTasks) {
    const items = dayMap.get(t.due_date);
    if (items) items.push({ type: "task", id: t.id, title: t.title, date: t.due_date, time: null, priority: t.priority, meta: t.status });
  }

  // Reminders in range
  const rangeReminders = db
    .prepare(
      `SELECT id, title, trigger_at, repeat FROM reminders
       WHERE status IN ('active','snoozed') AND trigger_at >= ? AND trigger_at < ?
       ORDER BY trigger_at`,
    )
    .all(`${todayStr}T00:00:00`, `${rangeEnd}T00:00:00`) as Array<{ id: string; title: string; trigger_at: string; repeat: string }>;
  for (const r of rangeReminders) {
    const d = r.trigger_at.split("T")[0];
    const t = r.trigger_at.split("T")[1]?.slice(0, 5) ?? null;
    const items = dayMap.get(d);
    if (items) items.push({ type: "reminder", id: r.id, title: r.title, date: d, time: t, priority: null, meta: r.repeat !== "none" ? r.repeat : null });
  }

  // Events (from events module)
  const rangeEvents = safeAll<{ id: string; title: string; start_at: string; type: string; status: string }>(db,
    `SELECT id, title, start_at, type, status FROM events
     WHERE status NOT IN ('cancelled','completed') AND start_at >= ? AND start_at < ?
     ORDER BY start_at`,
    [`${todayStr}T00:00:00`, `${rangeEnd}T00:00:00`],
  );
  for (const ev of rangeEvents) {
    const d = ev.start_at.split("T")[0];
    const t = ev.start_at.split("T")[1]?.slice(0, 5) ?? null;
    const items = dayMap.get(d);
    if (items) items.push({ type: "event", id: ev.id, title: ev.title, date: d, time: t, priority: null, meta: ev.status === "draft" ? `${ev.type} · draft` : ev.type });
  }

  // Overdue events
  const overdueEvents = safeAll<{ id: string; title: string; start_at: string; type: string }>(db,
    `SELECT id, title, start_at, type FROM events
     WHERE status NOT IN ('cancelled','completed') AND start_at < ?
     ORDER BY start_at DESC LIMIT 10`,
    [`${todayStr}T00:00:00`],
  );
  for (const ev of overdueEvents) {
    const d = ev.start_at.split("T")[0];
    const t = ev.start_at.split("T")[1]?.slice(0, 5) ?? null;
    overdue.push({ type: "event", id: ev.id, title: ev.title, date: d, time: t, priority: null, meta: ev.type });
  }

  // Recent interactions (last 3 days)
  const recentInteractions = db
    .prepare(
      `SELECT i.id, c.name AS contact_name, i.type AS itype, i.date
       FROM interactions i JOIN contacts c ON c.id = i.contact_id
       WHERE i.date >= ? AND i.date < ?
       ORDER BY i.date DESC LIMIT 20`,
    )
    .all(threeDaysAgo, rangeEnd) as Array<{ id: string; contact_name: string; itype: string; date: string }>;
  for (const i of recentInteractions) {
    const items = dayMap.get(i.date);
    if (items) items.push({ type: "interaction", id: i.id, title: i.contact_name, date: i.date, time: null, priority: null, meta: i.itype });
  }

  // Recent purchases (last 3 days)
  const recentPurchases = db
    .prepare(
      `SELECT pu.id, pr.name AS product_name, pu.total_price, pu.currency, pu.purchased_at
       FROM purchases pu
       LEFT JOIN products pr ON pr.id = pu.product_id
       WHERE pu.purchased_at >= ? AND pu.purchased_at < ?
       ORDER BY pu.purchased_at DESC LIMIT 20`,
    )
    .all(threeDaysAgo, rangeEnd) as Array<{ id: string; product_name: string; total_price: number; currency: string; purchased_at: string }>;
  for (const p of recentPurchases) {
    const items = dayMap.get(p.purchased_at);
    if (items) items.push({ type: "purchase", id: p.id, title: p.product_name ?? "Purchase", date: p.purchased_at, time: null, priority: null, meta: `${p.total_price.toFixed(2)} ${p.currency}` });
  }

  // Issues (created/closed in last 3 days + forward)
  const issueEvents = safeAll<{ id: string; title: string; repo: string; created_at: string; closed_at: string | null; state: string }>(db,
    `SELECT id, title, repo, created_at, closed_at, state FROM issues
     WHERE (created_at >= ? OR (closed_at IS NOT NULL AND closed_at >= ?))
     ORDER BY created_at DESC LIMIT 30`,
    [threeDaysAgo, threeDaysAgo],
  );
  for (const iss of issueEvents) {
    const createdDate = iss.created_at.split("T")[0];
    const items = dayMap.get(createdDate);
    if (items) items.push({ type: "issue", id: iss.id, title: iss.title, date: createdDate, time: null, priority: null, meta: `opened · ${iss.repo.split("/").pop()}` });
    if (iss.closed_at) {
      const closedDate = iss.closed_at.split("T")[0];
      const closedItems = dayMap.get(closedDate);
      if (closedItems) closedItems.push({ type: "issue", id: iss.id + "-closed", title: iss.title, date: closedDate, time: null, priority: null, meta: `closed · ${iss.repo.split("/").pop()}` });
    }
  }

  // Build days array
  const days: AgendaDay[] = [];
  for (const [date, items] of dayMap) {
    const dateObj = new Date(date + "T12:00:00Z");
    days.push({
      date,
      dayOfWeek: dayNames[dateObj.getUTCDay()],
      isToday: date === todayStr,
      isPast: date < todayStr,
      items,
    });
  }

  // ── Workload Forecast ──────────────────────────
  const workloadForecast: WorkloadDay[] = [];
  for (let i = 0; i < 14; i++) {
    const d = daysFromNow(i);
    const taskCount = (db.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE status NOT IN ('done') AND due_date = ? AND deleted_at IS NULL`).get(d) as { c: number }).c;
    const reminderCount = (db.prepare(`SELECT COUNT(*) AS c FROM reminders WHERE status IN ('active','snoozed') AND trigger_at >= ? AND trigger_at < ?`).get(`${d}T00:00:00`, `${daysFromNow(i + 1)}T00:00:00`) as { c: number }).c;
    const issueCount = safeGet(db, `SELECT COUNT(*) AS c FROM issues WHERE state = 'open' AND created_at <= ? AND (closed_at IS NULL OR closed_at > ?)`, [`${d}T23:59:59`, `${d}T00:00:00`], { c: 0 }).c;
    workloadForecast.push({ date: d, taskCount, issueCount, reminderCount, total: taskCount + issueCount + reminderCount });
  }

  return { overdue, days, workloadForecast };
}

export function queryCrossModuleIntel(db: SqliteDb): CrossModuleIntel | null {
  if (!tableExists(db, "issues")) return null;

  const weekAgo = daysFromNow(-7);

  // ── Author <-> Contact matching ──────────────────
  const authorContactMatches = db
    .prepare(
      `SELECT DISTINCT i.author, c.name AS contactName, c.id AS contactId
       FROM issues i
       JOIN contacts c ON LOWER(c.name) LIKE '%' || LOWER(i.author) || '%'
       WHERE i.author <> ''
       LIMIT 20`,
    )
    .all() as Array<{ author: string; contactName: string; contactId: string }>;

  // ── Velocity comparison ────────────────────────
  const tasksCompleted = (
    db.prepare(
      `SELECT COUNT(*) AS c FROM tasks WHERE status = 'done' AND updated_at >= ? AND deleted_at IS NULL`,
    ).get(`${weekAgo}T00:00:00`) as { c: number }
  ).c;

  const issuesClosed = (
    db.prepare(
      `SELECT COUNT(*) AS c FROM issues WHERE state IN ('closed','merged') AND closed_at >= ?`,
    ).get(weekAgo) as { c: number }
  ).c;

  // ── Workload forecast ──────────────────────────
  const openTasks = (
    db.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE status NOT IN ('done') AND deleted_at IS NULL`).get() as { c: number }
  ).c;

  const openIssues = (
    db.prepare(`SELECT COUNT(*) AS c FROM issues WHERE state = 'open'`).get() as { c: number }
  ).c;

  const estimatedHoursRaw = (
    db.prepare(
      `SELECT COALESCE(SUM(time_estimate - time_spent), 0) AS remaining
       FROM issues WHERE state = 'open' AND time_estimate > 0`,
    ).get() as { remaining: number }
  ).remaining;
  const estimatedHoursRemaining = Math.max(0, Math.round(estimatedHoursRaw / 3600 * 10) / 10);

  // Estimate days to clear based on weekly velocity
  const weeklyVelocity = tasksCompleted + issuesClosed;
  const totalOpen = openTasks + openIssues;
  const estimatedDaysToClear = weeklyVelocity > 0
    ? Math.round((totalOpen / weeklyVelocity) * 7)
    : totalOpen > 0 ? 999 : 0;

  return {
    authorContactMatches,
    velocityComparison: { tasksPerWeek: tasksCompleted, issuesPerWeek: issuesClosed },
    workloadForecast: { openTasks, openIssues, estimatedHoursRemaining, estimatedDaysToClear },
  };
}

// Cache analytics for 5 minutes — graph queries are expensive and data changes
// slowly. Cache key includes the active driver slug so toggling backends in
// /extensions immediately invalidates the previous backend's cached payload.
let _analyticsCache: { key: string; data: DashboardAnalytics; ts: number } | null = null;
const ANALYTICS_CACHE_TTL = 5 * 60 * 1000;

export async function queryAnalytics(db: SqliteDb, graph: GraphDriver | null): Promise<DashboardAnalytics> {
  const cacheKey = graph?.slug ?? "no-graph";
  // Only cache when we actually paid for a graph round-trip — cheap SQLite-only
  // recomputes don't need it and the shared module-level cache otherwise leaks
  // stale data between consecutive callers (notably bun:test shared processes).
  const cacheable = !!graph?.capabilities.cypher;
  if (cacheable && _analyticsCache && _analyticsCache.key === cacheKey && Date.now() - _analyticsCache.ts < ANALYTICS_CACHE_TTL) {
    return _analyticsCache.data;
  }
  // Contact insights from SQLite
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM contacts`).get() as { c: number }).c;
  const withEmail = (db.prepare(`SELECT COUNT(*) AS c FROM contacts WHERE email IS NOT NULL AND email <> ''`).get() as { c: number }).c;
  const withPhone = (db.prepare(`SELECT COUNT(*) AS c FROM contacts WHERE phone IS NOT NULL AND phone <> ''`).get() as { c: number }).c;
  const withCompany = (db.prepare(`SELECT COUNT(*) AS c FROM contacts WHERE company IS NOT NULL AND company <> ''`).get() as { c: number }).c;
  const withoutInteraction = (db.prepare(`SELECT COUNT(*) AS c FROM contacts WHERE last_interaction IS NULL`).get() as { c: number }).c;

  const relRows = db.prepare(
    `SELECT relationship AS key, COUNT(*) AS count FROM contacts GROUP BY relationship ORDER BY count DESC`,
  ).all() as Array<{ key: string; count: number }>;
  const byRelationship: Record<string, number> = {};
  for (const r of relRows) byRelationship[r.key] = r.count;

  // Source comes from google_sync_map (if available), else 'manual'
  let bySource: Record<string, number> = {};
  const sourceRows = safeAll<{ key: string; count: number }>(db,
    `SELECT COALESCE(m.source, 'manual') AS key, COUNT(*) AS count
     FROM contacts c
     LEFT JOIN google_sync_map m ON m.local_id = c.id
     GROUP BY key ORDER BY count DESC`,
  );
  if (sourceRows.length > 0) {
    for (const r of sourceRows) bySource[r.key] = r.count;
  } else {
    bySource = { manual: total };
  }

  // Top domains from SQLite
  const domainRows = db.prepare(`
    SELECT SUBSTR(email, INSTR(email, '@') + 1) AS domain, COUNT(*) AS count
    FROM contacts
    WHERE email IS NOT NULL AND email LIKE '%@%'
    GROUP BY domain ORDER BY count DESC LIMIT 15
  `).all() as Array<{ domain: string; count: number }>;

  // Top companies from SQLite
  const companyRows = db.prepare(`
    SELECT company, COUNT(*) AS count
    FROM contacts
    WHERE company IS NOT NULL AND company <> ''
    GROUP BY company ORDER BY count DESC LIMIT 15
  `).all() as Array<{ company: string; count: number }>;

  // Network data from Neo4j (if available)
  const network: DashboardAnalytics["network"] = {
    available: false, totalNodes: 0, totalRelationships: 0,
    components: 0, communities: 0,
    influencers: [], bridges: [], topCommunities: [],
    relationshipBreakdown: {},
  };

  let pipeline: PipelineStatus | null = null;

  if (graph?.capabilities.cypher) {
    try {
      // Quick check: if no Person nodes exist, skip all expensive graph queries
      const personCheck = await graph.run("MATCH (p:Person) WHERE p.relationship IS NOT NULL RETURN count(p) AS c LIMIT 1");
      const personCount = (personCheck.records[0]?.get("c") as { toNumber?(): number } | undefined)?.toNumber?.() ?? 0;

      if (personCount === 0) {
        // No Person nodes — skip graph analytics entirely
        network.available = false;
      } else {
      network.available = true;

      // Total nodes and relationships
      const countsResult = await graph.run(`
        MATCH (p:Person) WHERE p.relationship IS NOT NULL
        OPTIONAL MATCH (p)-[r:SAME_DOMAIN|SAME_COMPANY|KNOWS]-()
        RETURN count(DISTINCT p) AS nodes, count(DISTINCT r) AS rels
      `);
      if (countsResult.records.length > 0) {
        network.totalNodes = (countsResult.records[0].get("nodes") as { toNumber(): number }).toNumber();
        network.totalRelationships = (countsResult.records[0].get("rels") as { toNumber(): number }).toNumber();
      }

      const statsResult = await graph.run(`
        MATCH (p:Person) WHERE p.relationship IS NOT NULL AND p.componentId IS NOT NULL
        RETURN
          count(DISTINCT p.componentId) AS components,
          count(DISTINCT p.communityId) AS communities
      `);
      if (statsResult.records.length > 0) {
        network.components = (statsResult.records[0].get("components") as { toNumber(): number }).toNumber();
        network.communities = (statsResult.records[0].get("communities") as { toNumber(): number }).toNumber();
      }

      const influencersResult = await graph.run(`
        MATCH (p:Person)
        WHERE p.pageRank IS NOT NULL AND p.relationship IS NOT NULL
        RETURN p.name AS name, p.company AS company, p.pageRank AS score
        ORDER BY p.pageRank DESC LIMIT 10
      `);
      network.influencers = influencersResult.records.map(r => ({
        name: r.get("name") as string,
        company: r.get("company") as string | null,
        score: Number(r.get("score")),
      }));

      const bridgesResult = await graph.run(`
        MATCH (p:Person)
        WHERE p.betweenness IS NOT NULL AND p.betweenness > 0 AND p.relationship IS NOT NULL
        RETURN p.name AS name, p.company AS company, p.betweenness AS score
        ORDER BY p.betweenness DESC LIMIT 5
      `);
      network.bridges = bridgesResult.records.map(r => ({
        name: r.get("name") as string,
        company: r.get("company") as string | null,
        score: Number(r.get("score")),
      }));

      const commResult = await graph.run(`
        MATCH (p:Person)
        WHERE p.communityId IS NOT NULL AND p.relationship IS NOT NULL
        WITH p.communityId AS cid, collect(p) AS members
        WHERE size(members) > 1
        WITH cid, size(members) AS sz, members
        ORDER BY sz DESC LIMIT 10
        RETURN cid,
               sz,
               [m IN members | m.name][..5] AS memberNames,
               head([d IN [m IN members | m.emailDomain] WHERE d IS NOT NULL | d]) AS dominantDomain,
               head([c IN [m IN members | m.company] WHERE c IS NOT NULL AND c <> '' | c]) AS dominantCompany
      `);
      network.topCommunities = commResult.records.map(r => {
        const cidV = r.get("cid") as { toNumber?(): number };
        const szV = r.get("sz") as { toNumber?(): number };
        return {
          communityId: cidV?.toNumber ? cidV.toNumber() : Number(cidV),
          size: szV?.toNumber ? szV.toNumber() : Number(szV),
          dominantDomain: r.get("dominantDomain") as string | null,
          dominantCompany: r.get("dominantCompany") as string | null,
          members: r.get("memberNames") as string[],
        };
      });

      // Relationship breakdown by type
      const relBreakdown = await graph.run(`
        MATCH (p:Person)-[r:SAME_DOMAIN|SAME_COMPANY|KNOWS]-(q:Person)
        WHERE p.relationship IS NOT NULL AND q.relationship IS NOT NULL
        RETURN type(r) AS relType, count(DISTINCT r) AS cnt
      `);
      for (const r of relBreakdown.records) {
        const t = r.get("relType") as string;
        const cV = r.get("cnt") as { toNumber?(): number };
        const c = cV?.toNumber ? cV.toNumber() : Number(cV);
        network.relationshipBreakdown[t] = c;
      }

      // Pipeline status
      const pipelineResult = await graph.run(`
        MATCH (p:Person) WHERE p.relationship IS NOT NULL
        WITH count(p) AS total
        OPTIONAL MATCH (ed:Person) WHERE ed.relationship IS NOT NULL AND ed.emailDomain IS NOT NULL
        WITH total, count(ed) AS emailDomainsSet
        OPTIONAL MATCH ()-[sd:SAME_DOMAIN]->()
        WITH total, emailDomainsSet, count(sd) AS sameDomainRels
        OPTIONAL MATCH ()-[sc:SAME_COMPANY]->()
        WITH total, emailDomainsSet, sameDomainRels, count(sc) AS sameCompanyRels
        OPTIONAL MATCH (gds:Person) WHERE gds.relationship IS NOT NULL AND gds.componentId IS NOT NULL
        WITH total, emailDomainsSet, sameDomainRels, sameCompanyRels,
             count(DISTINCT gds.communityId) AS communities,
             count(DISTINCT gds.componentId) AS components
        OPTIONAL MATCH (pr:Person) WHERE pr.relationship IS NOT NULL AND pr.pageRank IS NOT NULL
        WITH total, emailDomainsSet, sameDomainRels, sameCompanyRels,
             communities, components, count(pr) AS nodesWithPageRank
        OPTIONAL MATCH (emb:Person) WHERE emb.relationship IS NOT NULL AND emb.embedding IS NOT NULL
        RETURN total, emailDomainsSet, sameDomainRels, sameCompanyRels,
               communities, components, nodesWithPageRank, count(emb) AS contactsWithEmbedding
      `);
      if (pipelineResult.records.length > 0) {
        const r = pipelineResult.records[0];
        const n = (field: string) => {
          const v = r.get(field) as { toNumber?(): number } | null | undefined;
          return v?.toNumber ? v.toNumber() : Number(v ?? 0);
        };
        const totalContacts = n("total");
        const emailDomainsSet = n("emailDomainsSet");
        const sameDomainRels = n("sameDomainRels");
        const sameCompanyRels = n("sameCompanyRels");
        const communities = n("communities");
        const components = n("components");
        const nodesWithPageRank = n("nodesWithPageRank");
        const contactsWithEmbedding = n("contactsWithEmbedding");

        pipeline = {
          enrichment: {
            ran: emailDomainsSet > 0 || sameDomainRels > 0 || sameCompanyRels > 0,
            emailDomainsSet, sameDomainRels, sameCompanyRels,
          },
          gds: {
            ran: nodesWithPageRank > 0,
            communities, components, nodesWithPageRank,
          },
          embeddings: {
            ran: contactsWithEmbedding > 0,
            contactsWithEmbedding, totalContacts,
          },
        };
      }
      } // end if (personCount > 0)
    } catch {
      // Neo4j analytics data not available (GDS not run yet)
      network.available = false;
    }
  }

  const result: DashboardAnalytics = {
    contactInsights: {
      total, withEmail, withPhone, withCompany,
      emailPct: total > 0 ? Math.round(withEmail / total * 100) : 0,
      phonePct: total > 0 ? Math.round(withPhone / total * 100) : 0,
      companyPct: total > 0 ? Math.round(withCompany / total * 100) : 0,
      byRelationship, bySource, withoutInteraction,
    },
    topDomains: domainRows,
    topCompanies: companyRows,
    network,
    pipeline,
  };
  if (cacheable) {
    _analyticsCache = { key: cacheKey, data: result, ts: Date.now() };
  }
  return result;
}

// ── Calendar ─────────────────────────────────────

function dateRange(startDate: string, dayCount: number): { start: string; end: string } {
  const s = new Date(startDate + "T00:00:00Z");
  const e = new Date(s);
  e.setUTCDate(e.getUTCDate() + dayCount);
  return {
    start: s.toISOString().split("T")[0],
    end: e.toISOString().split("T")[0],
  };
}

function expandRecurring(
  triggeredAt: string,
  repeat: string,
  start: string,
  end: string,
): string[] {
  const dates: string[] = [];
  const base = new Date(triggeredAt);
  const endD = new Date(end + "T00:00:00Z");
  let cur = new Date(base);

  for (let i = 0; i < 200; i++) {
    const ds = cur.toISOString().split("T")[0];
    if (ds >= end) break;
    if (ds >= start) dates.push(ds);
    if (repeat === "daily") cur.setUTCDate(cur.getUTCDate() + 1);
    else if (repeat === "weekly") cur.setUTCDate(cur.getUTCDate() + 7);
    else if (repeat === "monthly") cur.setUTCMonth(cur.getUTCMonth() + 1);
    else break;
    if (cur > endD) break;
  }
  return dates;
}

function pushEvent(days: Record<string, CalendarEvent[]>, date: string, ev: CalendarEvent): void {
  if (!days[date]) days[date] = [];
  days[date].push(ev);
}

export function queryCalendar(
  db: SqliteDb,
  startDate: string,
  dayCount: number,
  sysRegistry?: SystemRegistry,
): CalendarData {
  const { start, end } = dateRange(startDate, dayCount);
  const days: Record<string, CalendarEvent[]> = {};
  const overdue: CalendarEvent[] = [];

  // 1. Tasks with due_date (in range + overdue)
  {
    const rows = safeAll<{ id: string; title: string; due_date: string; priority: string; status: string }>(db,
      `SELECT id, title, due_date, priority, status FROM tasks
       WHERE due_date IS NOT NULL AND due_date >= ? AND due_date < ? AND status != 'done' AND deleted_at IS NULL
       ORDER BY due_date`,
      [start, end],
    );
    for (const r of rows) {
      pushEvent(days, r.due_date, {
        id: r.id, type: "task", title: r.title, time: null,
        color: "#5B9BF7", extra: r.priority,
      });
    }
    // Overdue tasks
    const od = safeAll<{ id: string; title: string; due_date: string; priority: string }>(db,
      `SELECT id, title, due_date, priority FROM tasks
       WHERE status NOT IN ('done') AND due_date IS NOT NULL AND due_date < ? AND deleted_at IS NULL
       ORDER BY due_date LIMIT 30`,
      [start],
    );
    for (const r of od) {
      overdue.push({ id: r.id, type: "task", title: r.title, time: r.due_date, color: "#5B9BF7", extra: r.priority });
    }
  }

  // 2. Reminders (one-shot + recurring expansion)
  {
    const oneShot = safeAll<{ id: string; title: string; trigger_at: string }>(db,
      `SELECT id, title, trigger_at FROM reminders
       WHERE status IN ('active','snoozed') AND repeat = 'none'
         AND trigger_at >= ? AND trigger_at < ?
       ORDER BY trigger_at`,
      [`${start}T00:00:00`, `${end}T00:00:00`],
    );
    for (const r of oneShot) {
      const d = r.trigger_at.split("T")[0];
      const t = r.trigger_at.split("T")[1]?.slice(0, 5) ?? null;
      pushEvent(days, d, {
        id: r.id, type: "reminder", title: r.title, time: t,
        color: "#F0883E", extra: null,
      });
    }

    // Recurring reminders
    const recurring = safeAll<{ id: string; title: string; trigger_at: string; repeat: string }>(db,
      `SELECT id, title, trigger_at, repeat FROM reminders
       WHERE status IN ('active','snoozed') AND repeat != 'none'`,
    );
    for (const r of recurring) {
      const t = r.trigger_at.split("T")[1]?.slice(0, 5) ?? null;
      const expanded = expandRecurring(r.trigger_at, r.repeat, start, end);
      for (const d of expanded) {
        pushEvent(days, d, {
          id: r.id + "-" + d, type: "reminder", title: r.title, time: t,
          color: "#F0883E", extra: r.repeat,
        });
      }
    }

    // Overdue reminders
    const odRem = safeAll<{ id: string; title: string; trigger_at: string }>(db,
      `SELECT id, title, trigger_at FROM reminders
       WHERE status IN ('active','snoozed') AND trigger_at < ?
       ORDER BY trigger_at LIMIT 20`,
      [new Date().toISOString()],
    );
    for (const r of odRem) {
      const t = r.trigger_at.split("T")[1]?.slice(0, 5) ?? null;
      overdue.push({ id: r.id, type: "reminder", title: r.title, time: t, color: "#F0883E", extra: null });
    }
  }

  // 3. Subscriptions (next_billing)
  {
    const rows = safeAll<{ id: string; name: string; next_billing: string; amount_cents: number; currency: string }>(db,
      `SELECT id, name, next_billing, amount_cents, currency FROM subscriptions
       WHERE status = 'active' AND next_billing >= ? AND next_billing < ?
       ORDER BY next_billing`,
      [start, end],
    );
    for (const r of rows) {
      pushEvent(days, r.next_billing, {
        id: r.id, type: "subscription", title: r.name, time: null,
        color: "#3DD68C", extra: (r.amount_cents / 100).toFixed(2) + " " + r.currency,
      });
    }
  }

  // 4. Health appointments
  {
    const rows = safeAll<{ id: string; title: string; date: string; provider: string }>(db,
      `SELECT id, title, date, provider FROM health_appointments
       WHERE status = 'scheduled' AND date >= ? AND date < ?
       ORDER BY date`,
      [start, end],
    );
    for (const r of rows) {
      pushEvent(days, r.date, {
        id: r.id, type: "health", title: r.title, time: null,
        color: "#F04770", extra: r.provider,
      });
    }
  }

  // 5. Home maintenance (next_due)
  {
    const rows = safeAll<{ id: string; name: string; next_due: string }>(db,
      `SELECT id, name, next_due FROM home_maintenance_items
       WHERE next_due IS NOT NULL AND next_due >= ? AND next_due < ?
       ORDER BY next_due`,
      [start, end],
    );
    for (const r of rows) {
      pushEvent(days, r.next_due, {
        id: r.id, type: "maintenance", title: r.name, time: null,
        color: "#D4A84B", extra: "home",
      });
    }
  }

  // 6. Vehicle maintenance (next_due_date)
  {
    const rows = safeAll<{ id: string; name: string; next_due_date: string; vehicle_name: string }>(db,
      `SELECT vm.id, vm.name, vm.next_due_date, v.name AS vehicle_name
       FROM vehicle_maintenance vm
       JOIN vehicles v ON v.id = vm.vehicle_id
       WHERE vm.next_due_date IS NOT NULL AND vm.next_due_date >= ? AND vm.next_due_date < ?
         AND v.deleted_at IS NULL
       ORDER BY vm.next_due_date`,
      [start, end],
    );
    for (const r of rows) {
      pushEvent(days, r.next_due_date, {
        id: r.id, type: "vehicle", title: r.name, time: null,
        color: "#D4A84B", extra: r.vehicle_name,
      });
    }
  }

  // 7. Vehicle inspections
  {
    const rows = safeAll<{ id: string; name: string; next_inspection: string }>(db,
      `SELECT id, name, next_inspection FROM vehicles
       WHERE deleted_at IS NULL AND next_inspection IS NOT NULL
         AND next_inspection >= ? AND next_inspection < ?`,
      [start, end],
    );
    for (const r of rows) {
      pushEvent(days, r.next_inspection, {
        id: r.id + "-insp", type: "vehicle", title: "Inspection: " + r.name, time: null,
        color: "#D4A84B", extra: null,
      });
    }
  }

  // 8. Documents (expiry_date)
  {
    const rows = safeAll<{ id: string; title: string; expiry_date: string }>(db,
      `SELECT id, title, expiry_date FROM documents
       WHERE deleted_at IS NULL AND expiry_date IS NOT NULL
         AND expiry_date >= ? AND expiry_date < ?
       ORDER BY expiry_date`,
      [start, end],
    );
    for (const r of rows) {
      pushEvent(days, r.expiry_date, {
        id: r.id, type: "document", title: r.title, time: null,
        color: "#6E738A", extra: "expires",
      });
    }
  }

  // 9. Goals (target_date)
  {
    const rows = safeAll<{ id: string; title: string; target_date: string }>(db,
      `SELECT id, title, target_date FROM goals
       WHERE status != 'cancelled' AND target_date IS NOT NULL
         AND target_date >= ? AND target_date < ?
       ORDER BY target_date`,
      [start, end],
    );
    for (const r of rows) {
      pushEvent(days, r.target_date, {
        id: r.id, type: "goal", title: r.title, time: null,
        color: "#3DD6C8", extra: null,
      });
    }
  }

  // 10. Meal plans
  {
    const rows = safeAll<{ id: string; meal_type: string; date: string; recipe_name: string | null }>(db,
      `SELECT mp.id, mp.meal_type, mp.date, r.name AS recipe_name
       FROM meal_plans mp
       LEFT JOIN recipes r ON r.id = mp.recipe_id
       WHERE mp.date >= ? AND mp.date < ?
       ORDER BY mp.date`,
      [start, end],
    );
    for (const r of rows) {
      pushEvent(days, r.date, {
        id: r.id, type: "meal", title: r.recipe_name ?? r.meal_type, time: null,
        color: "#da7756", extra: r.meal_type,
      });
    }
  }

  // 11. Research tasks (next_run_at)
  {
    const rows = safeAll<{ id: string; name: string; next_run_at: string }>(db,
      `SELECT id, name, next_run_at FROM research_tasks
       WHERE status = 'active' AND next_run_at IS NOT NULL
         AND next_run_at >= ? AND next_run_at < ?
       ORDER BY next_run_at`,
      [`${start}T00:00:00`, `${end}T00:00:00`],
    );
    for (const r of rows) {
      const d = r.next_run_at.split("T")[0];
      const t = r.next_run_at.split("T")[1]?.slice(0, 5) ?? null;
      pushEvent(days, d, {
        id: r.id, type: "research", title: r.name, time: t,
        color: "#8B7CF6", extra: null,
      });
    }
  }

  // 12. Insurance expiry (home_house singleton)
  {
    const house = safeGet(db,
      `SELECT insurance_expiry FROM home_house WHERE id = 'house-profile'`,
      [],
      undefined as { insurance_expiry: string | null } | undefined,
    );
    if (house?.insurance_expiry && house.insurance_expiry >= start && house.insurance_expiry < end) {
      pushEvent(days, house.insurance_expiry, {
        id: "insurance-expiry", type: "document", title: "Home Insurance Expiry", time: null,
        color: "#6E738A", extra: "insurance",
      });
    }
  }

  // 13. Events (from events module)
  {
    const rows = safeAll<{ id: string; title: string; start_at: string; type: string; status: string; duration_minutes: number }>(db,
      `SELECT id, title, start_at, type, status, duration_minutes FROM events
       WHERE status NOT IN ('cancelled','completed') AND start_at >= ? AND start_at < ?
       ORDER BY start_at`,
      [start + "T00:00:00", end + "T00:00:00"],
    );
    for (const r of rows) {
      const d = r.start_at.split("T")[0];
      const t = r.start_at.split("T")[1]?.slice(0, 5) ?? null;
      pushEvent(days, d, {
        id: r.id, type: "event", title: r.title, time: t,
        color: "#E879A8", extra: r.status === "draft" ? `${r.type} · draft` : r.type,
      });
    }
    // Overdue events (not cancelled/completed, start_at in the past)
    const od = safeAll<{ id: string; title: string; start_at: string; type: string }>(db,
      `SELECT id, title, start_at, type FROM events
       WHERE status NOT IN ('cancelled','completed') AND start_at < ?
       ORDER BY start_at DESC LIMIT 20`,
      [start + "T00:00:00"],
    );
    for (const r of od) {
      overdue.push({ id: r.id, type: "event", title: r.title, time: r.start_at, color: "#E879A8", extra: r.type });
    }
  }

  // 14. Agent schedules (automation runs) — expand cron over the calendar window
  // Cap expansions per agent so a `* * * * *` agent doesn't dump 43k events into the grid.
  if (tableExists(db, "agent_schedules") && tableExists(db, "agents")) {
    const rows = safeAll<{
      agent_id: string;
      agent_name: string;
      cron_expression: string;
      next_run_at: string;
      builtin_handler: string;
    }>(db,
      `SELECT s.agent_id, a.name AS agent_name, s.cron_expression, s.next_run_at, a.builtin_handler
       FROM agent_schedules s
       JOIN agents a ON a.id = s.agent_id
       WHERE s.active = 1 AND a.active = 1 AND s.cron_expression <> ''`,
    );

    const rangeStart = new Date(`${start}T00:00:00Z`);
    const rangeEnd = new Date(`${end}T00:00:00Z`);
    const MAX_PER_AGENT = 60; // hard cap per agent over the window

    for (const r of rows) {
      try {
        const interval = CronExpressionParser.parse(r.cron_expression, {
          tz: "UTC",
          currentDate: rangeStart,
          endDate: rangeEnd,
        });
        let count = 0;
        while (count < MAX_PER_AGENT) {
          let next: Date;
          try { next = interval.next().toDate(); } catch { break; }
          if (next >= rangeEnd) break;
          const dStr = next.toISOString().split("T")[0];
          const tStr = next.toISOString().split("T")[1].slice(0, 5);
          pushEvent(days, dStr, {
            id: `sched-${r.agent_id}-${next.getTime()}`,
            type: "automation",
            title: r.agent_name,
            time: tStr,
            color: r.builtin_handler ? "#8B7CF6" : "#3DD68C",
            extra: r.cron_expression,
          });
          count++;
        }
      } catch {
        // invalid cron — skip
      }
    }
  }

  // System processes
  const systemProcesses: CalendarData["systemProcesses"] = [];
  if (sysRegistry) {
    for (const proc of sysRegistry.list()) {
      if (proc.type === "interval" && proc.intervalMs) {
        systemProcesses.push({
          name: proc.name,
          module: proc.module,
          intervalMs: proc.intervalMs,
          nextRunAt: proc.nextRunAt,
        });
      }
    }
  }

  return { start, dayCount, days, overdue, systemProcesses };
}

// ── System Agenda (automated processes timeline) ──

const SYS_COLORS: Record<string, string> = {
  research: "#8B7CF6",
  interval: "#3DD6C8",
  cache: "#6E738A",
  watcher: "#D4A84B",
  listener: "#F0883E",
};

function formatInterval(ms: number): string {
  if (ms < 60_000) return Math.round(ms / 1000) + "s";
  if (ms < 3_600_000) return Math.round(ms / 60_000) + "min";
  if (ms < 86_400_000) return Math.round(ms / 3_600_000) + "h";
  return Math.round(ms / 86_400_000) + "d";
}

export function querySystemTimeline(
  db: SqliteDb,
  startDate: string,
  dayCount: number,
  sysRegistry?: SystemRegistry,
): CalendarData {
  const { start, end } = dateRange(startDate, dayCount);
  const days: Record<string, CalendarEvent[]> = {};
  const overdue: CalendarEvent[] = [];

  // 1. Research tasks — only show next scheduled run (punctual), don't expand daily
  {
    const rows = safeAll<{
      id: string; name: string; next_run_at: string;
      interval_minutes: number; status: string; last_run_at: string | null;
    }>(db,
      `SELECT id, name, next_run_at, interval_minutes, status, last_run_at
       FROM research_tasks WHERE status = 'active' AND next_run_at IS NOT NULL
       ORDER BY next_run_at`,
    );

    for (const r of rows) {
      const ds = r.next_run_at.split("T")[0];
      if (ds >= start && ds < end) {
        const t = r.next_run_at.split("T")[1]?.slice(0, 5) ?? null;
        pushEvent(days, ds, {
          id: r.id, type: "research", title: r.name,
          time: t, color: SYS_COLORS.research,
          extra: "every " + formatInterval(r.interval_minutes * 60_000),
        });
      }

      // Overdue check
      if (r.next_run_at < new Date().toISOString() && r.last_run_at) {
        overdue.push({
          id: r.id, type: "research", title: r.name,
          time: r.next_run_at.split("T")[1]?.slice(0, 5) ?? null,
          color: SYS_COLORS.research, extra: "overdue",
        });
      }
    }
  }

  // 2. System processes — all go to process monitor strip; only weekly+ go on calendar grid
  const WEEKLY_THRESHOLD = 7 * 24 * 3_600_000; // 7 days
  const systemProcesses: CalendarData["systemProcesses"] = [];
  if (sysRegistry) {
    for (const proc of sysRegistry.list()) {
      // All processes with intervals go to the process monitor strip
      if (proc.intervalMs || proc.ttlMs) {
        systemProcesses.push({
          name: proc.name,
          module: proc.module,
          intervalMs: proc.intervalMs ?? proc.ttlMs,
          nextRunAt: proc.nextRunAt,
          type: proc.type,
          description: proc.description,
          status: proc.status,
          lastRunAt: proc.lastRunAt,
          runCount: proc.runCount,
        });
      }

      // Only expand weekly+ interval processes into the calendar grid
      if (proc.type === "interval" && proc.intervalMs && proc.intervalMs >= WEEKLY_THRESHOLD && proc.nextRunAt) {
        const seenDays = new Set<string>();
        let cur = new Date(proc.nextRunAt).getTime();
        const endTime = new Date(end + "T00:00:00Z").getTime();
        for (let i = 0; i < 5000 && cur < endTime; i++) {
          const ds = new Date(cur).toISOString().split("T")[0];
          if (ds >= start && ds < end && !seenDays.has(ds)) {
            seenDays.add(ds);
            pushEvent(days, ds, {
              id: proc.id + "-" + ds, type: "interval", title: proc.name,
              time: null, color: SYS_COLORS.interval,
              extra: proc.module + " · every " + formatInterval(proc.intervalMs),
            });
          }
          cur += proc.intervalMs;
        }
      }

      // Cache refreshes — punctual, keep on calendar
      if (proc.type === "cache" && proc.nextRunAt) {
        const ds = proc.nextRunAt.split("T")[0];
        if (ds >= start && ds < end) {
          const t = proc.nextRunAt.split("T")[1]?.slice(0, 5) ?? null;
          pushEvent(days, ds, {
            id: proc.id, type: "cache", title: proc.name,
            time: t, color: SYS_COLORS.cache, extra: proc.module,
          });
        }
      }
    }
  }

  return { start, dayCount, days, overdue, systemProcesses };
}
