import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { healthMigrations } from "../assets/extensions/health/health/_module/migrations/001_health.js";
import { HealthService } from "../assets/extensions/health/health/_module/service.js";
// graph driver mocked as null in tests

describe("HealthService", () => {
  let db: Database;
  let service: HealthService;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db, "health", healthMigrations);
    service = new HealthService(db, () => null);
  });
  afterEach(() => db.close());

  it("logs a weight metric with auto unit", () => {
    const m = service.logMetric({ type: "weight", value: "72.5" });
    expect(m.unit).toBe("kg");
    expect(m.value).toBe("72.5");
  });

  it("logs blood pressure", () => {
    const m = service.logMetric({ type: "blood_pressure", value: "120/80" });
    expect(m.unit).toBe("mmHg");
  });

  it("filters metrics by type", () => {
    service.logMetric({ type: "weight", value: "72" });
    service.logMetric({ type: "heart_rate", value: "68" });
    expect(service.listMetrics({ type: "weight" })).toHaveLength(1);
  });

  it("filters metrics by date range", () => {
    service.logMetric({ type: "weight", value: "72", date: "2026-01-15" });
    service.logMetric({ type: "weight", value: "71", date: "2026-02-15" });
    expect(service.listMetrics({ from_date: "2026-02-01" })).toHaveLength(1);
  });

  it("adds and lists medications", () => {
    service.addMedication({ name: "Ibuprofen", dosage: "400mg", start_date: "2026-01-01" });
    service.addMedication({ name: "Vitamin D", dosage: "1000IU", start_date: "2026-01-01" });
    expect(service.listMedications(true)).toHaveLength(2);
  });

  it("deactivates a medication", () => {
    const med = service.addMedication({ name: "Test", start_date: "2026-01-01" });
    service.updateMedication(med.id, { active: 0, end_date: "2026-02-26" });
    expect(service.listMedications(true)).toHaveLength(0);
    expect(service.listMedications(false)).toHaveLength(1);
  });

  it("adds and lists appointments", () => {
    service.addAppointment({ title: "Dentist", date: "2026-03-15", provider: "Dr. Smith" });
    const apts = service.listAppointments({ status: "scheduled" });
    expect(apts).toHaveLength(1);
    expect(apts[0].provider).toBe("Dr. Smith");
  });

  it("completes an appointment", () => {
    const apt = service.addAppointment({ title: "Checkup", date: "2026-02-26" });
    service.updateAppointment(apt.id, { status: "completed" });
    expect(service.listAppointments({ status: "completed" })).toHaveLength(1);
  });

  it("generates summary", () => {
    service.addMedication({ name: "Med", start_date: "2026-01-01" });
    service.logMetric({ type: "weight", value: "72" });
    const s = service.summary();
    expect(s.active_medications).toBe(1);
    expect(s.latest_weight?.value).toBe("72");
  });
});
