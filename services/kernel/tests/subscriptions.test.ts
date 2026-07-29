import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { subscriptionsMigrations } from "../assets/extensions/finance/subscriptions/_module/migrations/001_subscriptions.js";
import { SubscriptionService } from "../assets/extensions/finance/subscriptions/_module/service.js";
import { advanceBillingDate } from "../assets/extensions/finance/subscriptions/_module/helpers.js";
// graph driver mocked as null in tests

describe("SubscriptionService", () => {
  let db: Database;
  let service: SubscriptionService;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db, "subscriptions", subscriptionsMigrations);
    service = new SubscriptionService(db, () => null);
  });
  afterEach(() => db.close());

  it("creates a subscription with defaults", () => {
    const sub = service.create({ name: "Netflix", amount_cents: 1299, start_date: "2026-01-01" });
    expect(sub.id).toBeTruthy();
    expect(sub.status).toBe("active");
    expect(sub.billing_cycle).toBe("monthly");
    expect(sub.currency).toBe("EUR");
    expect(sub.next_billing).toBe("2026-02-01");
  });

  it("lists active subscriptions", () => {
    service.create({ name: "Netflix", amount_cents: 1299, start_date: "2026-01-01" });
    service.create({ name: "Spotify", amount_cents: 999, start_date: "2026-01-15" });
    expect(service.list({ status: "active" })).toHaveLength(2);
  });

  it("cancels a subscription", () => {
    const sub = service.create({ name: "Netflix", amount_cents: 1299, start_date: "2026-01-01" });
    const cancelled = service.cancel(sub.id);
    expect(cancelled?.status).toBe("cancelled");
    expect(service.list({ status: "active" })).toHaveLength(0);
  });

  it("pauses and resumes", () => {
    const sub = service.create({ name: "Gym", amount_cents: 3500, start_date: "2026-01-01" });
    service.pause(sub.id);
    expect(service.getById(sub.id)?.status).toBe("paused");
    service.resume(sub.id);
    expect(service.getById(sub.id)?.status).toBe("active");
  });

  it("calculates summary correctly", () => {
    service.create({ name: "Netflix", amount_cents: 1299, start_date: "2026-01-01", category: "streaming" });
    service.create({ name: "Spotify", amount_cents: 999, start_date: "2026-01-01", category: "streaming" });
    service.create({ name: "Gym", amount_cents: 3500, start_date: "2026-01-01", category: "fitness" });
    const summary = service.summary();
    expect(summary.active_count).toBe(3);
    expect(summary.monthly_total_cents).toBe(1299 + 999 + 3500);
    expect(summary.by_category).toHaveLength(2);
  });

  it("updates subscription details", () => {
    const sub = service.create({ name: "Netflix", amount_cents: 1299, start_date: "2026-01-01" });
    const updated = service.update(sub.id, { amount_cents: 1599 });
    expect(updated?.amount_cents).toBe(1599);
  });
});

describe("advanceBillingDate", () => {
  it("advances monthly", () => {
    expect(advanceBillingDate("2026-01-15", "monthly")).toBe("2026-02-15");
  });
  it("advances yearly", () => {
    expect(advanceBillingDate("2026-03-01", "yearly")).toBe("2027-03-01");
  });
  it("clamps month overflow", () => {
    expect(advanceBillingDate("2026-01-31", "monthly")).toBe("2026-02-28");
  });
  it("advances weekly", () => {
    expect(advanceBillingDate("2026-01-01", "weekly")).toBe("2026-01-08");
  });
});
