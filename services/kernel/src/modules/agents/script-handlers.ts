/**
 * Script Handlers — CLI-grade scripts that run as builtin agents in flows.
 *
 * Each script is deterministic (no LLM), fast, and can also run standalone
 * via `bun scripts/cli/<name>.ts`.
 *
 * Convention: handler keys use `script:` prefix to distinguish from
 * `check:` (automation) and `proactive:` (scheduled behavior).
 */

import type { SqliteDb } from "../../core/db/sqlite.js";
import type { BuiltinHandler, BuiltinHandlerContext } from "./builtin-handlers.js";
import { today, daysFromNow, safeQuery, safeQueryOne as safeOne } from "../../core/db/query-helpers.js";

function fmtBytes(b: number): string {
  if (b < 1024) return `${b}B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)}KB`;
  return `${(b / 1048576).toFixed(1)}MB`;
}

// ── 1. DB Health ───────────────────────────────

export function scriptDbHealth(ctx: BuiltinHandlerContext): BuiltinHandler {
  return async () => {
    const lines: string[] = ["# Database Health Report\n"];

    // Table sizes
    const tables = safeQuery<{ name: string }>(ctx.db,
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_migrations' ORDER BY name`,
    );

    const tableSizes: Array<{ name: string; rows: number }> = [];
    for (const t of tables) {
      const row = safeOne<{ c: number }>(ctx.db, `SELECT COUNT(*) as c FROM "${t.name}"`);
      tableSizes.push({ name: t.name, rows: row?.c ?? 0 });
    }
    tableSizes.sort((a, b) => b.rows - a.rows);

    lines.push(`## Tables (${tables.length})\n`);
    lines.push("| Table | Rows |");
    lines.push("|-------|------|");
    for (const t of tableSizes.slice(0, 20)) {
      lines.push(`| ${t.name} | ${t.rows} |`);
    }

    // DB file size
    try {
      const stat = safeOne<{ page_count: number; page_size: number }>(ctx.db,
        `SELECT (SELECT page_count FROM pragma_page_count()) as page_count, (SELECT page_size FROM pragma_page_size()) as page_size`,
      );
      if (stat) {
        const size = stat.page_count * stat.page_size;
        lines.push(`\n## Storage\n- DB size: **${fmtBytes(size)}**`);
      }
    } catch { /* pragma may not work */ }

    // Integrity check (quick)
    try {
      const result = safeOne<{ integrity_check: string }>(ctx.db, `PRAGMA quick_check`);
      const status = result?.integrity_check === "ok" ? "OK" : result?.integrity_check ?? "unknown";
      lines.push(`- Integrity: **${status}**`);
    } catch { /* */ }

    // Orphan checks
    const orphans: string[] = [];

    const orphanInteractions = safeOne<{ c: number }>(ctx.db,
      `SELECT COUNT(*) as c FROM interactions WHERE contact_id NOT IN (SELECT id FROM contacts)`,
    )?.c ?? 0;
    if (orphanInteractions > 0) orphans.push(`${orphanInteractions} orphaned interactions`);

    const orphanRuns = safeOne<{ c: number }>(ctx.db,
      `SELECT COUNT(*) as c FROM agent_runs WHERE agent_id NOT IN (SELECT id FROM agents)`,
    )?.c ?? 0;
    if (orphanRuns > 0) orphans.push(`${orphanRuns} orphaned agent runs`);

    const orphanSteps = safeOne<{ c: number }>(ctx.db,
      `SELECT COUNT(*) as c FROM agent_run_steps WHERE run_id NOT IN (SELECT id FROM agent_runs)`,
    )?.c ?? 0;
    if (orphanSteps > 0) orphans.push(`${orphanSteps} orphaned run steps`);

    const orphanAttach = safeOne<{ c: number }>(ctx.db,
      `SELECT COUNT(*) as c FROM comm_attachments WHERE comm_id NOT IN (SELECT id FROM communications)`,
    )?.c ?? 0;
    if (orphanAttach > 0) orphans.push(`${orphanAttach} orphaned attachments`);

    lines.push(`\n## Orphan Check`);
    if (orphans.length === 0) {
      lines.push("All clear — no orphaned records found.");
    } else {
      for (const o of orphans) lines.push(`- ${o}`);
    }

    // Migration versions
    const migs = safeQuery<{ module: string; version: number }>(ctx.db,
      `SELECT module, MAX(version) as version FROM _migrations GROUP BY module ORDER BY module`,
    );
    if (migs.length > 0) {
      lines.push(`\n## Migrations (${migs.length} modules)`);
      for (const m of migs) lines.push(`- ${m.module}: v${m.version}`);
    }

    return lines.join("\n");
  };
}

// ── 2. Contacts Dedup ──────────────────────────

export function scriptContactsDedup(ctx: BuiltinHandlerContext): BuiltinHandler {
  return async () => {
    const lines: string[] = ["# Contact Deduplication Report\n"];

    // By email
    const emailDups = safeQuery<{ email: string; cnt: number; names: string }>(ctx.db,
      `SELECT email, COUNT(*) as cnt, GROUP_CONCAT(name, ' | ') as names
       FROM contacts WHERE email <> ''
       GROUP BY LOWER(email) HAVING cnt > 1
       ORDER BY cnt DESC LIMIT 20`,
    );

    if (emailDups.length > 0) {
      lines.push(`## Duplicate Emails (${emailDups.length})\n`);
      for (const d of emailDups) {
        lines.push(`- **${d.email}** (${d.cnt}x): ${d.names}`);
      }
    }

    // By phone
    const phoneDups = safeQuery<{ phone: string; cnt: number; names: string }>(ctx.db,
      `SELECT phone, COUNT(*) as cnt, GROUP_CONCAT(name, ' | ') as names
       FROM contacts WHERE phone <> ''
       GROUP BY REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '+', '') HAVING cnt > 1
       ORDER BY cnt DESC LIMIT 20`,
    );

    if (phoneDups.length > 0) {
      lines.push(`\n## Duplicate Phones (${phoneDups.length})\n`);
      for (const d of phoneDups) {
        lines.push(`- **${d.phone}** (${d.cnt}x): ${d.names}`);
      }
    }

    // By exact name
    const nameDups = safeQuery<{ name: string; cnt: number; ids: string }>(ctx.db,
      `SELECT name, COUNT(*) as cnt, GROUP_CONCAT(id, ',') as ids
       FROM contacts
       GROUP BY LOWER(TRIM(name)) HAVING cnt > 1
       ORDER BY cnt DESC LIMIT 20`,
    );

    if (nameDups.length > 0) {
      lines.push(`\n## Duplicate Names (${nameDups.length})\n`);
      for (const d of nameDups) {
        lines.push(`- **${d.name}** (${d.cnt}x)`);
      }
    }

    // Data quality
    const total = safeOne<{ c: number }>(ctx.db, `SELECT COUNT(*) as c FROM contacts`)?.c ?? 0;
    const noEmail = safeOne<{ c: number }>(ctx.db, `SELECT COUNT(*) as c FROM contacts WHERE email = ''`)?.c ?? 0;
    const noPhone = safeOne<{ c: number }>(ctx.db, `SELECT COUNT(*) as c FROM contacts WHERE phone = ''`)?.c ?? 0;
    const noCompany = safeOne<{ c: number }>(ctx.db, `SELECT COUNT(*) as c FROM contacts WHERE company = ''`)?.c ?? 0;
    const noInteraction = safeOne<{ c: number }>(ctx.db, `SELECT COUNT(*) as c FROM contacts WHERE last_interaction IS NULL`)?.c ?? 0;

    lines.push(`\n## Data Quality (${total} contacts)\n`);
    lines.push(`| Field | Missing | % |`);
    lines.push(`|-------|---------|---|`);
    lines.push(`| Email | ${noEmail} | ${total ? Math.round(noEmail / total * 100) : 0}% |`);
    lines.push(`| Phone | ${noPhone} | ${total ? Math.round(noPhone / total * 100) : 0}% |`);
    lines.push(`| Company | ${noCompany} | ${total ? Math.round(noCompany / total * 100) : 0}% |`);
    lines.push(`| Never contacted | ${noInteraction} | ${total ? Math.round(noInteraction / total * 100) : 0}% |`);

    const totalDups = emailDups.length + phoneDups.length + nameDups.length;
    if (totalDups === 0) {
      lines.push("\nNo duplicates found.");
    }

    return lines.join("\n");
  };
}

// ── 3. Today's Agenda ──────────────────────────

export function scriptToday(ctx: BuiltinHandlerContext): BuiltinHandler {
  return async () => {
    const d = today();
    const lines: string[] = [`# Today — ${d}\n`];

    // Overdue tasks
    const overdue = safeQuery<{ title: string; priority: string; due_date: string }>(ctx.db,
      `SELECT title, priority, due_date FROM tasks
       WHERE status NOT IN ('done','cancelled') AND due_date IS NOT NULL AND due_date < ?
       ORDER BY due_date LIMIT 10`, d,
    );
    if (overdue.length > 0) {
      lines.push(`## Overdue (${overdue.length})\n`);
      for (const t of overdue) lines.push(`- [${t.priority}] **${t.title}** (due ${t.due_date})`);
    }

    // Today's tasks
    const todayTasks = safeQuery<{ title: string; priority: string; status: string }>(ctx.db,
      `SELECT title, priority, status FROM tasks
       WHERE status NOT IN ('done','cancelled') AND date(due_date) = ?
       ORDER BY CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END`, d,
    );
    if (todayTasks.length > 0) {
      lines.push(`\n## Tasks Due Today (${todayTasks.length})\n`);
      for (const t of todayTasks) lines.push(`- [${t.priority}] **${t.title}** (${t.status})`);
    }

    // Upcoming reminders (next 24h)
    const reminders = safeQuery<{ title: string; trigger_at: string }>(ctx.db,
      `SELECT title, trigger_at FROM reminders
       WHERE status = 'active' AND trigger_at > datetime('now') AND trigger_at < datetime('now', '+24 hours')
       ORDER BY trigger_at LIMIT 10`,
    );
    if (reminders.length > 0) {
      lines.push(`\n## Reminders (next 24h: ${reminders.length})\n`);
      for (const r of reminders) {
        const time = new Date(r.trigger_at).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
        lines.push(`- ${time} — ${r.title}`);
      }
    }

    // Today's events
    const events = safeQuery<{ title: string; start_at: string; location: string }>(ctx.db,
      `SELECT title, start_at, location FROM events
       WHERE status NOT IN ('cancelled') AND date(start_at) = ?
       ORDER BY start_at`, d,
    );
    if (events.length > 0) {
      lines.push(`\n## Events Today (${events.length})\n`);
      for (const e of events) {
        const time = new Date(e.start_at).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
        lines.push(`- ${time} — **${e.title}**${e.location ? ` @ ${e.location}` : ""}`);
      }
    }

    // Health appointments today
    const appts = safeQuery<{ title: string; date: string; provider: string }>(ctx.db,
      `SELECT title, date, provider FROM health_appointments
       WHERE status = 'scheduled' AND date(date) = ?
       ORDER BY date`, d,
    );
    if (appts.length > 0) {
      lines.push(`\n## Health Appointments\n`);
      for (const a of appts) lines.push(`- **${a.title}** — ${a.provider}`);
    }

    if (lines.length === 1) lines.push("Nothing scheduled for today.");

    return lines.join("\n");
  };
}

// ── 4. Maintenance Due ─────────────────────────

export function scriptMaintenanceDue(ctx: BuiltinHandlerContext): BuiltinHandler {
  return async () => {
    const d = today();
    const horizon = daysFromNow(30);
    const lines: string[] = ["# Maintenance Due (next 30 days)\n"];

    // Home maintenance
    const homeMaint = safeQuery<{ name: string; next_due: string; priority: string }>(ctx.db,
      `SELECT name, next_due, priority FROM home_maintenance_items
       WHERE next_due IS NOT NULL AND next_due <= ?
       ORDER BY next_due LIMIT 15`, horizon,
    );
    if (homeMaint.length > 0) {
      const overdueCount = homeMaint.filter(m => m.next_due < d).length;
      lines.push(`## Home (${homeMaint.length} items, ${overdueCount} overdue)\n`);
      for (const m of homeMaint) {
        const flag = m.next_due < d ? " **OVERDUE**" : "";
        lines.push(`- [${m.priority}] **${m.name}** — due ${m.next_due}${flag}`);
      }
    }

    // Vehicle maintenance
    const vehicleMaint = safeQuery<{ task_name: string; vehicle_name: string; next_due_date: string; next_due_km: number | null }>(ctx.db,
      `SELECT vm.task_name, v.name AS vehicle_name, vm.next_due_date, vm.next_due_km
       FROM vehicle_maintenance vm JOIN vehicles v ON v.id = vm.vehicle_id
       WHERE v.deleted_at IS NULL AND (vm.next_due_date IS NOT NULL AND vm.next_due_date <= ?)
       ORDER BY vm.next_due_date LIMIT 15`, horizon,
    );
    if (vehicleMaint.length > 0) {
      const overdueCount = vehicleMaint.filter(m => m.next_due_date < d).length;
      lines.push(`\n## Vehicles (${vehicleMaint.length} items, ${overdueCount} overdue)\n`);
      for (const m of vehicleMaint) {
        const flag = m.next_due_date < d ? " **OVERDUE**" : "";
        const km = m.next_due_km ? ` / ${m.next_due_km}km` : "";
        lines.push(`- **${m.task_name}** (${m.vehicle_name}) — due ${m.next_due_date}${km}${flag}`);
      }
    }

    // Document expiry
    const docs = safeQuery<{ title: string; expiry_date: string }>(ctx.db,
      `SELECT title, expiry_date FROM documents
       WHERE deleted_at IS NULL AND expiry_date IS NOT NULL AND expiry_date <= ?
       ORDER BY expiry_date LIMIT 15`, horizon,
    );
    if (docs.length > 0) {
      const expired = docs.filter(d2 => d2.expiry_date < d).length;
      lines.push(`\n## Documents (${docs.length} expiring, ${expired} expired)\n`);
      for (const doc of docs) {
        const flag = doc.expiry_date < d ? " **EXPIRED**" : "";
        lines.push(`- **${doc.title}** — expires ${doc.expiry_date}${flag}`);
      }
    }

    // Warranty expiry
    const warranties = safeQuery<{ name: string; warranty_expiry: string }>(ctx.db,
      `SELECT name, warranty_expiry FROM home_appliances
       WHERE deleted_at IS NULL AND warranty_expiry IS NOT NULL AND warranty_expiry <= ?
       ORDER BY warranty_expiry LIMIT 10`, horizon,
    );
    if (warranties.length > 0) {
      lines.push(`\n## Warranties Expiring (${warranties.length})\n`);
      for (const w of warranties) {
        lines.push(`- **${w.name}** — expires ${w.warranty_expiry}`);
      }
    }

    if (lines.length === 1) lines.push("All clear — nothing due in the next 30 days.");

    return lines.join("\n");
  };
}

// ── 5. Cleanup ─────────────────────────────────

export function scriptCleanup(ctx: BuiltinHandlerContext): BuiltinHandler {
  return async () => {
    const lines: string[] = ["# Cleanup Report\n"];
    let totalCleaned = 0;

    // Clean stale agent runs (failed/cancelled older than 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const staleSteps = safeOne<{ c: number }>(ctx.db,
      `SELECT COUNT(*) as c FROM agent_run_steps WHERE run_id IN (
         SELECT id FROM agent_runs WHERE status IN ('failed','cancelled') AND created_at < ?
       )`, thirtyDaysAgo,
    )?.c ?? 0;

    if (staleSteps > 0) {
      ctx.db.prepare(
        `DELETE FROM agent_run_steps WHERE run_id IN (
           SELECT id FROM agent_runs WHERE status IN ('failed','cancelled') AND created_at < ?
         )`,
      ).run(thirtyDaysAgo);
      lines.push(`- Removed ${staleSteps} stale run steps (>30d failed/cancelled)`);
      totalCleaned += staleSteps;
    }

    const staleRuns = safeOne<{ c: number }>(ctx.db,
      `SELECT COUNT(*) as c FROM agent_runs WHERE status IN ('failed','cancelled') AND created_at < ?`, thirtyDaysAgo,
    )?.c ?? 0;

    if (staleRuns > 0) {
      ctx.db.prepare(
        `DELETE FROM agent_runs WHERE status IN ('failed','cancelled') AND created_at < ?`,
      ).run(thirtyDaysAgo);
      lines.push(`- Removed ${staleRuns} stale agent runs (>30d failed/cancelled)`);
      totalCleaned += staleRuns;
    }

    // Completed runs of BUILTIN agents (no LLM, zero tokens) older than 30
    // days. These are the high-frequency polls — the offline monitor alone
    // writes a row every 5 minutes, forever — and nothing pruned them, so they
    // came to dominate both the table and the dashboard's "Recent Runs" panel.
    // LLM runs are left alone: they cost money and are worth keeping.
    const BUILTIN_COMPLETED = `FROM agent_runs WHERE status = 'completed' AND created_at < ?
         AND agent_id IN (SELECT id FROM agents WHERE builtin_handler IS NOT NULL AND builtin_handler <> '')`;

    const staleBuiltinSteps = safeOne<{ c: number }>(ctx.db,
      `SELECT COUNT(*) as c FROM agent_run_steps WHERE run_id IN (SELECT id ${BUILTIN_COMPLETED})`, thirtyDaysAgo,
    )?.c ?? 0;

    if (staleBuiltinSteps > 0) {
      ctx.db.prepare(
        `DELETE FROM agent_run_steps WHERE run_id IN (SELECT id ${BUILTIN_COMPLETED})`,
      ).run(thirtyDaysAgo);
      totalCleaned += staleBuiltinSteps;
    }

    const staleBuiltinRuns = safeOne<{ c: number }>(ctx.db,
      `SELECT COUNT(*) as c ${BUILTIN_COMPLETED}`, thirtyDaysAgo,
    )?.c ?? 0;

    if (staleBuiltinRuns > 0) {
      ctx.db.prepare(`DELETE ${BUILTIN_COMPLETED}`).run(thirtyDaysAgo);
      lines.push(`- Removed ${staleBuiltinRuns} completed builtin runs (>30d, no-LLM polls)`);
      totalCleaned += staleBuiltinRuns;
    }

    // Clean old event log entries (>30 days)
    const oldEventLogs = safeOne<{ c: number }>(ctx.db,
      `SELECT COUNT(*) as c FROM agent_event_log WHERE created_at < ?`, thirtyDaysAgo,
    )?.c ?? 0;

    if (oldEventLogs > 0) {
      ctx.db.prepare(`DELETE FROM agent_event_log WHERE created_at < ?`).run(thirtyDaysAgo);
      lines.push(`- Removed ${oldEventLogs} old event log entries (>30d)`);
      totalCleaned += oldEventLogs;
    }

    // Clean read notifications (>7 days)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const oldNotifs = safeOne<{ c: number }>(ctx.db,
      `SELECT COUNT(*) as c FROM notifications WHERE read = 1 AND created_at < ?`, sevenDaysAgo,
    )?.c ?? 0;

    if (oldNotifs > 0) {
      ctx.db.prepare(`DELETE FROM notifications WHERE read = 1 AND created_at < ?`).run(sevenDaysAgo);
      lines.push(`- Removed ${oldNotifs} read notifications (>7d)`);
      totalCleaned += oldNotifs;
    }

    // Clean dismissed reminders (>30 days)
    const oldDismissed = safeOne<{ c: number }>(ctx.db,
      `SELECT COUNT(*) as c FROM reminders WHERE status = 'dismissed' AND updated_at < ?`, thirtyDaysAgo,
    )?.c ?? 0;

    if (oldDismissed > 0) {
      ctx.db.prepare(`DELETE FROM reminders WHERE status = 'dismissed' AND updated_at < ?`).run(thirtyDaysAgo);
      lines.push(`- Removed ${oldDismissed} dismissed reminders (>30d)`);
      totalCleaned += oldDismissed;
    }

    // Summary
    if (totalCleaned === 0) {
      lines.push("Nothing to clean up — database is tidy.");
    } else {
      lines.push(`\n**Total cleaned: ${totalCleaned} records**`);
    }

    // SQLite vacuum suggestion
    const fragCheck = safeOne<{ freelist_count: number }>(ctx.db, `PRAGMA freelist_count`);
    if (fragCheck && fragCheck.freelist_count > 100) {
      lines.push(`\nHint: ${fragCheck.freelist_count} free pages — run VACUUM to reclaim space.`);
    }

    return lines.join("\n");
  };
}

// ── 6. Export Module ───────────────────────────

export function scriptExport(ctx: BuiltinHandlerContext): BuiltinHandler {
  return async () => {
    // Export summary of all modules as structured JSON overview
    const modules: Record<string, number> = {};
    const tables = [
      "contacts", "interactions", "tasks", "reminders", "events", "event_attendees",
      "communications", "shopping_lists", "products", "purchases",
      "home_appliances", "home_maintenance_items", "home_projects", "home_incidents",
      "vehicles", "vehicle_maintenance", "documents", "goals", "key_results",
      "notes", "time_entries", "subscriptions", "health_metrics", "health_appointments",
      "health_medications", "recipes", "meal_plans", "agents", "agent_runs",
      "chat_episodes", "chat_messages", "research_tasks",
    ];

    for (const t of tables) {
      const row = safeOne<{ c: number }>(ctx.db, `SELECT COUNT(*) as c FROM "${t}"`);
      if (row && row.c > 0) modules[t] = row.c;
    }

    const lines: string[] = ["# Data Export Summary\n"];
    lines.push("| Module | Records |");
    lines.push("|--------|---------|");

    const sorted = Object.entries(modules).sort((a, b) => b[1] - a[1]);
    let total = 0;
    for (const [table, count] of sorted) {
      lines.push(`| ${table} | ${count} |`);
      total += count;
    }
    lines.push(`| **TOTAL** | **${total}** |`);

    return lines.join("\n");
  };
}

// ── 7. Auto-Trader (mechanical) ─────────────────

export function scriptAutoTrader(ctx: BuiltinHandlerContext): BuiltinHandler {
  return async () => {
    const lines: string[] = ["# Auto-Trader Run\n"];

    // Find active trading strategies
    const strategies = safeQuery<{
      id: string; name: string; account_id: string; symbols: string;
      timeframe: string; max_position_pct: number; max_open_trades: number;
      stop_loss_pct: number; take_profit_pct: number; cooldown_ms: number;
      last_signal_at: string | null; status: string;
    }>(ctx.db,
      "SELECT * FROM trading_strategies WHERE status = 'active'",
    );

    if (strategies.length === 0) {
      return "No active trading strategies. Create one and set status to 'active'.";
    }

    for (const strategy of strategies) {
      const symbols: string[] = JSON.parse(strategy.symbols);
      lines.push(`## ${strategy.name}\n`);

      // Check cooldown
      if (strategy.last_signal_at) {
        const elapsed = Date.now() - new Date(strategy.last_signal_at).getTime();
        if (elapsed < strategy.cooldown_ms) {
          lines.push(`Cooldown: ${Math.round((strategy.cooldown_ms - elapsed) / 1000)}s remaining\n`);
          continue;
        }
      }

      // Check open trades
      const openCount = safeOne<{ c: number }>(ctx.db,
        "SELECT COUNT(*) as c FROM trades WHERE account_id = ? AND status IN ('open','partial')",
        strategy.account_id,
      )?.c ?? 0;

      if (openCount >= strategy.max_open_trades) {
        lines.push(`Max open trades reached (${openCount}/${strategy.max_open_trades})\n`);
        continue;
      }

      // Run formulas on each symbol (paper trade only — script doesn't execute real trades)
      for (const symbol of symbols) {
        try {
          // Fetch candles via the formula_paper_trades pattern
          // The script uses paper trading to track performance without real execution
          const paperTrades = safeQuery<{ formula_id: string; side: string; pnl: number }>(ctx.db,
            `SELECT formula_id, side, pnl FROM formula_paper_trades
             WHERE symbol = ? AND status = 'closed'
             ORDER BY created_at DESC LIMIT 30`, symbol,
          );

          const buys = paperTrades.filter(t => t.side === "buy" && (t.pnl ?? 0) > 0).length;
          const sells = paperTrades.filter(t => t.side === "sell" && (t.pnl ?? 0) > 0).length;
          const totalPnl = paperTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);

          lines.push(`**${symbol}**: ${paperTrades.length} paper trades, P&L: ${totalPnl.toFixed(4)}, wins: ${buys + sells}/${paperTrades.length}`);
        } catch (err) {
          lines.push(`**${symbol}**: error — ${err}`);
        }
      }
      lines.push("");
    }

    return lines.join("\n");
  };
}

// ── Registry ───────────────────────────────────

export const SCRIPT_AGENT_DEFS: Array<{
  handler: string;
  name: string;
  description: string;
  cron: string;
  flow: string;
}> = [
  { handler: "script:db-health",       name: "DB Health Check",       description: "Database integrity, table sizes, orphaned records",   cron: "0 3 * * 0",     flow: "Scripts" },
  { handler: "script:contacts-dedup",  name: "Contact Dedup",         description: "Find duplicate contacts by email, phone, name",       cron: "0 4 * * 1",     flow: "Scripts" },
  { handler: "script:today",           name: "Today's Agenda",        description: "Tasks, reminders, events, appointments for today",    cron: "0 6 * * *",     flow: "Scripts" },
  { handler: "script:maintenance-due", name: "Maintenance Due",       description: "Home, vehicle, document, warranty maintenance due",   cron: "0 8 * * 1",     flow: "Scripts" },
  { handler: "script:cleanup",         name: "Data Cleanup",          description: "Clean stale runs, old logs, dismissed reminders",     cron: "0 4 * * 0",     flow: "Scripts" },
  { handler: "script:export-summary",  name: "Data Export Summary",   description: "Record counts across all modules",                   cron: "0 5 1 * *",     flow: "Scripts" },
  { handler: "script:auto-trader",    name: "Auto-Trader (Script)",  description: "Mechanical trading: run formulas, track paper trades, report performance", cron: "*/5 * * * *", flow: "Trading" },
];

export function createScriptHandlers(ctx: BuiltinHandlerContext): Map<string, BuiltinHandler> {
  const map = new Map<string, BuiltinHandler>();
  map.set("script:db-health",       scriptDbHealth(ctx));
  map.set("script:contacts-dedup",  scriptContactsDedup(ctx));
  map.set("script:today",           scriptToday(ctx));
  map.set("script:maintenance-due", scriptMaintenanceDue(ctx));
  map.set("script:cleanup",         scriptCleanup(ctx));
  map.set("script:export-summary",  scriptExport(ctx));
  map.set("script:auto-trader",    scriptAutoTrader(ctx));
  return map;
}
