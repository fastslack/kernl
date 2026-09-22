import { type SqliteDb, type GraphDriver, newId, isoNow } from "@kernl/extension-sdk";
import type { HealthMetric, HealthMedication, HealthAppointment, MetricType, MedicationFrequency, AppointmentStatus } from "./types.js";

const DEFAULT_UNITS: Record<string, string> = {
  weight: "kg", blood_pressure: "mmHg", heart_rate: "bpm",
  temperature: "°C", blood_sugar: "mg/dL", sleep_hours: "hours",
  steps: "steps", oxygen: "%",
};

export class HealthService {
  constructor(
    private db: SqliteDb,
    private getGraph: () => GraphDriver | null,
  ) {}

  // ── Metrics ────────────────────────────────────

  logMetric(input: {
    type: MetricType; value: string; unit?: string;
    date?: string; notes?: string;
  }): HealthMetric {
    const now = isoNow();
    const metric: HealthMetric = {
      id: newId(), type: input.type, value: input.value,
      unit: input.unit ?? DEFAULT_UNITS[input.type] ?? "",
      date: input.date ?? now.split("T")[0],
      notes: input.notes ?? "", created_at: now,
    };

    this.db.prepare(
      `INSERT INTO health_metrics (id, type, value, unit, date, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(metric.id, metric.type, metric.value, metric.unit, metric.date, metric.notes, metric.created_at);

    return metric;
  }

  listMetrics(filters?: {
    type?: MetricType; from_date?: string; to_date?: string; limit?: number;
  }): HealthMetric[] {
    let sql = "SELECT * FROM health_metrics WHERE 1=1";
    const params: unknown[] = [];
    if (filters?.type) { sql += " AND type = ?"; params.push(filters.type); }
    if (filters?.from_date) { sql += " AND date >= ?"; params.push(filters.from_date); }
    if (filters?.to_date) { sql += " AND date <= ?"; params.push(filters.to_date); }
    sql += " ORDER BY date DESC, created_at DESC";
    if (filters?.limit) { sql += " LIMIT ?"; params.push(filters.limit); }
    return this.db.prepare(sql).all(...params) as HealthMetric[];
  }

  // ── Medications ────────────────────────────────

  addMedication(input: {
    name: string; dosage?: string; frequency?: MedicationFrequency;
    start_date: string; end_date?: string; notes?: string;
  }): HealthMedication {
    const now = isoNow();
    const med: HealthMedication = {
      id: newId(), name: input.name, dosage: input.dosage ?? "",
      frequency: input.frequency ?? "daily",
      start_date: input.start_date, end_date: input.end_date ?? null,
      active: 1, notes: input.notes ?? "",
      created_at: now, updated_at: now,
    };

    this.db.prepare(
      `INSERT INTO health_medications (id, name, dosage, frequency, start_date, end_date, active, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(med.id, med.name, med.dosage, med.frequency, med.start_date, med.end_date, med.active, med.notes, med.created_at, med.updated_at);

    return med;
  }

  updateMedication(id: string, changes: Partial<Pick<HealthMedication, "name" | "dosage" | "frequency" | "start_date" | "end_date" | "active" | "notes">>): HealthMedication | undefined {
    const existing = this.db.prepare("SELECT * FROM health_medications WHERE id = ?").get(id) as HealthMedication | undefined;
    if (!existing) return undefined;

    const updated = { ...existing, ...changes, updated_at: isoNow() };
    this.db.prepare(
      `UPDATE health_medications SET name=?, dosage=?, frequency=?, start_date=?, end_date=?, active=?, notes=?, updated_at=?
       WHERE id=?`,
    ).run(updated.name, updated.dosage, updated.frequency, updated.start_date, updated.end_date, updated.active, updated.notes, updated.updated_at, id);

    return updated;
  }

  listMedications(activeOnly: boolean = true): HealthMedication[] {
    const sql = activeOnly
      ? "SELECT * FROM health_medications WHERE active = 1 ORDER BY name ASC"
      : "SELECT * FROM health_medications ORDER BY active DESC, name ASC";
    return this.db.prepare(sql).all() as HealthMedication[];
  }

  // ── Appointments ────────────────────────────────

  addAppointment(input: {
    title: string; provider?: string; location?: string;
    date: string; notes?: string;
  }): HealthAppointment {
    const now = isoNow();
    const apt: HealthAppointment = {
      id: newId(), title: input.title,
      provider: input.provider ?? "", location: input.location ?? "",
      date: input.date, status: "scheduled",
      notes: input.notes ?? "", created_at: now, updated_at: now,
    };

    this.db.prepare(
      `INSERT INTO health_appointments (id, title, provider, location, date, status, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(apt.id, apt.title, apt.provider, apt.location, apt.date, apt.status, apt.notes, apt.created_at, apt.updated_at);

    return apt;
  }

  updateAppointment(id: string, changes: Partial<Pick<HealthAppointment, "title" | "provider" | "location" | "date" | "status" | "notes">>): HealthAppointment | undefined {
    const existing = this.db.prepare("SELECT * FROM health_appointments WHERE id = ?").get(id) as HealthAppointment | undefined;
    if (!existing) return undefined;

    const updated = { ...existing, ...changes, updated_at: isoNow() };
    this.db.prepare(
      `UPDATE health_appointments SET title=?, provider=?, location=?, date=?, status=?, notes=?, updated_at=?
       WHERE id=?`,
    ).run(updated.title, updated.provider, updated.location, updated.date, updated.status, updated.notes, updated.updated_at, id);

    return updated;
  }

  listAppointments(filters?: { status?: AppointmentStatus; from_date?: string; to_date?: string }): HealthAppointment[] {
    let sql = "SELECT * FROM health_appointments WHERE 1=1";
    const params: unknown[] = [];
    if (filters?.status) { sql += " AND status = ?"; params.push(filters.status); }
    if (filters?.from_date) { sql += " AND date >= ?"; params.push(filters.from_date); }
    if (filters?.to_date) { sql += " AND date <= ?"; params.push(filters.to_date); }
    sql += " ORDER BY date ASC";
    return this.db.prepare(sql).all(...params) as HealthAppointment[];
  }

  // ── Summary ────────────────────────────────────

  summary(): {
    active_medications: number;
    upcoming_appointments: number;
    recent_metrics: { type: string; value: string; unit: string; date: string }[];
    latest_weight: HealthMetric | null;
  } {
    const activeMeds = this.listMedications(true);
    const today = isoNow().split("T")[0];
    const upcoming = this.db.prepare(
      "SELECT COUNT(*) as c FROM health_appointments WHERE status = 'scheduled' AND date >= ?",
    ).get(today) as { c: number };

    const recentMetrics = this.db.prepare(
      `SELECT type, value, unit, date FROM health_metrics
       GROUP BY type HAVING date = MAX(date) ORDER BY date DESC LIMIT 10`,
    ).all() as { type: string; value: string; unit: string; date: string }[];

    const latestWeight = this.db.prepare(
      "SELECT * FROM health_metrics WHERE type = 'weight' ORDER BY date DESC LIMIT 1",
    ).get() as HealthMetric | null;

    return {
      active_medications: activeMeds.length,
      upcoming_appointments: upcoming.c,
      recent_metrics: recentMetrics,
      latest_weight: latestWeight ?? null,
    };
  }

  /**
   * The dashboard's health card: the latest reading per metric type, how many
   * medications are active, the next five scheduled appointments and how many
   * readings were logged in the last seven days.
   */
  overview(): {
    latestMetrics: { type: string; value: string; unit: string; date: string }[];
    activeMeds: number;
    upcomingAppts: { id: string; title: string; date: string; provider: string }[];
    weekMetrics: number;
  } {
    const today = isoNow().split("T")[0];
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
    const latestMetrics = this.db.prepare(
      `SELECT type, value, unit, date FROM health_metrics
       WHERE id IN (SELECT id FROM health_metrics h2 WHERE h2.type = health_metrics.type ORDER BY date DESC LIMIT 1)
       GROUP BY type`,
    ).all() as { type: string; value: string; unit: string; date: string }[];
    const activeMeds = (this.db.prepare("SELECT COUNT(*) as c FROM health_medications WHERE active = 1").get() as { c: number }).c;
    const upcomingAppts = this.db.prepare(
      "SELECT id, title, date, provider FROM health_appointments WHERE date >= ? AND status = 'scheduled' ORDER BY date ASC LIMIT 5",
    ).all(today) as { id: string; title: string; date: string; provider: string }[];
    const weekMetrics = (this.db.prepare("SELECT COUNT(*) as c FROM health_metrics WHERE date >= ?").get(weekAgo) as { c: number }).c;
    return { latestMetrics, activeMeds, upcomingAppts, weekMetrics };
  }
}
