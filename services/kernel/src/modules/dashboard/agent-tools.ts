/**
 * Agent-shaped dashboard tools — focused on "MCP application" surfaces.
 *
 * The legacy `kernel_dashboard_morning` / _evening / _weekly tools return
 * markdown only. They're great for CLI consumption but waste capability on
 * web-based clients (Claude Desktop, ChatGPT) that can render UI.
 *
 * `kernel_today_card` is the first kernel tool that emits a real `_meta.ui`
 * block. The same call returns:
 *   * `text`              — markdown summary for CLI / legacy clients.
 *   * `structuredContent` — typed JSON payload for code_run composition.
 *   * `_meta.ui` (HTML)   — self-contained rendered card for capable clients.
 *
 * Reads cross-module data (tasks, events, comms drafts, trading) directly
 * from SQLite — no service plumbing required because every consumer table
 * is in the same database.
 */
import { z } from "zod";
import type { ToolDefinition, ToolResult } from "../../core/types.js";
import type { SqliteDb } from "../../core/db/sqlite.js";
import { tableExists } from "../../core/db/query-helpers.js";
import { errorResult, uiResult } from "../../core/helpers.js";
import { defineTool } from "../../core/tool-builder.js";

interface TaskRow {
  id: string;
  title: string;
  priority: string;
  due_date: string | null;
  status: string;
}

interface EventRow {
  id: string;
  title: string;
  start_at: string;
  end_at: string | null;
  location: string | null;
  status: string;
}

interface CommDraftRow {
  id: string;
  subject: string;
  recipients_to: string;
  updated_at: string;
}

interface TradeRow {
  symbol: string;
  side: string;
  amount: number;
  filled_price: number;
  pnl: number | null;
}

interface SessionRow {
  name: string;
  realized_pnl: number;
  trades_opened: number;
  trades_closed: number;
}

const TodayCardInput = z.object({
  accent: z.enum(["blue", "green", "amber", "rose", "violet"]).optional(),
});

const TodayCardOutput = z.object({
  date: z.string(),
  tasks: z.object({
    overdue: z.array(z.object({ id: z.string(), title: z.string(), due_date: z.string().nullable(), priority: z.string() })),
    today: z.array(z.object({ id: z.string(), title: z.string(), priority: z.string() })),
    urgent_count: z.number().int(),
  }),
  events: z.array(z.object({
    id: z.string(),
    title: z.string(),
    start_at: z.string(),
    end_at: z.string().nullable(),
    location: z.string().nullable(),
  })),
  drafts_pending: z.number().int(),
  trading: z.object({
    open_trades: z.number().int(),
    sessions_pnl: z.number(),
    active_sessions: z.array(z.object({
      name: z.string(),
      realized_pnl: z.number(),
      trades_opened: z.number().int(),
      trades_closed: z.number().int(),
    })),
  }),
});

export function buildTodayCard(db: SqliteDb): ToolDefinition {
  return defineTool({
    name: "kernel_today_card",
    description:
      "One-call snapshot of your day, returned as TEXT + structured JSON + an HTML 'ui' block. " +
      "Aggregates: today's events, overdue+due-today tasks, pending email drafts, open trades and " +
      "active session PnL. Capable clients (Claude Desktop, web harnesses) render the HTML card; " +
      "CLI clients see the markdown fallback. Use this whenever the agent or human asks 'what does " +
      "today look like'.",
    schema: TodayCardInput,
    outputSchema: TodayCardOutput,
    tags: ["dashboard", "today", "summary", "ui", "applications"],
    async handler({ accent }): Promise<ToolResult> {
      try {
        const today = new Date().toISOString().slice(0, 10);

        const data = collect(db, today);
        const text = renderText(data);
        const html = renderHtml(data, accent ?? "blue");
        const result = uiResult(text, "text/html", html);
        result.structuredContent = data;
        return result;
      } catch (err) {
        return errorResult(`today_card failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });
}

// ── Data aggregation ──────────────────────────────────────────

interface CardData {
  date: string;
  tasks: {
    overdue: Array<{ id: string; title: string; due_date: string | null; priority: string }>;
    today: Array<{ id: string; title: string; priority: string }>;
    urgent_count: number;
  };
  events: Array<{
    id: string;
    title: string;
    start_at: string;
    end_at: string | null;
    location: string | null;
  }>;
  drafts_pending: number;
  trading: {
    open_trades: number;
    sessions_pnl: number;
    active_sessions: Array<{
      name: string;
      realized_pnl: number;
      trades_opened: number;
      trades_closed: number;
    }>;
  };
}

function collect(db: SqliteDb, today: string): CardData {
  // Tasks
  const tasks = { overdue: [] as CardData["tasks"]["overdue"], today: [] as CardData["tasks"]["today"], urgent_count: 0 };
  if (tableExists(db, "tasks")) {
    const overdue = db
      .prepare(
        `SELECT id, title, priority, due_date, status FROM tasks
         WHERE status NOT IN ('done','cancelled') AND due_date IS NOT NULL AND due_date < ?
         ORDER BY due_date ASC LIMIT 10`,
      )
      .all(today) as TaskRow[];
    const dueToday = db
      .prepare(
        `SELECT id, title, priority, due_date, status FROM tasks
         WHERE status NOT IN ('done','cancelled') AND substr(due_date, 1, 10) = ?
         ORDER BY CASE priority
           WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4
         END LIMIT 10`,
      )
      .all(today) as TaskRow[];
    const urgent = db
      .prepare(
        `SELECT COUNT(*) AS n FROM tasks
         WHERE status NOT IN ('done','cancelled') AND priority IN ('urgent','high')`,
      )
      .get() as { n: number };
    tasks.overdue = overdue.map((t) => ({ id: t.id, title: t.title, due_date: t.due_date, priority: t.priority }));
    tasks.today = dueToday.map((t) => ({ id: t.id, title: t.title, priority: t.priority }));
    tasks.urgent_count = urgent.n;
  }

  // Events for today
  const events: CardData["events"] = [];
  if (tableExists(db, "events")) {
    const rows = db
      .prepare(
        `SELECT id, title, start_at, end_at, location, status FROM events
         WHERE substr(start_at, 1, 10) = ?
           AND (status IS NULL OR status NOT IN ('cancelled'))
         ORDER BY start_at ASC LIMIT 20`,
      )
      .all(today) as EventRow[];
    for (const e of rows) {
      events.push({ id: e.id, title: e.title, start_at: e.start_at, end_at: e.end_at, location: e.location });
    }
  }

  // Comms drafts pending
  let draftsPending = 0;
  if (tableExists(db, "communications")) {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM communications WHERE status = 'draft' AND channel = 'email'")
      .get() as { n: number };
    draftsPending = row.n;
  }

  // Trading
  const trading = { open_trades: 0, sessions_pnl: 0, active_sessions: [] as CardData["trading"]["active_sessions"] };
  if (tableExists(db, "trades")) {
    const row = db.prepare("SELECT COUNT(*) AS n FROM trades WHERE status = 'open'").get() as { n: number };
    trading.open_trades = row.n;
  }
  if (tableExists(db, "trading_sessions")) {
    const sess = db
      .prepare(
        `SELECT name, realized_pnl, trades_opened, trades_closed FROM trading_sessions
         WHERE status = 'running' ORDER BY updated_at DESC LIMIT 10`,
      )
      .all() as SessionRow[];
    trading.active_sessions = sess.map((s) => ({
      name: s.name,
      realized_pnl: s.realized_pnl,
      trades_opened: s.trades_opened,
      trades_closed: s.trades_closed,
    }));
    trading.sessions_pnl = sess.reduce((acc, s) => acc + (s.realized_pnl ?? 0), 0);
  }

  return { date: today, tasks, events, drafts_pending: draftsPending, trading };
}

// ── Renderers ─────────────────────────────────────────────────

function renderText(d: CardData): string {
  const lines: string[] = [`# Today — ${d.date}`];
  lines.push("");
  lines.push(`**${d.events.length} event(s) today** · **${d.tasks.today.length} task(s) due** · **${d.tasks.overdue.length} overdue** · **${d.drafts_pending} email draft(s)** · **${d.trading.open_trades} open trade(s)**`);

  if (d.events.length > 0) {
    lines.push("\n## Events");
    for (const e of d.events) {
      const t = e.start_at.slice(11, 16);
      lines.push(`- **${t}** ${e.title}${e.location ? ` _(${e.location})_` : ""}`);
    }
  }

  if (d.tasks.today.length > 0 || d.tasks.overdue.length > 0) {
    lines.push("\n## Tasks");
    for (const t of d.tasks.overdue) {
      lines.push(`- ⚠️ [${t.priority}] ${t.title} — overdue (${t.due_date})`);
    }
    for (const t of d.tasks.today) {
      lines.push(`- [${t.priority}] ${t.title} — today`);
    }
  }

  if (d.trading.active_sessions.length > 0) {
    lines.push("\n## Trading");
    for (const s of d.trading.active_sessions) {
      const sign = s.realized_pnl >= 0 ? "+" : "";
      lines.push(`- ${s.name}: ${sign}${s.realized_pnl.toFixed(2)} · ${s.trades_opened}/${s.trades_closed} trades`);
    }
  }

  return lines.join("\n");
}

const ACCENT_HEX: Record<"blue" | "green" | "amber" | "rose" | "violet", string> = {
  blue: "#2563eb",
  green: "#16a34a",
  amber: "#d97706",
  rose: "#e11d48",
  violet: "#7c3aed",
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function priorityBadge(p: string): string {
  const colors: Record<string, string> = {
    urgent: "#dc2626",
    high: "#ea580c",
    medium: "#0284c7",
    low: "#64748b",
  };
  const color = colors[p] ?? "#64748b";
  return `<span class="kt-badge" style="background:${color}1a;color:${color}">${escapeHtml(p)}</span>`;
}

function renderHtml(d: CardData, accent: keyof typeof ACCENT_HEX): string {
  const accentHex = ACCENT_HEX[accent];

  const events = d.events.length > 0
    ? `<section class="kt-section">
         <h3>Events <span class="kt-count">${d.events.length}</span></h3>
         <ul class="kt-list">${d.events.map((e) => `
           <li>
             <span class="kt-time">${escapeHtml(e.start_at.slice(11, 16))}</span>
             <span class="kt-title">${escapeHtml(e.title)}</span>
             ${e.location ? `<span class="kt-meta">${escapeHtml(e.location)}</span>` : ""}
           </li>`).join("")}</ul>
       </section>`
    : "";

  const taskItems = [
    ...d.tasks.overdue.map((t) => `
      <li class="kt-overdue">
        <span class="kt-warn">!</span>
        ${priorityBadge(t.priority)}
        <span class="kt-title">${escapeHtml(t.title)}</span>
        <span class="kt-meta">overdue · ${escapeHtml(t.due_date ?? "")}</span>
      </li>`),
    ...d.tasks.today.map((t) => `
      <li>
        ${priorityBadge(t.priority)}
        <span class="kt-title">${escapeHtml(t.title)}</span>
      </li>`),
  ];
  const tasks = taskItems.length > 0
    ? `<section class="kt-section">
         <h3>Tasks <span class="kt-count">${d.tasks.overdue.length} overdue · ${d.tasks.today.length} today</span></h3>
         <ul class="kt-list">${taskItems.join("")}</ul>
       </section>`
    : "";

  const trading = d.trading.active_sessions.length > 0
    ? `<section class="kt-section">
         <h3>Trading <span class="kt-count">${d.trading.open_trades} open</span></h3>
         <ul class="kt-list">${d.trading.active_sessions.map((s) => {
           const positive = s.realized_pnl >= 0;
           const color = positive ? "#16a34a" : "#dc2626";
           const sign = positive ? "+" : "";
           return `<li>
             <span class="kt-title">${escapeHtml(s.name)}</span>
             <span class="kt-meta">${s.trades_opened}/${s.trades_closed} trades</span>
             <span style="color:${color};font-variant-numeric:tabular-nums">${sign}${s.realized_pnl.toFixed(2)}</span>
           </li>`;
         }).join("")}</ul>
       </section>`
    : "";

  const drafts = d.drafts_pending > 0
    ? `<section class="kt-section">
         <h3>Inbox <span class="kt-count">${d.drafts_pending} draft(s) pending</span></h3>
       </section>`
    : "";

  const totals = [
    `<span class="kt-stat"><strong>${d.events.length}</strong> events</span>`,
    `<span class="kt-stat"><strong>${d.tasks.today.length}</strong> due</span>`,
    `<span class="kt-stat" style="color:${d.tasks.overdue.length > 0 ? "#dc2626" : "inherit"}"><strong>${d.tasks.overdue.length}</strong> overdue</span>`,
    `<span class="kt-stat"><strong>${d.trading.open_trades}</strong> trades</span>`,
  ].join("");

  return `<!doctype html><html><head><meta charset="utf-8"><style>
  .kt { font: 14px/1.5 system-ui,-apple-system,sans-serif; max-width: 720px; padding: 18px 22px; border-radius: 14px; border: 1px solid rgba(0,0,0,.08); box-shadow: 0 1px 4px rgba(0,0,0,.04); background: #fff; color: #0f172a; }
  .kt-head { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; border-bottom: 2px solid ${accentHex}22; padding-bottom: 10px; margin-bottom: 14px; }
  .kt-head h2 { margin: 0; font-size: 20px; color: ${accentHex}; }
  .kt-totals { display: flex; gap: 14px; font-size: 13px; color: #475569; }
  .kt-stat strong { color: #0f172a; font-variant-numeric: tabular-nums; margin-right: 2px; }
  .kt-section { margin: 14px 0; }
  .kt-section h3 { margin: 0 0 8px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.04em; color: #64748b; display: flex; gap: 10px; align-items: baseline; }
  .kt-count { font-size: 12px; font-weight: 400; text-transform: none; letter-spacing: 0; color: #94a3b8; }
  .kt-list { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; }
  .kt-list li { display: grid; grid-template-columns: max-content auto 1fr max-content; gap: 10px; align-items: baseline; padding: 6px 0; border-top: 1px dashed #e2e8f0; }
  .kt-list li:first-child { border-top: 0; }
  .kt-time { font-variant-numeric: tabular-nums; color: ${accentHex}; font-weight: 600; }
  .kt-title { color: #0f172a; }
  .kt-meta { color: #94a3b8; font-size: 12px; }
  .kt-badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; font-weight: 600; text-transform: capitalize; }
  .kt-warn { background: #fee2e2; color: #dc2626; font-weight: 700; padding: 0 6px; border-radius: 999px; font-size: 11px; }
  .kt-overdue .kt-title { color: #b91c1c; }
  @media (prefers-color-scheme: dark) {
    .kt { background: #0f172a; color: #e2e8f0; border-color: rgba(255,255,255,.08); }
    .kt-totals, .kt-section h3 { color: #94a3b8; }
    .kt-stat strong, .kt-title { color: #f1f5f9; }
    .kt-list li { border-color: #1e293b; }
    .kt-overdue .kt-title { color: #fca5a5; }
  }
  </style></head>
  <body><div class="kt">
    <div class="kt-head">
      <h2>Today — ${escapeHtml(d.date)}</h2>
      <div class="kt-totals">${totals}</div>
    </div>
    ${events}
    ${tasks}
    ${trading}
    ${drafts}
  </div></body></html>`;
}
