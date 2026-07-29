import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { GraphDriver } from "../../../../../src/core/db-drivers/graph-driver.js";
import type { Subscription, SubscriptionStatus, BillingCycle } from "./types.js";
import { newId, isoNow } from "../../../../../src/core/helpers.js";
import { advanceBillingDate, formatCents } from "./helpers.js";

export class SubscriptionService {
  constructor(
    private db: SqliteDb,
    private getGraph: () => GraphDriver | null,
  ) {}

  create(input: {
    name: string;
    provider?: string;
    amount_cents: number;
    currency?: string;
    billing_cycle?: BillingCycle;
    category?: string;
    start_date: string;
    next_billing?: string;
    url?: string;
    notes?: string;
  }): Subscription {
    const now = isoNow();
    const cycle = input.billing_cycle ?? "monthly";
    const sub: Subscription = {
      id: newId(),
      name: input.name,
      provider: input.provider ?? "",
      amount_cents: input.amount_cents,
      currency: input.currency ?? "EUR",
      billing_cycle: cycle,
      category: input.category ?? "",
      status: "active",
      start_date: input.start_date,
      next_billing: input.next_billing ?? advanceBillingDate(input.start_date, cycle),
      url: input.url ?? "",
      notes: input.notes ?? "",
      created_at: now,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO subscriptions (id, name, provider, amount_cents, currency,
         billing_cycle, category, status, start_date, next_billing, url, notes,
         created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sub.id, sub.name, sub.provider, sub.amount_cents, sub.currency,
        sub.billing_cycle, sub.category, sub.status, sub.start_date,
        sub.next_billing, sub.url, sub.notes, sub.created_at, sub.updated_at,
      );

    return sub;
  }

  getById(id: string): Subscription | undefined {
    return this.db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(id) as
      | Subscription
      | undefined;
  }

  update(
    id: string,
    changes: Partial<Pick<Subscription, "name" | "provider" | "amount_cents" | "currency" | "billing_cycle" | "category" | "next_billing" | "url" | "notes">>,
  ): Subscription | undefined {
    const existing = this.getById(id);
    if (!existing) return undefined;

    const updated = { ...existing, ...changes, updated_at: isoNow() };

    this.db
      .prepare(
        `UPDATE subscriptions SET name=?, provider=?, amount_cents=?, currency=?,
         billing_cycle=?, category=?, next_billing=?, url=?, notes=?, updated_at=?
         WHERE id=?`,
      )
      .run(
        updated.name, updated.provider, updated.amount_cents, updated.currency,
        updated.billing_cycle, updated.category, updated.next_billing,
        updated.url, updated.notes, updated.updated_at, id,
      );

    return updated;
  }

  cancel(id: string): Subscription | undefined {
    const existing = this.getById(id);
    if (!existing) return undefined;

    const now = isoNow();
    this.db
      .prepare(`UPDATE subscriptions SET status='cancelled', updated_at=? WHERE id=?`)
      .run(now, id);

    return { ...existing, status: "cancelled", updated_at: now };
  }

  pause(id: string): Subscription | undefined {
    const existing = this.getById(id);
    if (!existing) return undefined;

    const now = isoNow();
    this.db
      .prepare(`UPDATE subscriptions SET status='paused', updated_at=? WHERE id=?`)
      .run(now, id);

    return { ...existing, status: "paused", updated_at: now };
  }

  resume(id: string): Subscription | undefined {
    const existing = this.getById(id);
    if (!existing || existing.status !== "paused") return undefined;

    const now = isoNow();
    const today = now.split("T")[0];
    let nextBilling = existing.next_billing;
    // If next_billing is in the past, advance to future
    while (nextBilling < today) {
      nextBilling = advanceBillingDate(nextBilling, existing.billing_cycle);
    }

    this.db
      .prepare(`UPDATE subscriptions SET status='active', next_billing=?, updated_at=? WHERE id=?`)
      .run(nextBilling, now, id);

    return { ...existing, status: "active", next_billing: nextBilling, updated_at: now };
  }

  list(filters?: { status?: SubscriptionStatus; category?: string }): Subscription[] {
    let sql = "SELECT * FROM subscriptions WHERE 1=1";
    const params: unknown[] = [];

    if (filters?.status) {
      sql += " AND status = ?";
      params.push(filters.status);
    }
    if (filters?.category) {
      sql += " AND category = ?";
      params.push(filters.category);
    }

    sql += " ORDER BY next_billing ASC";
    return this.db.prepare(sql).all(...params) as Subscription[];
  }

  upcoming(days: number = 30): Subscription[] {
    const cutoff = new Date(Date.now() + days * 86400000).toISOString().split("T")[0];
    return this.db
      .prepare(
        `SELECT * FROM subscriptions
         WHERE status = 'active' AND next_billing <= ?
         ORDER BY next_billing ASC`,
      )
      .all(cutoff) as Subscription[];
  }

  summary(): {
    active_count: number;
    monthly_total_cents: number;
    yearly_total_cents: number;
    by_category: { category: string; count: number; monthly_cents: number }[];
    currency: string;
  } {
    const active = this.list({ status: "active" });

    let monthlyTotal = 0;
    const catMap = new Map<string, { count: number; monthly_cents: number }>();

    for (const sub of active) {
      const monthly = this.toMonthlyCents(sub.amount_cents, sub.billing_cycle);
      monthlyTotal += monthly;

      const cat = sub.category || "uncategorized";
      const existing = catMap.get(cat) ?? { count: 0, monthly_cents: 0 };
      existing.count++;
      existing.monthly_cents += monthly;
      catMap.set(cat, existing);
    }

    const by_category = [...catMap.entries()]
      .map(([category, data]) => ({ category, ...data }))
      .sort((a, b) => b.monthly_cents - a.monthly_cents);

    return {
      active_count: active.length,
      monthly_total_cents: monthlyTotal,
      yearly_total_cents: monthlyTotal * 12,
      by_category,
      currency: active[0]?.currency ?? "EUR",
    };
  }

  private toMonthlyCents(amountCents: number, cycle: BillingCycle): number {
    switch (cycle) {
      case "weekly": return Math.round(amountCents * 52 / 12);
      case "monthly": return amountCents;
      case "quarterly": return Math.round(amountCents / 3);
      case "yearly": return Math.round(amountCents / 12);
    }
  }
}
