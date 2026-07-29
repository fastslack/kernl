import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { financeMigrations } from "../assets/extensions/finance/finance/_module/migrations/001_finance.js";
import { FinanceService } from "../assets/extensions/finance/finance/_module/service.js";
// graph driver mocked as null in tests

describe("FinanceService", () => {
  let db: Database;
  let service: FinanceService;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db, "finance", financeMigrations);
    service = new FinanceService(db, () => null);
  });
  afterEach(() => db.close());

  it("creates an account", () => {
    const account = service.createAccount({ name: "ING Checking", balance_cents: 100000 });
    expect(account.id).toBeTruthy();
    expect(account.balance_cents).toBe(100000);
    expect(account.type).toBe("checking");
  });

  it("adds income and updates balance", () => {
    const acc = service.createAccount({ name: "ING", balance_cents: 50000 });
    service.addTransaction({ account_id: acc.id, type: "income", amount_cents: 300000, date: "2026-02-01" });
    const updated = service.getAccount(acc.id);
    expect(updated?.balance_cents).toBe(350000);
  });

  it("adds expense and reduces balance", () => {
    const acc = service.createAccount({ name: "ING", balance_cents: 50000 });
    service.addTransaction({ account_id: acc.id, type: "expense", amount_cents: 2500, date: "2026-02-01", category: "groceries" });
    const updated = service.getAccount(acc.id);
    expect(updated?.balance_cents).toBe(47500);
  });

  it("transfers between accounts atomically", () => {
    const acc1 = service.createAccount({ name: "Checking", balance_cents: 100000 });
    const acc2 = service.createAccount({ name: "Savings", balance_cents: 0 });
    service.transfer({ from_account_id: acc1.id, to_account_id: acc2.id, amount_cents: 25000, date: "2026-02-01" });
    expect(service.getAccount(acc1.id)?.balance_cents).toBe(75000);
    expect(service.getAccount(acc2.id)?.balance_cents).toBe(25000);
  });

  it("creates budget and tracks spending", () => {
    const acc = service.createAccount({ name: "ING" });
    const budget = service.addBudget({ name: "Groceries", category: "groceries", amount_cents: 30000 });
    service.addTransaction({ account_id: acc.id, type: "expense", amount_cents: 5000, date: new Date().toISOString().split("T")[0], category: "groceries" });
    const status = service.budgetStatus(budget.id);
    expect(status).toHaveLength(1);
    expect(status[0].spent_cents).toBe(5000);
    expect(status[0].remaining_cents).toBe(25000);
  });

  it("filters transactions by date range", () => {
    const acc = service.createAccount({ name: "ING" });
    service.addTransaction({ account_id: acc.id, amount_cents: 1000, date: "2026-01-15" });
    service.addTransaction({ account_id: acc.id, amount_cents: 2000, date: "2026-02-15" });
    const jan = service.listTransactions({ from_date: "2026-01-01", to_date: "2026-01-31" });
    expect(jan).toHaveLength(1);
  });

  it("throws on invalid account_id", () => {
    expect(() => service.addTransaction({ account_id: "invalid", amount_cents: 100, date: "2026-01-01" }))
      .toThrow("Account not found");
  });
});
