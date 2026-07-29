/**
 * Deterministic digest builders — no LLM. They mirror the queries of the
 * existing `kernel_dashboard_evening` / `kernel_dashboard_morning` tools but
 * scope to the user's personal items (tasks / events / reminders), exclude
 * soft-deleted tasks, and anchor "today/tomorrow" to Europe/Amsterdam.
 */
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { amsterdamParts } from "./scheduler.js";

export interface DigestContent {
  title: string;
  markdown: string;
}

function addDays(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function timeOf(ts: string | null): string {
  return ts?.split("T")[1]?.slice(0, 5) ?? "";
}

function tasksDue(db: SqliteDb, dateKey: string): Array<{ title: string; priority: string }> {
  return db
    .prepare(
      `SELECT title, priority FROM tasks
       WHERE status NOT IN ('done') AND due_date = ? AND deleted_at IS NULL
       ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`,
    )
    .all(dateKey) as Array<{ title: string; priority: string }>;
}

function eventsOn(db: SqliteDb, dateKey: string): Array<{ title: string; start_at: string }> {
  return db
    .prepare(
      `SELECT title, start_at FROM events
       WHERE status NOT IN ('cancelled','completed') AND start_at >= ? AND start_at < ?
       ORDER BY start_at`,
    )
    .all(`${dateKey}T00:00:00`, `${addDays(dateKey, 1)}T00:00:00`) as Array<{ title: string; start_at: string }>;
}

function remindersOn(db: SqliteDb, dateKey: string): Array<{ title: string; trigger_at: string }> {
  return db
    .prepare(
      `SELECT title, trigger_at FROM reminders
       WHERE status IN ('active','snoozed') AND trigger_at >= ? AND trigger_at < ?
       ORDER BY trigger_at`,
    )
    .all(`${dateKey}T00:00:00`, `${addDays(dateKey, 1)}T00:00:00`) as Array<{ title: string; trigger_at: string }>;
}

/** Evening digest: a preview of tomorrow + what is still in progress. */
export function buildEveningDigest(db: SqliteDb, now: Date): DigestContent {
  const tomorrow = addDays(amsterdamParts(now).dateKey, 1);
  const lines: string[] = [`# 🌙 Tomorrow — ${tomorrow}`, ""];

  const tasks = tasksDue(db, tomorrow);
  lines.push(`## ✅ Tasks due tomorrow (${tasks.length})`);
  if (tasks.length) for (const t of tasks) lines.push(`- [${t.priority.toUpperCase()}] ${t.title}`);
  else lines.push("Nothing scheduled for tomorrow.");
  lines.push("");

  const events = eventsOn(db, tomorrow);
  lines.push(`## 📅 Events tomorrow (${events.length})`);
  if (events.length) for (const e of events) lines.push(`- ${timeOf(e.start_at)} ${e.title}`.trim());
  else lines.push("No events.");
  lines.push("");

  const reminders = remindersOn(db, tomorrow);
  lines.push(`## 🔔 Reminders tomorrow (${reminders.length})`);
  if (reminders.length) for (const r of reminders) lines.push(`- ${timeOf(r.trigger_at)} ${r.title}`.trim());
  else lines.push("No reminders.");
  lines.push("");

  const pending = db
    .prepare(`SELECT COUNT(*) AS c FROM tasks WHERE status = 'in_progress' AND deleted_at IS NULL`)
    .get() as { c: number };
  lines.push(`## ⏳ Still in progress: ${pending.c}`);

  return { title: `🌙 Tomorrow — ${tomorrow}`, markdown: lines.join("\n") };
}

/** Morning digest: today's agenda + overdue. */
export function buildMorningDigest(db: SqliteDb, now: Date): DigestContent {
  const today = amsterdamParts(now).dateKey;
  const lines: string[] = [`# ☀️ Today — ${today}`, ""];

  const tasks = tasksDue(db, today);
  lines.push(`## ✅ Tasks due today (${tasks.length})`);
  if (tasks.length) for (const t of tasks) lines.push(`- [${t.priority.toUpperCase()}] ${t.title}`);
  else lines.push("Nothing due today.");
  lines.push("");

  const overdue = db
    .prepare(
      `SELECT title, due_date, priority FROM tasks
       WHERE status NOT IN ('done') AND due_date IS NOT NULL AND due_date < ? AND deleted_at IS NULL
       ORDER BY due_date`,
    )
    .all(today) as Array<{ title: string; due_date: string; priority: string }>;
  lines.push(`## ⚠️ Overdue (${overdue.length})`);
  if (overdue.length) for (const t of overdue) lines.push(`- [${t.priority.toUpperCase()}] ${t.title} (was ${t.due_date})`);
  else lines.push("Nothing overdue.");
  lines.push("");

  const events = eventsOn(db, today);
  lines.push(`## 📅 Events today (${events.length})`);
  if (events.length) for (const e of events) lines.push(`- ${timeOf(e.start_at)} ${e.title}`.trim());
  else lines.push("No events.");
  lines.push("");

  const reminders = remindersOn(db, today);
  lines.push(`## 🔔 Reminders today (${reminders.length})`);
  if (reminders.length) for (const r of reminders) lines.push(`- ${timeOf(r.trigger_at)} ${r.title}`.trim());
  else lines.push("No reminders.");

  return { title: `☀️ Today — ${today}`, markdown: lines.join("\n") };
}
