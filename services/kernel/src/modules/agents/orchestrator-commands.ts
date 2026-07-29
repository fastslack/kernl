import type { SqliteDb } from "../../core/db/sqlite.js";
import type { Neo4jClient } from "../../core/db/neo4j.js";
import type { GraphDriver } from "../../core/db-drivers/graph-driver.js";
import type { Notifier } from "../../core/notify/notifier.js";
import type { ToolDefinition } from "../../core/types.js";
import type { ChatService } from "../chat/service.js";
import type { InlineButton } from "../../core/extension-seams.js";
import type { KernelLanguage } from "../../core/config.js";
import { newId, isoNow } from "../../core/helpers.js";
import { formatDateForLang } from "../../core/i18n/prompts.js";

export interface OrchestratorResponse {
  text: string;
  parseMode?: "Markdown" | "HTML";
  inlineKeyboard?: InlineButton[][];
}

export interface CommandDeps {
  db: SqliteDb;
  neo4j: Neo4jClient;
  getGraph: () => GraphDriver | null;
  notifier: Notifier;
  tools: ToolDefinition[];
  chatService: ChatService | null;
  /** Kernel language for user-facing output (date formats, labels).
   *  Optional so legacy callers keep compiling — falls back to "es". */
  language?: KernelLanguage;
}

function depsLang(deps: CommandDeps): KernelLanguage {
  return deps.language ?? deps.chatService?.getLanguage() ?? "es";
}

export async function getStatus(deps: CommandDeps): Promise<OrchestratorResponse> {
  const taskCount = (deps.db.prepare(
    "SELECT COUNT(*) as c FROM tasks WHERE status NOT IN ('done', 'cancelled')"
  ).get() as { c: number }).c;

  const reminderCount = (deps.db.prepare(
    "SELECT COUNT(*) as c FROM reminders WHERE status = 'active'"
  ).get() as { c: number }).c;

  const contactCount = (deps.db.prepare(
    "SELECT COUNT(*) as c FROM contacts"
  ).get() as { c: number }).c;

  const overdueReminders = (deps.db.prepare(
    "SELECT COUNT(*) as c FROM reminders WHERE status = 'active' AND trigger_at < datetime('now')"
  ).get() as { c: number }).c;

  const dueTodayTasks = (deps.db.prepare(
    "SELECT COUNT(*) as c FROM tasks WHERE status NOT IN ('done', 'cancelled') AND date(due_date) = date('now')"
  ).get() as { c: number }).c;

  return {
    text: `📊 *Kernl Status*\n\n` +
      `• Tasks pending: ${taskCount}${dueTodayTasks > 0 ? ` (${dueTodayTasks} due today)` : ""}\n` +
      `• Active reminders: ${reminderCount}${overdueReminders > 0 ? ` (⚠️ ${overdueReminders} overdue)` : ""}\n` +
      `• Contacts: ${contactCount}\n` +
      `• Neo4j: ${deps.getGraph()?.capabilities.cypher ? "✅" : "❌"}\n` +
      `• Tools: ${deps.tools.length}\n` +
      `• Chat: ${deps.chatService ? "✅" : "❌"}\n` +
      `• Mattermost: ${deps.notifier.mattermostConfigured ? "✅" : "❌"}\n` +
      `• Telegram: ${deps.notifier.telegramConfigured ? "✅" : "❌"}`,
  };
}

export async function listTasks(deps: CommandDeps, filter?: string): Promise<OrchestratorResponse> {
  let sql = "SELECT * FROM tasks WHERE status NOT IN ('done', 'cancelled')";
  const params: string[] = [];

  if (filter) {
    const f = filter.toLowerCase();
    if (["todo", "in_progress", "blocked", "done"].includes(f)) {
      sql = "SELECT * FROM tasks WHERE status = ?";
      params.push(f);
    } else if (f === "overdue") {
      sql = "SELECT * FROM tasks WHERE status NOT IN ('done', 'cancelled') AND due_date < date('now')";
    } else if (f === "today") {
      sql = "SELECT * FROM tasks WHERE status NOT IN ('done', 'cancelled') AND date(due_date) = date('now')";
    }
  }

  sql += " ORDER BY CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, due_date ASC LIMIT 15";

  const tasks = deps.db.prepare(sql).all(...params) as Array<{
    id: string;
    title: string;
    status: string;
    priority: string;
    due_date: string | null;
    context: string;
  }>;

  if (tasks.length === 0) {
    return { text: "No tasks found." };
  }

  const lines = tasks.map((t) => {
    const priority = t.priority === "urgent" ? "🔴" : t.priority === "high" ? "🟠" : t.priority === "medium" ? "🟡" : "⚪";
    const status = t.status === "in_progress" ? "▶️" : t.status === "blocked" ? "🚫" : t.status === "done" ? "✅" : "⬜";
    const due = t.due_date ? ` (${t.due_date})` : "";
    const ctx = t.context ? ` [${t.context}]` : "";
    return `${status}${priority} ${t.title}${due}${ctx}`;
  });

  return {
    text: `📋 *Tasks* (${tasks.length}):\n\n${lines.join("\n")}`,
  };
}

export async function quickAddTask(deps: CommandDeps, title: string): Promise<OrchestratorResponse> {
  const now = isoNow();
  const id = newId();

  deps.db.prepare(
    `INSERT INTO tasks (id, title, description, status, priority, context, due_date, created_at, updated_at)
     VALUES (?, ?, '', 'todo', 'medium', '', NULL, ?, ?)`
  ).run(id, title, now, now);

  return {
    text: `✅ Task created: *${title}*\n\nID: \`${id}\``,
  };
}

export async function quickAddReminder(deps: CommandDeps, text: string): Promise<OrchestratorResponse> {
  // Parse natural language time expressions
  const parsed = parseReminderText(text);

  if (!parsed.triggerAt) {
    return {
      text: `Could not parse time from: "${text}"\n\n` +
        `Examples:\n` +
        `• /remind Call mom in 2 hours\n` +
        `• /remind Buy milk tomorrow at 9am\n` +
        `• /remind Meeting in 30 minutes`,
    };
  }

  const now = isoNow();
  const id = newId();

  deps.db.prepare(
    `INSERT INTO reminders (id, title, body, trigger_at, status, repeat, task_id, snoozed_until, last_fired_at, notify_mattermost, notify_telegram, created_at, updated_at)
     VALUES (?, ?, '', ?, 'active', 'none', NULL, NULL, NULL, 1, 1, ?, ?)`
  ).run(id, parsed.title, parsed.triggerAt, now, now);

  const lang = depsLang(deps);
  const formatted = formatDateForLang(parsed.triggerAt, lang, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const out = lang === "es"
    ? `🔔 Recordatorio creado: *${parsed.title}*\n\nDispara: ${formatted}`
    : `🔔 Reminder set: *${parsed.title}*\n\nTrigger: ${formatted}`;

  return { text: out };
}

export function parseReminderText(text: string): { title: string; triggerAt: string | null } {
  const now = new Date();
  let triggerAt: Date | null = null;
  let title = text;

  // "in X minutes/hours/days"
  const inMatch = text.match(/\s+in\s+(\d+)\s*(min(?:ute)?s?|hours?|days?)\s*$/i);
  if (inMatch) {
    const amount = parseInt(inMatch[1], 10);
    const unit = inMatch[2].toLowerCase();
    triggerAt = new Date(now);

    if (unit.startsWith("min")) {
      triggerAt.setMinutes(triggerAt.getMinutes() + amount);
    } else if (unit.startsWith("hour")) {
      triggerAt.setHours(triggerAt.getHours() + amount);
    } else if (unit.startsWith("day")) {
      triggerAt.setDate(triggerAt.getDate() + amount);
    }

    title = text.replace(inMatch[0], "").trim();
  }

  // "tomorrow at Xam/pm"
  const tomorrowMatch = text.match(/\s+tomorrow\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*$/i);
  if (tomorrowMatch) {
    triggerAt = new Date(now);
    triggerAt.setDate(triggerAt.getDate() + 1);
    let hour = parseInt(tomorrowMatch[1], 10);
    const minute = tomorrowMatch[2] ? parseInt(tomorrowMatch[2], 10) : 0;
    const ampm = tomorrowMatch[3]?.toLowerCase();

    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;

    triggerAt.setHours(hour, minute, 0, 0);
    title = text.replace(tomorrowMatch[0], "").trim();
  }

  // "at Xam/pm" (today or tomorrow if past)
  const atMatch = text.match(/\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*$/i);
  if (atMatch && !triggerAt) {
    triggerAt = new Date(now);
    let hour = parseInt(atMatch[1], 10);
    const minute = atMatch[2] ? parseInt(atMatch[2], 10) : 0;
    const ampm = atMatch[3]?.toLowerCase();

    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;

    triggerAt.setHours(hour, minute, 0, 0);

    // If time is in the past, set for tomorrow
    if (triggerAt <= now) {
      triggerAt.setDate(triggerAt.getDate() + 1);
    }

    title = text.replace(atMatch[0], "").trim();
  }

  return {
    title: title || text,
    triggerAt: triggerAt?.toISOString() ?? null,
  };
}

export async function searchContacts(deps: CommandDeps, query?: string): Promise<OrchestratorResponse> {
  if (!query) {
    const count = (deps.db.prepare("SELECT COUNT(*) as c FROM contacts").get() as { c: number }).c;
    return {
      text: `You have ${count} contacts.\n\nUse /contacts <name> to search.`,
    };
  }

  const contacts = deps.db.prepare(
    `SELECT * FROM contacts
     WHERE name LIKE ? OR email LIKE ? OR company LIKE ?
     ORDER BY name LIMIT 10`
  ).all(`%${query}%`, `%${query}%`, `%${query}%`) as Array<{
    id: string;
    name: string;
    email: string;
    phone: string;
    company: string;
    relationship: string;
  }>;

  if (contacts.length === 0) {
    return { text: `No contacts found matching "${query}"` };
  }

  const lines = contacts.map((c) => {
    const details: string[] = [];
    if (c.email) details.push(c.email);
    if (c.phone) details.push(c.phone);
    if (c.company) details.push(c.company);
    return `• *${c.name}*${details.length ? `\n  ${details.join(" | ")}` : ""}`;
  });

  return {
    text: `👥 *Contacts* (${contacts.length}):\n\n${lines.join("\n")}`,
  };
}

export async function getShoppingLists(deps: CommandDeps): Promise<OrchestratorResponse> {
  const lists = deps.db.prepare(
    `SELECT sl.*, COUNT(sli.id) as item_count, SUM(CASE WHEN sli.checked THEN 1 ELSE 0 END) as checked_count
     FROM shopping_lists sl
     LEFT JOIN shopping_list_items sli ON sl.id = sli.list_id
     WHERE sl.status = 'active'
     GROUP BY sl.id
     ORDER BY sl.created_at DESC`
  ).all() as Array<{
    id: string;
    name: string;
    item_count: number;
    checked_count: number;
  }>;

  if (lists.length === 0) {
    return { text: "No active shopping lists." };
  }

  const lines = lists.map((l) => {
    const progress = l.item_count > 0 ? ` (${l.checked_count}/${l.item_count})` : "";
    return `• *${l.name}*${progress}`;
  });

  return {
    text: `🛒 *Active Shopping Lists*:\n\n${lines.join("\n")}`,
  };
}

export async function getHomeStatus(deps: CommandDeps): Promise<OrchestratorResponse> {
  // Overdue maintenance
  const overdueMaintenance = deps.db.prepare(
    `SELECT COUNT(*) as c FROM home_maintenance_items
     WHERE next_due IS NOT NULL AND next_due < date('now')`
  ).get() as { c: number };

  // Open incidents
  const openIncidents = deps.db.prepare(
    `SELECT COUNT(*) as c FROM home_incidents
     WHERE status IN ('open', 'in_progress') AND deleted_at IS NULL`
  ).get() as { c: number };

  // Active projects
  const activeProjects = deps.db.prepare(
    `SELECT COUNT(*) as c FROM home_projects
     WHERE status IN ('planning', 'in_progress') AND deleted_at IS NULL`
  ).get() as { c: number };

  return {
    text: `🏠 *Home Status*\n\n` +
      `• Overdue maintenance: ${overdueMaintenance.c}\n` +
      `• Open incidents: ${openIncidents.c}\n` +
      `• Active projects: ${activeProjects.c}`,
  };
}

export async function getMorningBriefing(deps: CommandDeps): Promise<OrchestratorResponse> {
  const todayTasks = deps.db.prepare(
    `SELECT COUNT(*) as c FROM tasks
     WHERE status NOT IN ('done', 'cancelled') AND date(due_date) = date('now')`
  ).get() as { c: number };

  const upcomingReminders = deps.db.prepare(
    `SELECT title, trigger_at FROM reminders
     WHERE status = 'active' AND trigger_at > datetime('now') AND trigger_at < datetime('now', '+24 hours')
     ORDER BY trigger_at LIMIT 5`
  ).all() as Array<{ title: string; trigger_at: string }>;

  const overdueCount = deps.db.prepare(
    `SELECT COUNT(*) as c FROM tasks
     WHERE status NOT IN ('done', 'cancelled') AND due_date < date('now')`
  ).get() as { c: number };

  const lines = ["☀️ *Good Morning!*\n"];

  if (todayTasks.c > 0) {
    lines.push(`📋 ${todayTasks.c} task(s) due today`);
  }

  if (overdueCount.c > 0) {
    lines.push(`⚠️ ${overdueCount.c} overdue task(s)`);
  }

  if (upcomingReminders.length > 0) {
    lines.push("\n🔔 *Upcoming Reminders:*");
    for (const r of upcomingReminders) {
      const time = new Date(r.trigger_at).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
      });
      lines.push(`• ${time} — ${r.title}`);
    }
  }

  if (lines.length === 1) {
    lines.push("No tasks or reminders for today. Enjoy your day! 🎉");
  }

  return { text: lines.join("\n") };
}

export async function getEveningSummary(deps: CommandDeps): Promise<OrchestratorResponse> {
  const completedToday = deps.db.prepare(
    `SELECT COUNT(*) as c FROM tasks
     WHERE status = 'done' AND date(updated_at) = date('now')`
  ).get() as { c: number };

  const remainingTasks = deps.db.prepare(
    `SELECT COUNT(*) as c FROM tasks
     WHERE status NOT IN ('done', 'cancelled')`
  ).get() as { c: number };

  const tomorrowTasks = deps.db.prepare(
    `SELECT COUNT(*) as c FROM tasks
     WHERE status NOT IN ('done', 'cancelled') AND date(due_date) = date('now', '+1 day')`
  ).get() as { c: number };

  const firedReminders = deps.db.prepare(
    `SELECT COUNT(*) as c FROM reminders
     WHERE status = 'fired' AND date(last_fired_at) = date('now')`
  ).get() as { c: number };

  return {
    text: `🌙 *Evening Summary*\n\n` +
      `✅ Tasks completed today: ${completedToday.c}\n` +
      `📋 Tasks remaining: ${remainingTasks.c}\n` +
      `📅 Tasks due tomorrow: ${tomorrowTasks.c}\n` +
      `🔔 Reminders fired today: ${firedReminders.c}`,
  };
}

export async function getExternalAgents(deps: CommandDeps): Promise<OrchestratorResponse> {
  // Check if external_agents table exists
  try {
    const agents = deps.db.prepare(
      `SELECT id, name, platform, status, last_seen_at FROM external_agents ORDER BY name`
    ).all() as Array<{
      id: string;
      name: string;
      platform: string;
      status: string;
      last_seen_at: string | null;
    }>;

    if (agents.length === 0) {
      return { text: "No external agents registered.\n\nUse natural language to register an agent, e.g.:\n_\"Register external agent LattePanda as telegram agent with ID 12345\"_" };
    }

    const unackAlerts = deps.db.prepare(
      `SELECT COUNT(*) as c FROM agent_alerts WHERE acknowledged = 0`
    ).get() as { c: number };

    const lang = depsLang(deps);
    const neverLabel = lang === "es" ? "nunca" : "never";
    const lastSeenLabel = lang === "es" ? "Visto" : "Last seen";
    const lines = agents.map((a) => {
      const statusIcon = a.status === "online" ? "🟢" : a.status === "offline" ? "🔴" : a.status === "error" ? "⚠️" : "⚪";
      const lastSeen = a.last_seen_at
        ? formatDateForLang(a.last_seen_at, lang, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
        : neverLabel;
      return `${statusIcon} *${a.name}* (${a.platform})\n  ${lastSeenLabel}: ${lastSeen}`;
    });

    let text = `🤖 *External Agents* (${agents.length}):\n\n${lines.join("\n\n")}`;

    if (unackAlerts.c > 0) {
      text += `\n\n⚠️ ${unackAlerts.c} unacknowledged alert(s)`;
    }

    return { text };
  } catch {
    return { text: "External agents module not available." };
  }
}

export async function getUnacknowledgedAlerts(deps: CommandDeps): Promise<OrchestratorResponse> {
  try {
    const alerts = deps.db.prepare(
      `SELECT aa.*, ea.name as agent_name FROM agent_alerts aa
       JOIN external_agents ea ON aa.agent_id = ea.id
       WHERE aa.acknowledged = 0
       ORDER BY aa.created_at DESC
       LIMIT 10`
    ).all() as Array<{
      id: string;
      agent_name: string;
      severity: string;
      title: string;
      message: string;
      created_at: string;
    }>;

    if (alerts.length === 0) {
      return { text: "No unacknowledged alerts." };
    }

    const lines: string[] = ["⚠️ *Unacknowledged Alerts*\n"];
    const buttons: InlineButton[][] = [];

    const lang = depsLang(deps);
    for (const a of alerts) {
      const icon = a.severity === "critical" ? "🚨" : a.severity === "warning" ? "⚠️" : "ℹ️";
      const time = formatDateForLang(a.created_at, lang, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      lines.push(`${icon} *${a.agent_name}*: ${a.title}`);
      if (a.message) lines.push(`  ${a.message}`);
      lines.push(`  _${time}_\n`);

      // Add acknowledge button for each alert
      buttons.push([{ text: `✅ Ack: ${a.title.slice(0, 20)}`, callbackData: `ack_alert:${a.id}` }]);
    }

    return {
      text: lines.join("\n"),
      inlineKeyboard: buttons,
    };
  } catch {
    return { text: "External agents module not available." };
  }
}

export async function acknowledgeAlert(deps: CommandDeps, alertId: string): Promise<OrchestratorResponse> {
  try {
    const now = isoNow();
    const result = deps.db
      .prepare("UPDATE agent_alerts SET acknowledged = 1, acknowledged_at = ? WHERE id = ?")
      .run(now, alertId);

    if (result.changes > 0) {
      // Get remaining unack count
      const remaining = (deps.db.prepare(
        "SELECT COUNT(*) as c FROM agent_alerts WHERE acknowledged = 0"
      ).get() as { c: number }).c;

      return {
        text: `✅ Alert acknowledged.\n\n${remaining > 0 ? `${remaining} alert(s) remaining.` : "All alerts acknowledged!"}`,
      };
    }
    return { text: "Alert not found or already acknowledged." };
  } catch {
    return { text: "Failed to acknowledge alert." };
  }
}

export async function searchTasksToComplete(deps: CommandDeps, query?: string): Promise<OrchestratorResponse> {
  if (!query) {
    // Show in-progress and recent todo tasks
    const tasks = deps.db.prepare(
      `SELECT * FROM tasks
       WHERE status IN ('todo', 'in_progress')
       ORDER BY
         CASE status WHEN 'in_progress' THEN 1 ELSE 2 END,
         CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
         updated_at DESC
       LIMIT 10`
    ).all() as Array<{ id: string; title: string; status: string; priority: string }>;

    if (tasks.length === 0) {
      return { text: "No active tasks to complete." };
    }

    const lines: string[] = ["📋 *Select a task to complete:*\n"];
    const buttons: InlineButton[][] = [];

    for (const t of tasks) {
      const priority = t.priority === "urgent" ? "🔴" : t.priority === "high" ? "🟠" : t.priority === "medium" ? "🟡" : "⚪";
      const status = t.status === "in_progress" ? "▶️" : "⬜";
      lines.push(`${status}${priority} ${t.title}`);

      buttons.push([{ text: `✅ ${t.title.slice(0, 25)}`, callbackData: `done_task:${t.id}` }]);
    }

    return {
      text: lines.join("\n"),
      inlineKeyboard: buttons,
    };
  }

  // Search for matching tasks
  const tasks = deps.db.prepare(
    `SELECT * FROM tasks
     WHERE status IN ('todo', 'in_progress') AND title LIKE ?
     ORDER BY updated_at DESC
     LIMIT 5`
  ).all(`%${query}%`) as Array<{ id: string; title: string; status: string; priority: string }>;

  if (tasks.length === 0) {
    return { text: `No active tasks matching "${query}"` };
  }

  if (tasks.length === 1) {
    // Direct confirmation for single match
    return completeTask(deps, tasks[0].id);
  }

  const lines: string[] = [`📋 *Tasks matching "${query}":*\n`];
  const buttons: InlineButton[][] = [];

  for (const t of tasks) {
    const priority = t.priority === "urgent" ? "🔴" : t.priority === "high" ? "🟠" : t.priority === "medium" ? "🟡" : "⚪";
    lines.push(`${priority} ${t.title}`);
    buttons.push([{ text: `✅ ${t.title.slice(0, 25)}`, callbackData: `done_task:${t.id}` }]);
  }

  return {
    text: lines.join("\n"),
    inlineKeyboard: buttons,
  };
}

export async function completeTask(deps: CommandDeps, taskId: string): Promise<OrchestratorResponse> {
  const task = deps.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as {
    id: string;
    title: string;
    status: string;
  } | undefined;

  if (!task) {
    return { text: "Task not found." };
  }

  if (task.status === "done") {
    return { text: `Task "${task.title}" is already completed.` };
  }

  return {
    text: `Complete this task?\n\n📋 *${task.title}*`,
    inlineKeyboard: [
      [
        { text: "✅ Yes, complete", callbackData: `confirm_done:${taskId}` },
        { text: "❌ Cancel", callbackData: "cancel_done:" },
      ],
    ],
  };
}

export async function confirmCompleteTask(deps: CommandDeps, taskId: string): Promise<OrchestratorResponse> {
  const now = isoNow();
  const result = deps.db
    .prepare("UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?")
    .run(now, taskId);

  if (result.changes > 0) {
    const task = deps.db.prepare("SELECT title FROM tasks WHERE id = ?").get(taskId) as { title: string };
    return { text: `✅ Task completed: *${task.title}*` };
  }
  return { text: "Failed to complete task." };
}

export async function snoozeReminderCallback(deps: CommandDeps, reminderId: string, duration?: string): Promise<OrchestratorResponse> {
  const minutes = parseInt(duration ?? "15", 10);
  const snoozeUntil = new Date(Date.now() + minutes * 60 * 1000).toISOString();
  const now = isoNow();

  const result = deps.db
    .prepare("UPDATE reminders SET status = 'snoozed', snoozed_until = ?, updated_at = ? WHERE id = ?")
    .run(snoozeUntil, now, reminderId);

  if (result.changes > 0) {
    const reminder = deps.db.prepare("SELECT title FROM reminders WHERE id = ?").get(reminderId) as { title: string };
    return { text: `⏰ Snoozed "${reminder.title}" for ${minutes} minutes.` };
  }
  return { text: "Reminder not found." };
}

export async function dismissReminderCallback(deps: CommandDeps, reminderId: string): Promise<OrchestratorResponse> {
  const now = isoNow();
  const result = deps.db
    .prepare("UPDATE reminders SET status = 'dismissed', updated_at = ? WHERE id = ?")
    .run(now, reminderId);

  if (result.changes > 0) {
    const reminder = deps.db.prepare("SELECT title FROM reminders WHERE id = ?").get(reminderId) as { title: string };
    return { text: `✅ Dismissed: "${reminder.title}"` };
  }
  return { text: "Reminder not found." };
}

export function formatForTelegram(text: string): string {
  // Basic cleanup for Telegram Markdown
  // - Escape special characters that aren't part of formatting
  // - Limit message length

  let formatted = text;

  // Truncate if too long (Telegram limit is 4096)
  if (formatted.length > 4000) {
    formatted = formatted.slice(0, 3997) + "...";
  }

  return formatted;
}
