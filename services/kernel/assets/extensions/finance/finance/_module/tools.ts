import { z } from "zod";
import { type ToolDefinition, defineTool, defineToolNoInput, textResult } from "@kernl/extension-sdk";
import type { FinanceService } from "./service.js";

function fmt(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function financeTools(service: FinanceService): ToolDefinition[] {
  return [
    defineTool({
      name: "kernel_finance_add_account",
      description: "Create a financial account (checking, savings, credit card, cash, investment).",
      schema: z.object({
        name: z.string().describe("Account name (e.g. ING Checking, Revolut)"),
        type: z.enum(["checking", "savings", "credit", "cash", "investment"]).optional()
          .describe("Account type (default: checking)"),
        currency: z.string().optional().describe("Currency code (default: EUR)"),
        balance_cents: z.number().optional().describe("Opening balance in cents"),
        notes: z.string().optional(),
      }),
      handler: async (input) => {
        const account = service.createAccount(input);
        return textResult(
          `Account created:\n  ID: ${account.id}\n  Name: ${account.name}\n  Type: ${account.type}\n  Balance: ${fmt(account.balance_cents)} ${account.currency}`,
        );
      },
    }),

    defineToolNoInput({
      name: "kernel_finance_list_accounts",
      description: "List all financial accounts with balances.",
      handler: async () => {
        const accounts = service.listAccounts();
        if (accounts.length === 0) return textResult("No accounts found.");
        const lines = accounts.map(
          (a) => `[${a.type.toUpperCase()}] ${a.name} — ${fmt(a.balance_cents)} ${a.currency}\n  ID: ${a.id}`,
        );
        return textResult(`${accounts.length} account(s):\n\n${lines.join("\n\n")}`);
      },
    }),

    defineTool({
      name: "kernel_finance_add_transaction",
      description: "Record a financial transaction (income or expense). Automatically updates account balance.",
      schema: z.object({
        account_id: z.string().describe("Account ID"),
        type: z.enum(["income", "expense"]).optional().describe("Transaction type (default: expense)"),
        amount_cents: z.number().describe("Amount in cents (e.g. 2500 = 25.00)"),
        category: z.string().optional().describe("Category (e.g. groceries, salary, rent)"),
        description: z.string().optional().describe("What was this for"),
        counterparty: z.string().optional().describe("Who paid / received"),
        date: z.string().describe("Transaction date (YYYY-MM-DD)"),
        notes: z.string().optional(),
      }),
      handler: async (input) => {
        const tx = service.addTransaction(input);
        return textResult(
          `Transaction recorded:\n  ID: ${tx.id}\n  Type: ${tx.type}\n  Amount: ${fmt(tx.amount_cents)}\n  Category: ${tx.category || "none"}\n  Date: ${tx.date}`,
        );
      },
    }),

    defineTool({
      name: "kernel_finance_list_transactions",
      description: "List transactions with filters by account, type, category, or date range.",
      schema: z.object({
        account_id: z.string().optional().describe("Filter by account"),
        type: z.enum(["income", "expense", "transfer"]).optional(),
        category: z.string().optional(),
        from_date: z.string().optional().describe("Start date (YYYY-MM-DD)"),
        to_date: z.string().optional().describe("End date (YYYY-MM-DD)"),
        limit: z.number().optional().describe("Max results (default: all)"),
      }),
      handler: async (filters) => {
        const txs = service.listTransactions(filters);
        if (txs.length === 0) return textResult("No transactions found.");

        const lines = txs.map(
          (t) => `${t.date} [${t.type.toUpperCase()}] ${fmt(t.amount_cents)} — ${t.description || t.category || "no description"}${t.counterparty ? ` (${t.counterparty})` : ""}\n  ID: ${t.id}`,
        );
        return textResult(`${txs.length} transaction(s):\n\n${lines.join("\n\n")}`);
      },
    }),

    defineTool({
      name: "kernel_finance_transfer",
      description: "Transfer money between two accounts. Creates paired transactions and updates both balances atomically.",
      schema: z.object({
        from_account_id: z.string().describe("Source account ID"),
        to_account_id: z.string().describe("Destination account ID"),
        amount_cents: z.number().describe("Amount in cents"),
        date: z.string().describe("Transfer date (YYYY-MM-DD)"),
        description: z.string().optional(),
        notes: z.string().optional(),
      }),
      handler: async (input) => {
        const { from_tx, to_tx } = service.transfer(input);
        return textResult(
          `Transfer completed:\n  Amount: ${fmt(input.amount_cents)}\n  From TX: ${from_tx.id}\n  To TX: ${to_tx.id}`,
        );
      },
    }),

    defineTool({
      name: "kernel_finance_add_budget",
      description: "Create a spending budget for a category with a period (weekly/monthly/quarterly/yearly).",
      schema: z.object({
        name: z.string().describe("Budget name (e.g. Groceries, Entertainment)"),
        category: z.string().optional().describe("Category to track (matches transaction category)"),
        amount_cents: z.number().describe("Budget limit in cents"),
        period: z.enum(["weekly", "monthly", "quarterly", "yearly"]).optional()
          .describe("Budget period (default: monthly)"),
      }),
      handler: async (input) => {
        const budget = service.addBudget(input);
        return textResult(
          `Budget created:\n  ID: ${budget.id}\n  Name: ${budget.name}\n  Limit: ${fmt(budget.amount_cents)}/${budget.period}\n  Category: ${budget.category || "all"}`,
        );
      },
    }),

    defineTool({
      name: "kernel_finance_budget_status",
      description: "Check budget spending status: how much spent vs budget limit for the current period.",
      schema: z.object({
        budget_id: z.string().optional().describe("Specific budget ID (omit for all budgets)"),
      }),
      handler: async ({ budget_id }) => {
        const statuses = service.budgetStatus(budget_id);
        if (statuses.length === 0) return textResult("No budgets found.");

        const lines = statuses.map((s) => {
          const bar = s.percentage >= 100 ? "OVER" : `${s.percentage}%`;
          return `${s.budget.name} (${s.budget.category || "all"}):\n  ${fmt(s.spent_cents)} / ${fmt(s.budget.amount_cents)} [${bar}]\n  Remaining: ${fmt(s.remaining_cents)}`;
        });
        return textResult(`Budget status:\n\n${lines.join("\n\n")}`);
      },
    }),

    defineToolNoInput({
      name: "kernel_finance_summary",
      description: "Financial overview: all account balances, this month's income vs expenses.",
      handler: async () => {
        const s = service.summary();
        if (s.accounts.length === 0) return textResult("No financial accounts set up.");

        const accountLines = s.accounts.map((a) => `  ${a.name} (${a.type}): ${a.balance} ${s.currency}`);
        return textResult(
          `Total balance: ${fmt(s.total_balance_cents)} ${s.currency}\n\nAccounts:\n${accountLines.join("\n")}\n\nThis month:\n  Income:   ${fmt(s.this_month_income)} ${s.currency}\n  Expenses: ${fmt(s.this_month_expenses)} ${s.currency}\n  Net:      ${fmt(s.this_month_income - s.this_month_expenses)} ${s.currency}`,
        );
      },
    }),
  ];
}
