import { z } from "zod";
import type { ToolDefinition } from "../../../../../src/core/types.js";
import type { FinanceService } from "./service.js";
import { textResult, errorResult } from "../../../../../src/core/helpers.js";

function fmt(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function financeTools(service: FinanceService): ToolDefinition[] {
  return [
    {
      name: "kernel_finance_add_account",
      description: "Create a financial account (checking, savings, credit card, cash, investment).",
      inputSchema: z.object({
        name: z.string().describe("Account name (e.g. ING Checking, Revolut)"),
        type: z.enum(["checking", "savings", "credit", "cash", "investment"]).optional()
          .describe("Account type (default: checking)"),
        currency: z.string().optional().describe("Currency code (default: EUR)"),
        balance_cents: z.number().optional().describe("Opening balance in cents"),
        notes: z.string().optional(),
      }),
      handler: async (args) => {
        const input = args as { name: string; type?: "checking" | "savings" | "credit" | "cash" | "investment"; currency?: string; balance_cents?: number; notes?: string };
        const account = service.createAccount(input);
        return textResult(
          `Account created:\n  ID: ${account.id}\n  Name: ${account.name}\n  Type: ${account.type}\n  Balance: ${fmt(account.balance_cents)} ${account.currency}`,
        );
      },
    },

    {
      name: "kernel_finance_list_accounts",
      description: "List all financial accounts with balances.",
      inputSchema: z.object({}),
      handler: async () => {
        const accounts = service.listAccounts();
        if (accounts.length === 0) return textResult("No accounts found.");
        const lines = accounts.map(
          (a) => `[${a.type.toUpperCase()}] ${a.name} — ${fmt(a.balance_cents)} ${a.currency}\n  ID: ${a.id}`,
        );
        return textResult(`${accounts.length} account(s):\n\n${lines.join("\n\n")}`);
      },
    },

    {
      name: "kernel_finance_add_transaction",
      description: "Record a financial transaction (income or expense). Automatically updates account balance.",
      inputSchema: z.object({
        account_id: z.string().describe("Account ID"),
        type: z.enum(["income", "expense"]).optional().describe("Transaction type (default: expense)"),
        amount_cents: z.number().describe("Amount in cents (e.g. 2500 = 25.00)"),
        category: z.string().optional().describe("Category (e.g. groceries, salary, rent)"),
        description: z.string().optional().describe("What was this for"),
        counterparty: z.string().optional().describe("Who paid / received"),
        date: z.string().describe("Transaction date (YYYY-MM-DD)"),
        notes: z.string().optional(),
      }),
      handler: async (args) => {
        const input = args as { account_id: string; type?: "income" | "expense"; amount_cents: number; category?: string; description?: string; counterparty?: string; date: string; notes?: string };
        try {
          const tx = service.addTransaction(input);
          return textResult(
            `Transaction recorded:\n  ID: ${tx.id}\n  Type: ${tx.type}\n  Amount: ${fmt(tx.amount_cents)}\n  Category: ${tx.category || "none"}\n  Date: ${tx.date}`,
          );
        } catch (e) {
          return errorResult((e as Error).message);
        }
      },
    },

    {
      name: "kernel_finance_list_transactions",
      description: "List transactions with filters by account, type, category, or date range.",
      inputSchema: z.object({
        account_id: z.string().optional().describe("Filter by account"),
        type: z.enum(["income", "expense", "transfer"]).optional(),
        category: z.string().optional(),
        from_date: z.string().optional().describe("Start date (YYYY-MM-DD)"),
        to_date: z.string().optional().describe("End date (YYYY-MM-DD)"),
        limit: z.number().optional().describe("Max results (default: all)"),
      }),
      handler: async (args) => {
        const filters = args as { account_id?: string; type?: "income" | "expense" | "transfer"; category?: string; from_date?: string; to_date?: string; limit?: number };
        const txs = service.listTransactions(filters);
        if (txs.length === 0) return textResult("No transactions found.");

        const lines = txs.map(
          (t) => `${t.date} [${t.type.toUpperCase()}] ${fmt(t.amount_cents)} — ${t.description || t.category || "no description"}${t.counterparty ? ` (${t.counterparty})` : ""}\n  ID: ${t.id}`,
        );
        return textResult(`${txs.length} transaction(s):\n\n${lines.join("\n\n")}`);
      },
    },

    {
      name: "kernel_finance_transfer",
      description: "Transfer money between two accounts. Creates paired transactions and updates both balances atomically.",
      inputSchema: z.object({
        from_account_id: z.string().describe("Source account ID"),
        to_account_id: z.string().describe("Destination account ID"),
        amount_cents: z.number().describe("Amount in cents"),
        date: z.string().describe("Transfer date (YYYY-MM-DD)"),
        description: z.string().optional(),
        notes: z.string().optional(),
      }),
      handler: async (args) => {
        const input = args as { from_account_id: string; to_account_id: string; amount_cents: number; date: string; description?: string; notes?: string };
        try {
          const { from_tx, to_tx } = service.transfer(input);
          return textResult(
            `Transfer completed:\n  Amount: ${fmt(input.amount_cents)}\n  From TX: ${from_tx.id}\n  To TX: ${to_tx.id}`,
          );
        } catch (e) {
          return errorResult((e as Error).message);
        }
      },
    },

    {
      name: "kernel_finance_add_budget",
      description: "Create a spending budget for a category with a period (weekly/monthly/quarterly/yearly).",
      inputSchema: z.object({
        name: z.string().describe("Budget name (e.g. Groceries, Entertainment)"),
        category: z.string().optional().describe("Category to track (matches transaction category)"),
        amount_cents: z.number().describe("Budget limit in cents"),
        period: z.enum(["weekly", "monthly", "quarterly", "yearly"]).optional()
          .describe("Budget period (default: monthly)"),
      }),
      handler: async (args) => {
        const input = args as { name: string; category?: string; amount_cents: number; period?: "weekly" | "monthly" | "quarterly" | "yearly" };
        const budget = service.addBudget(input);
        return textResult(
          `Budget created:\n  ID: ${budget.id}\n  Name: ${budget.name}\n  Limit: ${fmt(budget.amount_cents)}/${budget.period}\n  Category: ${budget.category || "all"}`,
        );
      },
    },

    {
      name: "kernel_finance_budget_status",
      description: "Check budget spending status: how much spent vs budget limit for the current period.",
      inputSchema: z.object({
        budget_id: z.string().optional().describe("Specific budget ID (omit for all budgets)"),
      }),
      handler: async (args) => {
        const { budget_id } = args as { budget_id?: string };
        const statuses = service.budgetStatus(budget_id);
        if (statuses.length === 0) return textResult("No budgets found.");

        const lines = statuses.map((s) => {
          const bar = s.percentage >= 100 ? "OVER" : `${s.percentage}%`;
          return `${s.budget.name} (${s.budget.category || "all"}):\n  ${fmt(s.spent_cents)} / ${fmt(s.budget.amount_cents)} [${bar}]\n  Remaining: ${fmt(s.remaining_cents)}`;
        });
        return textResult(`Budget status:\n\n${lines.join("\n\n")}`);
      },
    },

    {
      name: "kernel_finance_summary",
      description: "Financial overview: all account balances, this month's income vs expenses.",
      inputSchema: z.object({}),
      handler: async () => {
        const s = service.summary();
        if (s.accounts.length === 0) return textResult("No financial accounts set up.");

        const accountLines = s.accounts.map((a) => `  ${a.name} (${a.type}): ${a.balance} ${s.currency}`);
        return textResult(
          `Total balance: ${fmt(s.total_balance_cents)} ${s.currency}\n\nAccounts:\n${accountLines.join("\n")}\n\nThis month:\n  Income:   ${fmt(s.this_month_income)} ${s.currency}\n  Expenses: ${fmt(s.this_month_expenses)} ${s.currency}\n  Net:      ${fmt(s.this_month_income - s.this_month_expenses)} ${s.currency}`,
        );
      },
    },
  ];
}
