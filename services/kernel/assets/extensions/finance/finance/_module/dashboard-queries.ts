import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { tableExists, safeAll, toRecord, today, daysFromNow } from "../../../../../src/core/db/query-helpers.js";

// ── Types ────────────────────────────────────────────

export interface DashboardFinance {
  accounts: Array<{ id: string; name: string; type: string; currency: string; balance_cents: number }>;
  totalBalanceCents: number;
  recentTransactions: Array<{ id: string; type: string; amount_cents: number; category: string; description: string; date: string; account_name: string }>;
  spendingByCategory: Record<string, number>;
  incomeVsExpense30d: { income: number; expense: number };
  budgetStatus: Array<{ name: string; category: string; budget_cents: number; spent_cents: number; period: string }>;
}

// ── Query ────────────────────────────────────────────

export function queryFinance(db: SqliteDb): DashboardFinance | null {
  if (!tableExists(db, "finance_accounts")) return null;

  const d30ago = daysFromNow(-30);

  const accounts = db
    .prepare(`SELECT id, name, type, currency, balance_cents FROM finance_accounts ORDER BY balance_cents DESC`)
    .all() as DashboardFinance["accounts"];

  const totalBalanceCents = accounts.reduce((s, a) => s + a.balance_cents, 0);

  const recentTransactions = db
    .prepare(
      `SELECT t.id, t.type, t.amount_cents, t.category, t.description, t.date, a.name as account_name
       FROM finance_transactions t
       JOIN finance_accounts a ON a.id = t.account_id
       ORDER BY t.date DESC, t.created_at DESC LIMIT 15`,
    )
    .all() as DashboardFinance["recentTransactions"];

  const spendingByCategory = toRecord(
    db
      .prepare(
        `SELECT CASE WHEN category = '' THEN '(none)' ELSE category END as key,
                SUM(amount_cents) as count
         FROM finance_transactions
         WHERE type = 'expense' AND date >= ?
         GROUP BY key ORDER BY count DESC`,
      )
      .all(d30ago) as Array<{ key: string; count: number }>,
  );

  const incomeExpense = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN type = 'income' THEN amount_cents ELSE 0 END), 0) as income,
         COALESCE(SUM(CASE WHEN type = 'expense' THEN amount_cents ELSE 0 END), 0) as expense
       FROM finance_transactions WHERE date >= ?`,
    )
    .get(d30ago) as { income: number; expense: number };

  // Budget status: compare current period spending vs budget
  const budgetStatus: DashboardFinance["budgetStatus"] = [];
  const budgets = safeAll<{ id: string; name: string; category: string; amount_cents: number; period: string }>(db,
    `SELECT id, name, category, amount_cents, period FROM finance_budgets`,
  );

  const todayStr2 = today();
  for (const b of budgets) {
    let periodStart: string;
    if (b.period === "weekly") {
      const d = new Date(todayStr2 + "T12:00:00Z");
      d.setUTCDate(d.getUTCDate() - d.getUTCDay() + 1); // Monday
      periodStart = d.toISOString().split("T")[0];
    } else if (b.period === "quarterly") {
      const m = new Date(todayStr2 + "T12:00:00Z").getUTCMonth();
      const qStart = m - (m % 3);
      periodStart = `${todayStr2.slice(0, 4)}-${String(qStart + 1).padStart(2, "0")}-01`;
    } else if (b.period === "yearly") {
      periodStart = `${todayStr2.slice(0, 4)}-01-01`;
    } else {
      periodStart = `${todayStr2.slice(0, 7)}-01`; // monthly
    }

    const catFilter = b.category ? `AND category = ?` : "";
    const params: string[] = [periodStart];
    if (b.category) params.push(b.category);

    const spent = (
      db.prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) as total
         FROM finance_transactions
         WHERE type = 'expense' AND date >= ? ${catFilter}`,
      ).get(...params) as { total: number }
    ).total;

    budgetStatus.push({ name: b.name, category: b.category, budget_cents: b.amount_cents, spent_cents: spent, period: b.period });
  }

  return {
    accounts,
    totalBalanceCents,
    recentTransactions,
    spendingByCategory,
    incomeVsExpense30d: incomeExpense,
    budgetStatus,
  };
}
