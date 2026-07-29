export type BillingCycle = "weekly" | "monthly" | "quarterly" | "yearly";
export type SubscriptionStatus = "active" | "paused" | "cancelled";

export interface Subscription {
  id: string;
  name: string;
  provider: string;
  amount_cents: number;
  currency: string;
  billing_cycle: BillingCycle;
  category: string;
  status: SubscriptionStatus;
  start_date: string;
  next_billing: string;
  url: string;
  notes: string;
  created_at: string;
  updated_at: string;
}
