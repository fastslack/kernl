/**
 * Finance RPC Actions — accounts, transactions, budgets via mtwRequest.
 *
 * RPC-only (no HTTP twin); each one reads its args with pickArgs and goes
 * through FinanceService, so the writes get the service's checks: a
 * transaction lands with its balance update in one SQLite transaction and
 * only against an account that exists.
 */

import { HttpError, pickArgs, rpcActionsFrom, type RpcAction } from "@kernl/extension-sdk";
import type { FinanceService } from "./service.js";
import type { AccountType, TransactionType } from "./types.js";

export function financeRpcActions(service: FinanceService): RpcAction[] {
  return rpcActionsFrom({
    "finance.accounts.list": () => ({ accounts: service.listAccounts() }),

    "finance.accounts.create": (input) => {
      const args = pickArgs(input, { name: "string", type: "string", currency: "string", balance_cents: "number", notes: "string" });
      const name = args.name?.trim() ?? "";
      if (!name) throw new HttpError(400, "Name required");
      if (args.balance_cents !== undefined && !Number.isInteger(args.balance_cents)) {
        throw new HttpError(400, "balance_cents must be an integer");
      }
      const account = service.createAccount({ ...args, name, type: args.type as AccountType | undefined });
      return { ok: true, id: account.id };
    },

    "finance.transactions.list": (input) => {
      const args = pickArgs(input, { account_id: "string", category: "string", limit: "number", offset: "number" });
      const filters = { account_id: args.account_id || undefined, category: args.category || undefined };
      const limit = Math.min(200, Math.max(10, args.limit ?? 50));
      return {
        transactions: service.listTransactions({ ...filters, limit, offset: args.offset ?? 0 }),
        total: service.countTransactions(filters),
      };
    },

    "finance.transactions.create": (input) => {
      const args = pickArgs(input, {
        account_id: "string", type: "string", amount_cents: "number", category: "string",
        description: "string", counterparty: "string", date: "string", notes: "string",
      });
      if (!args.account_id || !args.amount_cents) throw new HttpError(400, "account_id and amount_cents required");
      if (!Number.isInteger(args.amount_cents)) throw new HttpError(400, "amount_cents must be an integer");
      // The type carries the direction: the amount is stored as a magnitude, as
      // the balance update always treated it.
      const tx = service.addTransaction({
        ...args,
        account_id: args.account_id,
        type: args.type as TransactionType | undefined,
        amount_cents: Math.abs(args.amount_cents),
        date: args.date ?? new Date().toISOString().split("T")[0],
      });
      return { ok: true, id: tx.id };
    },

    "finance.budgets.list": () => ({ budgets: service.listBudgets() }),

    "finance.summary": () => {
      const today = new Date().toISOString().split("T")[0];
      const monthStart = today.slice(0, 7) + "-01";
      return {
        accounts: service.listAccounts(),
        monthTotals: service.totalsByTypeSince(monthStart),
        period: { from: monthStart, to: today },
      };
    },
  });
}
