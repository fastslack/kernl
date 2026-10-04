import { HttpError, pickArgs, rpcActionsFrom, type RpcAction, localDate } from "@kernl/extension-sdk";
import type { SubscriptionService } from "./service.js";
import type { BillingCycle, SubscriptionStatus } from "./types.js";
import { autoCategorize, knownCategories, categoryGroup, CATEGORY_GROUPS } from "./categorize.js";

/** What the dashboard may set on a subscription, create and update alike. */
const SUBSCRIPTION_FIELDS = {
  name: "string",
  provider: "string",
  amount_cents: "number",
  currency: "string",
  billing_cycle: "string",
  category: "string",
  next_billing: "string",
  url: "string",
  notes: "string",
} as const;

/**
 * RPC-only (the page's HTTP fallbacks are placeholders, not routes), all of
 * it through the module's SubscriptionService.
 */
export function subscriptionsRpcActions(service: SubscriptionService): RpcAction[] {
  const withGroup = <T extends { category: string }>(sub: T) => ({ ...sub, group: categoryGroup(sub.category || "other") });
  const requireAmount = (amount: number | undefined): void => {
    if (amount !== undefined && !Number.isInteger(amount)) throw new HttpError(400, "amount_cents must be an integer");
  };
  const byId = (input: Record<string, unknown>) => pickArgs(input, { id: "string" }).id ?? "";

  return rpcActionsFrom({
    "subscriptions.list": (input) => {
      const args = pickArgs(input, { status: "string", category: "string" });
      const subs = service.list({ status: args.status as SubscriptionStatus | undefined, category: args.category });
      // Enrich with group info
      return { subscriptions: subs.map(withGroup) };
    },

    "subscriptions.create": (input) => {
      const args = pickArgs(input, { ...SUBSCRIPTION_FIELDS, start_date: "string" });
      const name = args.name ?? "";
      if (!name.trim()) throw new HttpError(400, "name is required");
      const amount = args.amount_cents ?? 0;
      if (amount <= 0) throw new HttpError(400, "amount_cents must be > 0");
      requireAmount(amount);
      const provider = args.provider ?? "";
      const sub = service.create({
        ...args,
        name,
        provider,
        amount_cents: amount,
        billing_cycle: args.billing_cycle as BillingCycle | undefined,
        // Auto-categorize if no category provided
        category: args.category || autoCategorize(name, provider),
        start_date: args.start_date ?? localDate(),
      });
      return { success: true, subscription: withGroup(sub) };
    },

    "subscriptions.update": (input) => {
      const id = byId(input);
      if (!id) throw new HttpError(400, "id required");
      // Only the keys that were sent: the service spreads these over the row,
      // so an `undefined` would blank a column.
      const changes = pickArgs(input, SUBSCRIPTION_FIELDS) as Parameters<SubscriptionService["update"]>[1];
      requireAmount(changes.amount_cents);
      const sub = service.update(id, changes);
      if (!sub) throw new HttpError(404, "Subscription not found");
      return { success: true, subscription: withGroup(sub) };
    },

    "subscriptions.cancel": (input) => {
      const sub = service.cancel(byId(input));
      if (!sub) throw new HttpError(404, "Subscription not found");
      return { success: true, subscription: sub };
    },

    "subscriptions.pause": (input) => {
      const sub = service.pause(byId(input));
      if (!sub) throw new HttpError(404, "Subscription not found");
      return { success: true, subscription: sub };
    },

    "subscriptions.resume": (input) => {
      const sub = service.resume(byId(input));
      if (!sub) throw new HttpError(404, "Subscription not paused or not found");
      return { success: true, subscription: sub };
    },

    "subscriptions.summary": () => {
      const summary = service.summary();
      // Add group breakdown
      const groupMap = new Map<string, { count: number; monthly_cents: number }>();
      for (const cat of summary.by_category) {
        const g = categoryGroup(cat.category);
        const existing = groupMap.get(g) ?? { count: 0, monthly_cents: 0 };
        existing.count += cat.count;
        existing.monthly_cents += cat.monthly_cents;
        groupMap.set(g, existing);
      }
      const by_group = [...groupMap.entries()]
        .map(([group, data]) => ({ group, ...data }))
        .sort((a, b) => b.monthly_cents - a.monthly_cents);
      return { ...summary, by_group };
    },

    "subscriptions.upcoming": (input) => ({ upcoming: service.upcoming(pickArgs(input, { days: "number" }).days ?? 30) }),

    "subscriptions.categories": () => ({ categories: knownCategories(), groups: CATEGORY_GROUPS }),

    "subscriptions.suggest_category": (input) => {
      const args = pickArgs(input, { name: "string", provider: "string" });
      const category = autoCategorize(args.name ?? "", args.provider ?? "");
      return { category, group: categoryGroup(category) };
    },
  });
}
