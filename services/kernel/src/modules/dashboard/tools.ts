import type { ToolDefinition } from "../../core/types.js";
import type { SqliteDb } from "../../core/db/sqlite.js";
import { textResult } from "../../core/helpers.js";
import { defineToolNoInput } from "../../core/tool-builder.js";

// Minimal row shapes for the entity tables this module queries directly via
// SQL. The full domain types live in the owning extensions (tasks / crm /
// reminders / shopping); dashboard only needs the columns it formats, so we
// declare just those — no import from the extension.
interface TaskRow {
  title: string;
  priority: string;
  status: string;
  due_date: string | null;
}
interface ReminderRow {
  title: string;
  trigger_at: string;
  repeat: string;
  last_fired_at: string | null;
}
interface ContactRow {
  name: string;
  last_interaction: string | null;
}
interface ProductRow {
  name: string;
  current_stock: number;
  min_stock: number;
  unit: string;
}
interface ShoppingListRow {
  id: string;
  name: string;
}

export function dashboardTools(db: SqliteDb): ToolDefinition[] {
  return [
    defineToolNoInput({
      name: "kernel_dashboard_morning",
      description:
        "Morning briefing: today's tasks, overdue items, upcoming deadlines, contacts needing follow-up. Your daily overview.",
      handler: async () => {
        const today = new Date().toISOString().split("T")[0];
        const sections: string[] = ["# Morning Briefing", `Date: ${today}`, ""];

        // Urgent & high-priority tasks
        const urgentTasks = db
          .prepare(
            `SELECT * FROM tasks WHERE status IN ('todo','in_progress')
             AND priority IN ('urgent','high')
             ORDER BY CASE priority WHEN 'urgent' THEN 0 ELSE 1 END`,
          )
          .all() as TaskRow[];

        sections.push(`## Priority Tasks (${urgentTasks.length})`);
        if (urgentTasks.length > 0) {
          for (const t of urgentTasks) {
            sections.push(
              `- [${t.priority.toUpperCase()}] ${t.title}${t.due_date ? ` (due: ${t.due_date})` : ""}`,
            );
          }
        } else {
          sections.push("No urgent/high priority tasks.");
        }
        sections.push("");

        // Overdue tasks
        const overdue = db
          .prepare(
            `SELECT * FROM tasks WHERE status NOT IN ('done')
             AND due_date IS NOT NULL AND due_date < ?
             ORDER BY due_date`,
          )
          .all(today) as TaskRow[];

        sections.push(`## Overdue (${overdue.length})`);
        if (overdue.length > 0) {
          for (const t of overdue) {
            sections.push(`- ${t.title} (was due: ${t.due_date})`);
          }
        } else {
          sections.push("Nothing overdue!");
        }
        sections.push("");

        // Due today
        const dueToday = db
          .prepare(
            `SELECT * FROM tasks WHERE status NOT IN ('done') AND due_date = ?`,
          )
          .all(today) as TaskRow[];

        sections.push(`## Due Today (${dueToday.length})`);
        if (dueToday.length > 0) {
          for (const t of dueToday) {
            sections.push(`- ${t.title} [${t.status}]`);
          }
        } else {
          sections.push("No deadlines today.");
        }
        sections.push("");

        // Upcoming reminders (next 12h)
        const in12h = new Date(Date.now() + 12 * 3600000).toISOString();
        const upcomingReminders = db
          .prepare(
            `SELECT * FROM reminders
             WHERE status IN ('active','snoozed') AND trigger_at <= ?
             ORDER BY trigger_at ASC`,
          )
          .all(in12h) as ReminderRow[];

        sections.push(`## Upcoming Reminders — next 12h (${upcomingReminders.length})`);
        if (upcomingReminders.length > 0) {
          for (const r of upcomingReminders) {
            sections.push(
              `- ${r.trigger_at.split("T")[1]?.slice(0, 5) ?? r.trigger_at} — ${r.title}${r.repeat !== "none" ? ` (${r.repeat})` : ""}`,
            );
          }
        } else {
          sections.push("No reminders in the next 12 hours.");
        }
        sections.push("");

        // Total task stats
        const stats = db
          .prepare(
            `SELECT status, COUNT(*) as count FROM tasks GROUP BY status`,
          )
          .all() as Array<{ status: string; count: number }>;

        sections.push("## Task Stats");
        for (const s of stats) {
          sections.push(`- ${s.status}: ${s.count}`);
        }
        sections.push("");

        // Stale contacts (no interaction in 30+ days)
        const staleContacts = db
          .prepare(
            `SELECT * FROM contacts
             WHERE last_interaction IS NOT NULL
             AND last_interaction < date('now', '-30 days')
             ORDER BY last_interaction
             LIMIT 5`,
          )
          .all() as ContactRow[];

        sections.push(`## Contacts Needing Follow-up (${staleContacts.length})`);
        if (staleContacts.length > 0) {
          for (const c of staleContacts) {
            sections.push(`- ${c.name} — last: ${c.last_interaction}`);
          }
        } else {
          sections.push("All contacts are up to date.");
        }
        sections.push("");

        // Completed yesterday
        const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];
        const completedYesterday = db
          .prepare(
            `SELECT * FROM tasks WHERE status = 'done'
             AND updated_at >= ? AND updated_at < ?`,
          )
          .all(`${yesterday}T00:00:00`, `${today}T00:00:00`) as TaskRow[];

        sections.push(`## Completed Yesterday (${completedYesterday.length})`);
        if (completedYesterday.length > 0) {
          for (const t of completedYesterday) {
            sections.push(`- ${t.title}`);
          }
        } else {
          sections.push("Nothing completed yesterday.");
        }
        sections.push("");

        // Open tasks without due date
        const noDueDate = (
          db
            .prepare(
              `SELECT COUNT(*) as count FROM tasks
               WHERE status NOT IN ('done') AND due_date IS NULL`,
            )
            .get() as { count: number }
        ).count;

        sections.push(`## Tasks Without Due Date: ${noDueDate}`);
        sections.push("");

        // Active recurring reminders
        const recurringActive = (
          db
            .prepare(
              `SELECT COUNT(*) as count FROM reminders
               WHERE repeat != 'none' AND status IN ('active','snoozed')`,
            )
            .get() as { count: number }
        ).count;

        sections.push(`## Active Recurring Reminders: ${recurringActive}`);
        sections.push("");

        // Low stock alerts
        const lowStock = db
          .prepare(
            `SELECT * FROM products WHERE current_stock < min_stock AND min_stock > 0 ORDER BY name`,
          )
          .all() as ProductRow[];

        sections.push(`## Low Stock Alerts (${lowStock.length})`);
        if (lowStock.length > 0) {
          for (const p of lowStock) {
            sections.push(
              `- ${p.name}: ${p.current_stock}/${p.min_stock} ${p.unit}`,
            );
          }
        } else {
          sections.push("All products above minimum stock.");
        }
        sections.push("");

        // Active shopping lists
        const activeLists = db
          .prepare(`SELECT * FROM shopping_lists WHERE status = 'active' ORDER BY updated_at DESC`)
          .all() as ShoppingListRow[];

        sections.push(`## Active Shopping Lists (${activeLists.length})`);
        if (activeLists.length > 0) {
          for (const list of activeLists) {
            const { total, checked } = db
              .prepare(
                `SELECT COUNT(*) as total, SUM(CASE WHEN checked = 1 THEN 1 ELSE 0 END) as checked
                 FROM shopping_list_items WHERE list_id = ?`,
              )
              .get(list.id) as { total: number; checked: number };
            sections.push(`- ${list.name}: ${checked ?? 0}/${total} items checked`);
          }
        } else {
          sections.push("No active shopping lists.");
        }

        // Issues summary
        try {
          const issueStats = db
            .prepare(
              `SELECT
                 SUM(CASE WHEN state = 'open' THEN 1 ELSE 0 END) AS open,
                 SUM(CASE WHEN state IN ('closed','merged') AND closed_at >= ? THEN 1 ELSE 0 END) AS closedToday
               FROM issues`,
            )
            .get(today) as { open: number; closedToday: number };
          const staleCount = (
            db
              .prepare(
                `SELECT COUNT(*) AS c FROM issues
                 WHERE state = 'open' AND julianday(?) - julianday(updated_at) >= 14`,
              )
              .get(today) as { c: number }
          ).c;
          const timeStats = db
            .prepare(
              `SELECT COALESCE(SUM(time_estimate), 0) AS est, COALESCE(SUM(time_spent), 0) AS spt
               FROM issues WHERE state = 'open'`,
            )
            .get() as { est: number; spt: number };
          const pct = timeStats.est > 0 ? Math.round((timeStats.spt / timeStats.est) * 100) : 0;

          sections.push("");
          sections.push(`## Issues`);
          sections.push(`- Open: ${issueStats.open ?? 0}`);
          sections.push(`- Closed today: ${issueStats.closedToday ?? 0}`);
          sections.push(`- Stale (14d+): ${staleCount}`);
          if (timeStats.est > 0) {
            sections.push(`- Time: ${Math.round(timeStats.spt / 3600)}h / ${Math.round(timeStats.est / 3600)}h (${pct}%)`);
          }
        } catch {
          // issues table may not exist
        }

        return textResult(sections.join("\n"));
      },
    }),

    defineToolNoInput({
      name: "kernel_dashboard_evening",
      description:
        "Evening review: what was completed today, what's pending, and tasks for tomorrow.",
      handler: async () => {
        const today = new Date().toISOString().split("T")[0];
        const tomorrow = new Date(Date.now() + 86400000)
          .toISOString()
          .split("T")[0];
        const sections: string[] = ["# Evening Review", `Date: ${today}`, ""];

        // Completed today
        const completed = db
          .prepare(
            `SELECT * FROM tasks WHERE status = 'done'
             AND updated_at >= ? AND updated_at < ?`,
          )
          .all(`${today}T00:00:00`, `${tomorrow}T00:00:00`) as TaskRow[];

        sections.push(`## Completed Today (${completed.length})`);
        if (completed.length > 0) {
          for (const t of completed) {
            sections.push(`- ${t.title}`);
          }
        } else {
          sections.push("Nothing completed today.");
        }
        sections.push("");

        // Tasks created today
        const createdToday = (
          db
            .prepare(
              `SELECT COUNT(*) as count FROM tasks
               WHERE created_at >= ? AND created_at < ?`,
            )
            .get(`${today}T00:00:00`, `${tomorrow}T00:00:00`) as { count: number }
        ).count;

        const balance = completed.length - createdToday;
        const balanceSymbol = balance > 0 ? "+" : "";
        sections.push(`## Day Balance`);
        sections.push(`- Created today: ${createdToday}`);
        sections.push(`- Completed today: ${completed.length}`);
        sections.push(`- Net: ${balanceSymbol}${balance}`);
        sections.push("");

        // Still in progress
        const inProgress = db
          .prepare(`SELECT * FROM tasks WHERE status = 'in_progress'`)
          .all() as TaskRow[];

        sections.push(`## Still In Progress (${inProgress.length})`);
        for (const t of inProgress) {
          sections.push(`- ${t.title}`);
        }
        sections.push("");

        // Tomorrow's tasks
        const tomorrowTasks = db
          .prepare(
            `SELECT * FROM tasks WHERE status NOT IN ('done') AND due_date = ?`,
          )
          .all(tomorrow) as TaskRow[];

        sections.push(`## Due Tomorrow (${tomorrowTasks.length})`);
        for (const t of tomorrowTasks) {
          sections.push(`- [${t.priority.toUpperCase()}] ${t.title}`);
        }

        // Reminders fired today
        const firedToday = db
          .prepare(
            `SELECT * FROM reminders
             WHERE last_fired_at >= ? AND last_fired_at < ?
             ORDER BY last_fired_at ASC`,
          )
          .all(`${today}T00:00:00`, `${tomorrow}T00:00:00`) as ReminderRow[];

        sections.push("");
        sections.push(`## Reminders Fired Today (${firedToday.length})`);
        if (firedToday.length > 0) {
          for (const r of firedToday) {
            sections.push(`- ${r.title} (at ${r.last_fired_at?.split("T")[1]?.slice(0, 5) ?? "?"})`);
          }
        } else {
          sections.push("No reminders fired today.");
        }

        // Tomorrow's reminders
        const tomorrowEnd = new Date(Date.now() + 2 * 86400000).toISOString().split("T")[0];
        const tomorrowReminders = db
          .prepare(
            `SELECT * FROM reminders
             WHERE status IN ('active','snoozed')
             AND trigger_at >= ? AND trigger_at < ?
             ORDER BY trigger_at ASC`,
          )
          .all(`${tomorrow}T00:00:00`, `${tomorrowEnd}T00:00:00`) as ReminderRow[];

        sections.push("");
        sections.push(`## Tomorrow's Reminders (${tomorrowReminders.length})`);
        if (tomorrowReminders.length > 0) {
          for (const r of tomorrowReminders) {
            sections.push(
              `- ${r.trigger_at.split("T")[1]?.slice(0, 5) ?? r.trigger_at} — ${r.title}`,
            );
          }
        } else {
          sections.push("No reminders scheduled for tomorrow.");
        }

        // Today's interactions
        const todayInteractions = db
          .prepare(
            `SELECT i.*, c.name as contact_name FROM interactions i
             JOIN contacts c ON c.id = i.contact_id
             WHERE i.date = ?`,
          )
          .all(today) as Array<{ contact_name: string; type: string; summary: string }>;

        sections.push("");
        sections.push(`## Interactions Today (${todayInteractions.length})`);
        for (const i of todayInteractions) {
          sections.push(`- ${i.contact_name} (${i.type}): ${i.summary}`);
        }

        // Purchases today
        sections.push("");
        const todayPurchases = db
          .prepare(
            `SELECT pu.*, pr.name as product_name, s.name as store_name
             FROM purchases pu
             LEFT JOIN products pr ON pr.id = pu.product_id
             LEFT JOIN stores s ON s.id = pu.store_id
             WHERE pu.purchased_at = ?
             ORDER BY pu.created_at DESC`,
          )
          .all(today) as Array<{
            product_name: string; store_name: string | null;
            quantity: number; total_price: number; currency: string;
          }>;

        sections.push(`## Purchases Today (${todayPurchases.length})`);
        if (todayPurchases.length > 0) {
          let totalSpent = 0;
          for (const p of todayPurchases) {
            const store = p.store_name ? ` @ ${p.store_name}` : "";
            sections.push(
              `- ${p.product_name}: ${p.quantity}x = ${p.total_price.toFixed(2)} ${p.currency}${store}`,
            );
            totalSpent += p.total_price;
          }
          sections.push(`Total spent: ${totalSpent.toFixed(2)} EUR`);
        } else {
          sections.push("No purchases today.");
        }

        // Issues daily review
        try {
          const closedToday = db
            .prepare(
              `SELECT title, repo FROM issues
               WHERE state IN ('closed','merged') AND closed_at >= ? AND closed_at < ?
               ORDER BY closed_at DESC LIMIT 10`,
            )
            .all(`${today}T00:00:00`, `${tomorrow}T00:00:00`) as Array<{ title: string; repo: string }>;
          const openedToday = (
            db
              .prepare(
                `SELECT COUNT(*) AS c FROM issues
                 WHERE created_at >= ? AND created_at < ?`,
              )
              .get(`${today}T00:00:00`, `${tomorrow}T00:00:00`) as { c: number }
          ).c;
          const netBalance = closedToday.length - openedToday;
          const sym = netBalance > 0 ? "+" : "";

          sections.push("");
          sections.push(`## Issues Today`);
          sections.push(`- Closed: ${closedToday.length}`);
          if (closedToday.length > 0) {
            for (const c of closedToday) {
              sections.push(`  - ${c.title} (${c.repo.split("/").pop()})`);
            }
          }
          sections.push(`- Opened: ${openedToday}`);
          sections.push(`- Net: ${sym}${netBalance}`);
        } catch {
          // issues table may not exist
        }

        return textResult(sections.join("\n"));
      },
    }),

    defineToolNoInput({
      name: "kernel_dashboard_weekly",
      description:
        "Weekly planning summary: tasks completed this week, open items, upcoming deadlines, contact activity.",
      handler: async () => {
        const today = new Date();
        const weekAgo = new Date(today.getTime() - 7 * 86400000)
          .toISOString()
          .split("T")[0];
        const weekAhead = new Date(today.getTime() + 7 * 86400000)
          .toISOString()
          .split("T")[0];
        const todayStr = today.toISOString().split("T")[0];

        const sections: string[] = [
          "# Weekly Summary",
          `Week of: ${weekAgo} → ${todayStr}`,
          "",
        ];

        // Completed this week
        const completedCount = (
          db
            .prepare(
              `SELECT COUNT(*) as count FROM tasks
               WHERE status = 'done' AND updated_at >= ?`,
            )
            .get(`${weekAgo}T00:00:00`) as { count: number }
        ).count;

        // Open tasks
        const openCount = (
          db
            .prepare(
              `SELECT COUNT(*) as count FROM tasks WHERE status NOT IN ('done')`,
            )
            .get() as { count: number }
        ).count;

        // Blocked
        const blockedCount = (
          db
            .prepare(
              `SELECT COUNT(*) as count FROM tasks WHERE status = 'blocked'`,
            )
            .get() as { count: number }
        ).count;

        // Created this week
        const createdThisWeek = (
          db
            .prepare(
              `SELECT COUNT(*) as count FROM tasks WHERE created_at >= ?`,
            )
            .get(`${weekAgo}T00:00:00`) as { count: number }
        ).count;

        const velocity = (completedCount / 7).toFixed(1);

        sections.push("## This Week");
        sections.push(`- Completed: ${completedCount}`);
        sections.push(`- Created: ${createdThisWeek}`);
        sections.push(`- Open: ${openCount}`);
        sections.push(`- Blocked: ${blockedCount}`);
        sections.push(`- Velocity: ${velocity} tasks/day`);
        sections.push("");

        // Top GTD contexts
        const topContexts = db
          .prepare(
            `SELECT CASE WHEN context = '' THEN '(none)' ELSE context END as ctx,
                    COUNT(*) as count
             FROM tasks WHERE status NOT IN ('done')
             GROUP BY ctx ORDER BY count DESC LIMIT 3`,
          )
          .all() as Array<{ ctx: string; count: number }>;

        if (topContexts.length > 0) {
          sections.push("## Top GTD Contexts");
          for (const c of topContexts) {
            sections.push(`- ${c.ctx}: ${c.count} open tasks`);
          }
          sections.push("");
        }

        // Upcoming deadlines
        const upcoming = db
          .prepare(
            `SELECT * FROM tasks WHERE status NOT IN ('done')
             AND due_date IS NOT NULL AND due_date BETWEEN ? AND ?
             ORDER BY due_date`,
          )
          .all(todayStr, weekAhead) as TaskRow[];

        sections.push(`## Upcoming Deadlines (next 7 days: ${upcoming.length})`);
        for (const t of upcoming) {
          sections.push(
            `- ${t.due_date}: [${t.priority.toUpperCase()}] ${t.title}`,
          );
        }
        sections.push("");

        // Interaction count this week
        const interactionCount = (
          db
            .prepare(
              `SELECT COUNT(*) as count FROM interactions WHERE date >= ?`,
            )
            .get(weekAgo) as { count: number }
        ).count;

        const contactCount = (
          db.prepare(`SELECT COUNT(*) as count FROM contacts`).get() as {
            count: number;
          }
        ).count;

        sections.push("## CRM");
        sections.push(`- Total contacts: ${contactCount}`);
        sections.push(`- Interactions this week: ${interactionCount}`);
        sections.push("");

        // Reminders summary
        const activeReminders = (
          db
            .prepare(
              `SELECT COUNT(*) as count FROM reminders WHERE status = 'active'`,
            )
            .get() as { count: number }
        ).count;

        const firedThisWeek = (
          db
            .prepare(
              `SELECT COUNT(*) as count FROM reminders
               WHERE last_fired_at >= ?`,
            )
            .get(`${weekAgo}T00:00:00`) as { count: number }
        ).count;

        sections.push("## Reminders");
        sections.push(`- Active: ${activeReminders}`);
        sections.push(`- Fired this week: ${firedThisWeek}`);
        sections.push("");

        // Shopping stats
        const weeklyPurchases = (
          db
            .prepare(`SELECT COUNT(*) as count FROM purchases WHERE purchased_at >= ?`)
            .get(weekAgo) as { count: number }
        ).count;

        const weeklySpending = db
          .prepare(
            `SELECT currency, SUM(total_price) as total
             FROM purchases WHERE purchased_at >= ?
             GROUP BY currency`,
          )
          .all(weekAgo) as Array<{ currency: string; total: number }>;

        const lowStockCount = (
          db
            .prepare(
              `SELECT COUNT(*) as count FROM products WHERE current_stock < min_stock AND min_stock > 0`,
            )
            .get() as { count: number }
        ).count;

        sections.push("## Shopping");
        sections.push(`- Purchases this week: ${weeklyPurchases}`);
        if (weeklySpending.length > 0) {
          for (const s of weeklySpending) {
            sections.push(`- Spent: ${s.total.toFixed(2)} ${s.currency}`);
          }
        } else {
          sections.push("- Spent: 0");
        }
        sections.push(`- Low stock items: ${lowStockCount}`);

        // Issues weekly summary
        try {
          const openedThisWeek = (
            db.prepare(`SELECT COUNT(*) AS c FROM issues WHERE created_at >= ?`).get(`${weekAgo}T00:00:00`) as { c: number }
          ).c;
          const closedThisWeek = (
            db.prepare(`SELECT COUNT(*) AS c FROM issues WHERE state IN ('closed','merged') AND closed_at >= ?`).get(weekAgo) as { c: number }
          ).c;
          const totalOpen = (
            db.prepare(`SELECT COUNT(*) AS c FROM issues WHERE state = 'open'`).get() as { c: number }
          ).c;
          const prsOpen = (
            db.prepare(`SELECT COUNT(*) AS c FROM issues WHERE state = 'open' AND is_pull_request = 1`).get() as { c: number }
          ).c;
          const prsMerged = (
            db.prepare(`SELECT COUNT(*) AS c FROM issues WHERE state = 'merged' AND closed_at >= ?`).get(weekAgo) as { c: number }
          ).c;
          const timeLogged = (
            db.prepare(`SELECT COALESCE(SUM(time_spent), 0) AS spt FROM issues WHERE updated_at >= ?`).get(`${weekAgo}T00:00:00`) as { spt: number }
          ).spt;
          const netBalance = closedThisWeek - openedThisWeek;
          const sym = netBalance > 0 ? "+" : "";
          const issueVelocity = (closedThisWeek / 7).toFixed(1);

          sections.push("");
          sections.push("## Issues");
          sections.push(`- Opened this week: ${openedThisWeek}`);
          sections.push(`- Closed this week: ${closedThisWeek}`);
          sections.push(`- Net: ${sym}${netBalance}`);
          sections.push(`- Total open: ${totalOpen}`);
          sections.push(`- PRs open/merged: ${prsOpen}/${prsMerged}`);
          sections.push(`- Velocity: ${issueVelocity} issues/day`);
          if (timeLogged > 0) {
            sections.push(`- Time logged: ${Math.round(timeLogged / 3600)}h`);
          }
        } catch {
          // issues table may not exist
        }

        return textResult(sections.join("\n"));
      },
    }),
  ];
}
