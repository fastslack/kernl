import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { tableExists, today, daysFromNow } from "../../../../../src/core/db/query-helpers.js";

// ── Types ────────────────────────────────────────────

export interface DashboardHealth {
  kpis: { activeMedications: number; upcomingAppointments: number; metricsLast30d: number };
  latestMetrics: Record<string, { value: string; unit: string; date: string }>;
  upcomingAppointments: Array<{ id: string; title: string; provider: string; date: string; status: string }>;
  activeMedications: Array<{ id: string; name: string; dosage: string; frequency: string }>;
  recentMetrics: Array<{ id: string; type: string; value: string; unit: string; date: string }>;
}

// ── Query ────────────────────────────────────────────

export function queryHealth(db: SqliteDb): DashboardHealth | null {
  if (!tableExists(db, "health_metrics")) return null;

  const todayStr = today();
  const d30ago = daysFromNow(-30);

  const activeMeds = (
    db.prepare(`SELECT COUNT(*) as c FROM health_medications WHERE active = 1`).get() as { c: number }
  ).c;

  const upcomingApts = (
    db.prepare(
      `SELECT COUNT(*) as c FROM health_appointments WHERE status = 'scheduled' AND date >= ?`,
    ).get(todayStr) as { c: number }
  ).c;

  const metricsCount = (
    db.prepare(`SELECT COUNT(*) as c FROM health_metrics WHERE date >= ?`).get(d30ago) as { c: number }
  ).c;

  // Latest metric per type
  const latestRows = db
    .prepare(
      `SELECT type, value, unit, date FROM health_metrics
       WHERE id IN (SELECT id FROM health_metrics h2
         WHERE h2.type = health_metrics.type ORDER BY date DESC, created_at DESC LIMIT 1)
       GROUP BY type`,
    )
    .all() as Array<{ type: string; value: string; unit: string; date: string }>;

  const latestMetrics: Record<string, { value: string; unit: string; date: string }> = {};
  for (const m of latestRows) {
    latestMetrics[m.type] = { value: m.value, unit: m.unit, date: m.date };
  }

  const upcomingAppointments = db
    .prepare(
      `SELECT id, title, provider, date, status FROM health_appointments
       WHERE status = 'scheduled' AND date >= ?
       ORDER BY date LIMIT 10`,
    )
    .all(todayStr) as DashboardHealth["upcomingAppointments"];

  const activeMedications = db
    .prepare(
      `SELECT id, name, dosage, frequency FROM health_medications
       WHERE active = 1 ORDER BY name`,
    )
    .all() as DashboardHealth["activeMedications"];

  const recentMetrics = db
    .prepare(
      `SELECT id, type, value, unit, date FROM health_metrics
       ORDER BY date DESC, created_at DESC LIMIT 15`,
    )
    .all() as DashboardHealth["recentMetrics"];

  return {
    kpis: { activeMedications: activeMeds, upcomingAppointments: upcomingApts, metricsLast30d: metricsCount },
    latestMetrics,
    upcomingAppointments,
    activeMedications,
    recentMetrics,
  };
}
