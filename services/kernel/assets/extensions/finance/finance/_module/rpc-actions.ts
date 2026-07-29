/**
 * Finance RPC Actions — accounts, transactions, budgets via mtwRequest.
 */

import crypto from "node:crypto";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { RpcAction } from "../../../../../src/core/mtw/rpc-handler.js";

export function financeRpcActions(db: SqliteDb): RpcAction[] {
  return [
    {
      name: "finance.accounts.list",
      handler: async () => {
        const rows = db.prepare(
          "SELECT id, name, type, currency, balance_cents, notes, created_at, updated_at FROM finance_accounts ORDER BY name COLLATE NOCASE",
        ).all();
        return { accounts: rows };
      },
    },
    {
      name: "finance.accounts.create",
      handler: async (args) => {
        const name = typeof args.name === "string" ? args.name.trim() : "";
        if (!name) throw new Error("Name required");
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        db.prepare(
          `INSERT INTO finance_accounts (id, name, type, currency, balance_cents, notes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, name, args.type ?? "checking", args.currency ?? "EUR", args.balance_cents ?? 0, args.notes ?? "", now, now);
        return { ok: true, id };
      },
    },
    {
      name: "finance.transactions.list",
      handler: async (args) => {
        const accountId = typeof args.account_id === "string" ? args.account_id : "";
        const category = typeof args.category === "string" ? args.category : "";
        const limit = Math.min(200, Math.max(10, typeof args.limit === "number" ? args.limit : 50));
        const offset = typeof args.offset === "number" ? args.offset : 0;

        let where = "1=1";
        const params: unknown[] = [];
        if (accountId) { where += " AND account_id = ?"; params.push(accountId); }
        if (category) { where += " AND category = ?"; params.push(category); }

        const total = (db.prepare(`SELECT COUNT(*) as c FROM finance_transactions WHERE ${where}`).get(...params) as { c: number }).c;
        const rows = db.prepare(
          `SELECT id, account_id, type, amount_cents, category, description, counterparty, date, notes, created_at
           FROM finance_transactions WHERE ${where} ORDER BY date DESC, created_at DESC LIMIT ? OFFSET ?`,
        ).all(...params, limit, offset);
        return { transactions: rows, total };
      },
    },
    {
      name: "finance.transactions.create",
      handler: async (args) => {
        const accountId = typeof args.account_id === "string" ? args.account_id : "";
        const amountCents = typeof args.amount_cents === "number" ? args.amount_cents : 0;
        if (!accountId || !amountCents) throw new Error("account_id and amount_cents required");
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        const date = typeof args.date === "string" ? args.date : now.split("T")[0];

        db.prepare(
          `INSERT INTO finance_transactions (id, account_id, type, amount_cents, category, description, counterparty, date, notes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, accountId, args.type ?? "expense", amountCents, args.category ?? "", args.description ?? "", args.counterparty ?? "", date, args.notes ?? "", now);

        // Update account balance
        const sign = args.type === "income" ? 1 : -1;
        db.prepare("UPDATE finance_accounts SET balance_cents = balance_cents + ?, updated_at = ? WHERE id = ?")
          .run(sign * Math.abs(amountCents), now, accountId);

        return { ok: true, id };
      },
    },
    {
      name: "finance.budgets.list",
      handler: async () => {
        const rows = db.prepare("SELECT id, name, category, amount_cents, period, created_at, updated_at FROM finance_budgets ORDER BY name").all();
        return { budgets: rows };
      },
    },
    {
      name: "finance.summary",
      handler: async () => {
        const accounts = db.prepare("SELECT id, name, type, currency, balance_cents FROM finance_accounts ORDER BY name").all();
        const today = new Date().toISOString().split("T")[0];
        const monthStart = today.slice(0, 7) + "-01";
        const monthTotals = db.prepare(
          `SELECT type, SUM(amount_cents) as total FROM finance_transactions
           WHERE date >= ? GROUP BY type`,
        ).all(monthStart) as { type: string; total: number }[];
        return { accounts, monthTotals, period: { from: monthStart, to: today } };
      },
    },
  ];
}
