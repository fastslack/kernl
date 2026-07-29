export type AccountType = "checking" | "savings" | "credit" | "cash" | "investment";
export type TransactionType = "income" | "expense" | "transfer";
export type BudgetPeriod = "weekly" | "monthly" | "quarterly" | "yearly";

export interface FinanceAccount {
  id: string;
  name: string;
  type: AccountType;
  currency: string;
  balance_cents: number;
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface FinanceTransaction {
  id: string;
  account_id: string;
  type: TransactionType;
  amount_cents: number;
  category: string;
  description: string;
  counterparty: string;
  date: string;
  transfer_to: string | null;
  notes: string;
  created_at: string;
}

export interface FinanceBudget {
  id: string;
  name: string;
  category: string;
  amount_cents: number;
  period: BudgetPeriod;
  created_at: string;
  updated_at: string;
}
