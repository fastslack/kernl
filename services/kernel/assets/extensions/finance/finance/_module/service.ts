import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { GraphDriver } from "../../../../../src/core/db-drivers/graph-driver.js";
import type { FinanceAccount, FinanceTransaction, FinanceBudget, AccountType, TransactionType, BudgetPeriod } from "./types.js";
import { newId, isoNow } from "../../../../../src/core/helpers.js";

import { formatCents } from "../../../../../src/core/formatting.js";

export class FinanceService {
  constructor(
    private db: SqliteDb,
    private getGraph: () => GraphDriver | null,
  ) {}

  // ── Accounts ────────────────────────────────────────

  createAccount(input: {
    name: string;
    type?: AccountType;
    currency?: string;
    balance_cents?: number;
    notes?: string;
  }): FinanceAccount {
    const now = isoNow();
    const account: FinanceAccount = {
      id: newId(),
      name: input.name,
      type: input.type ?? "checking",
      currency: input.currency ?? "EUR",
      balance_cents: input.balance_cents ?? 0,
      notes: input.notes ?? "",
      created_at: now,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO finance_accounts (id, name, type, currency, balance_cents, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(account.id, account.name, account.type, account.currency, account.balance_cents, account.notes, account.created_at, account.updated_at);

    return account;
  }

  getAccount(id: string): FinanceAccount | undefined {
    return this.db.prepare("SELECT * FROM finance_accounts WHERE id = ?").get(id) as FinanceAccount | undefined;
  }

  listAccounts(): FinanceAccount[] {
    return this.db.prepare("SELECT * FROM finance_accounts ORDER BY name ASC").all() as FinanceAccount[];
  }

  // ── Transactions ────────────────────────────────────

  addTransaction(input: {
    account_id: string;
    type?: TransactionType;
    amount_cents: number;
    category?: string;
    description?: string;
    counterparty?: string;
    date: string;
    notes?: string;
  }): FinanceTransaction {
    const account = this.getAccount(input.account_id);
    if (!account) throw new Error(`Account not found: ${input.account_id}`);

    const now = isoNow();
    const tx: FinanceTransaction = {
      id: newId(),
      account_id: input.account_id,
      type: input.type ?? "expense",
      amount_cents: input.amount_cents,
      category: input.category ?? "",
      description: input.description ?? "",
      counterparty: input.counterparty ?? "",
      date: input.date,
      transfer_to: null,
      notes: input.notes ?? "",
      created_at: now,
    };

    const balanceDelta = tx.type === "income" ? tx.amount_cents : -tx.amount_cents;

    const insertTx = this.db.prepare(
      `INSERT INTO finance_transactions (id, account_id, type, amount_cents, category, description, counterparty, date, transfer_to, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const updateBalance = this.db.prepare(
      `UPDATE finance_accounts SET balance_cents = balance_cents + ?, updated_at = ? WHERE id = ?`,
    );

    const run = this.db.transaction(() => {
      insertTx.run(tx.id, tx.account_id, tx.type, tx.amount_cents, tx.category, tx.description, tx.counterparty, tx.date, tx.transfer_to, tx.notes, tx.created_at);
      updateBalance.run(balanceDelta, now, tx.account_id);
    });
    run();

    return tx;
  }

  transfer(input: {
    from_account_id: string;
    to_account_id: string;
    amount_cents: number;
    date: string;
    description?: string;
    notes?: string;
  }): { from_tx: FinanceTransaction; to_tx: FinanceTransaction } {
    const fromAccount = this.getAccount(input.from_account_id);
    const toAccount = this.getAccount(input.to_account_id);
    if (!fromAccount) throw new Error(`Source account not found: ${input.from_account_id}`);
    if (!toAccount) throw new Error(`Destination account not found: ${input.to_account_id}`);

    const now = isoNow();
    const desc = input.description ?? `Transfer to ${toAccount.name}`;

    const fromTx: FinanceTransaction = {
      id: newId(),
      account_id: input.from_account_id,
      type: "transfer",
      amount_cents: input.amount_cents,
      category: "transfer",
      description: desc,
      counterparty: toAccount.name,
      date: input.date,
      transfer_to: input.to_account_id,
      notes: input.notes ?? "",
      created_at: now,
    };

    const toTx: FinanceTransaction = {
      id: newId(),
      account_id: input.to_account_id,
      type: "transfer",
      amount_cents: input.amount_cents,
      category: "transfer",
      description: `Transfer from ${fromAccount.name}`,
      counterparty: fromAccount.name,
      date: input.date,
      transfer_to: input.from_account_id,
      notes: input.notes ?? "",
      created_at: now,
    };

    const insertTx = this.db.prepare(
      `INSERT INTO finance_transactions (id, account_id, type, amount_cents, category, description, counterparty, date, transfer_to, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const updateBalance = this.db.prepare(
      `UPDATE finance_accounts SET balance_cents = balance_cents + ?, updated_at = ? WHERE id = ?`,
    );

    const run = this.db.transaction(() => {
      insertTx.run(fromTx.id, fromTx.account_id, fromTx.type, fromTx.amount_cents, fromTx.category, fromTx.description, fromTx.counterparty, fromTx.date, fromTx.transfer_to, fromTx.notes, fromTx.created_at);
      insertTx.run(toTx.id, toTx.account_id, toTx.type, toTx.amount_cents, toTx.category, toTx.description, toTx.counterparty, toTx.date, toTx.transfer_to, toTx.notes, toTx.created_at);
      updateBalance.run(-input.amount_cents, now, input.from_account_id);
      updateBalance.run(input.amount_cents, now, input.to_account_id);
    });
    run();

    return { from_tx: fromTx, to_tx: toTx };
  }

  listTransactions(filters?: {
    account_id?: string;
    type?: TransactionType;
    category?: string;
    from_date?: string;
    to_date?: string;
    limit?: number;
  }): FinanceTransaction[] {
    let sql = "SELECT * FROM finance_transactions WHERE 1=1";
    const params: unknown[] = [];

    if (filters?.account_id) { sql += " AND account_id = ?"; params.push(filters.account_id); }
    if (filters?.type) { sql += " AND type = ?"; params.push(filters.type); }
    if (filters?.category) { sql += " AND category = ?"; params.push(filters.category); }
    if (filters?.from_date) { sql += " AND date >= ?"; params.push(filters.from_date); }
    if (filters?.to_date) { sql += " AND date <= ?"; params.push(filters.to_date); }

    sql += " ORDER BY date DESC, created_at DESC";
    if (filters?.limit) { sql += " LIMIT ?"; params.push(filters.limit); }

    return this.db.prepare(sql).all(...params) as FinanceTransaction[];
  }

  // ── Budgets ────────────────────────────────────────

  addBudget(input: {
    name: string;
    category?: string;
    amount_cents: number;
    period?: BudgetPeriod;
  }): FinanceBudget {
    const now = isoNow();
    const budget: FinanceBudget = {
      id: newId(),
      name: input.name,
      category: input.category ?? "",
      amount_cents: input.amount_cents,
      period: input.period ?? "monthly",
      created_at: now,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO finance_budgets (id, name, category, amount_cents, period, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(budget.id, budget.name, budget.category, budget.amount_cents, budget.period, budget.created_at, budget.updated_at);

    return budget;
  }

  listBudgets(): FinanceBudget[] {
    return this.db.prepare("SELECT * FROM finance_budgets ORDER BY name ASC").all() as FinanceBudget[];
  }

  budgetStatus(budgetId?: string): {
    budget: FinanceBudget;
    spent_cents: number;
    remaining_cents: number;
    percentage: number;
  }[] {
    const budgets = budgetId
      ? [this.db.prepare("SELECT * FROM finance_budgets WHERE id = ?").get(budgetId) as FinanceBudget].filter(Boolean)
      : this.listBudgets();

    const now = new Date();
    return budgets.map((budget) => {
      const { from, to } = this.periodRange(budget.period, now);
      const row = this.db
        .prepare(
          `SELECT COALESCE(SUM(amount_cents), 0) as total
           FROM finance_transactions
           WHERE type = 'expense' AND category = ? AND date >= ? AND date <= ?`,
        )
        .get(budget.category, from, to) as { total: number };

      const spent = row.total;
      return {
        budget,
        spent_cents: spent,
        remaining_cents: budget.amount_cents - spent,
        percentage: budget.amount_cents > 0 ? Math.round((spent / budget.amount_cents) * 100) : 0,
      };
    });
  }

  summary(): {
    total_balance_cents: number;
    accounts: { name: string; balance: string; type: string }[];
    this_month_income: number;
    this_month_expenses: number;
    currency: string;
  } {
    const accounts = this.listAccounts();
    const totalBalance = accounts.reduce((sum, a) => sum + a.balance_cents, 0);

    const now = new Date();
    const monthStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
    const monthEnd = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-31`;

    const income = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) as total FROM finance_transactions
         WHERE type = 'income' AND date >= ? AND date <= ?`,
      )
      .get(monthStart, monthEnd) as { total: number };

    const expenses = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) as total FROM finance_transactions
         WHERE type = 'expense' AND date >= ? AND date <= ?`,
      )
      .get(monthStart, monthEnd) as { total: number };

    return {
      total_balance_cents: totalBalance,
      accounts: accounts.map((a) => ({ name: a.name, balance: formatCents(a.balance_cents), type: a.type })),
      this_month_income: income.total,
      this_month_expenses: expenses.total,
      currency: accounts[0]?.currency ?? "EUR",
    };
  }

  private periodRange(period: BudgetPeriod, now: Date): { from: string; to: string } {
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    switch (period) {
      case "weekly": {
        const day = now.getUTCDay();
        const start = new Date(now);
        start.setUTCDate(start.getUTCDate() - day + 1); // Monday
        const end = new Date(start);
        end.setUTCDate(end.getUTCDate() + 6);
        return { from: start.toISOString().split("T")[0], to: end.toISOString().split("T")[0] };
      }
      case "monthly":
        return {
          from: `${y}-${String(m + 1).padStart(2, "0")}-01`,
          to: `${y}-${String(m + 1).padStart(2, "0")}-31`,
        };
      case "quarterly": {
        const qStart = Math.floor(m / 3) * 3;
        return {
          from: `${y}-${String(qStart + 1).padStart(2, "0")}-01`,
          to: `${y}-${String(qStart + 3).padStart(2, "0")}-31`,
        };
      }
      case "yearly":
        return { from: `${y}-01-01`, to: `${y}-12-31` };
    }
  }
}
