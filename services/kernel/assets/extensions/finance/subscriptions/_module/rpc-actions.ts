import type { RpcAction } from "../../../../../src/core/mtw/rpc-handler.js";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { SubscriptionService } from "./service.js";
import { autoCategorize, knownCategories, categoryGroup, CATEGORY_GROUPS } from "./categorize.js";

export function subscriptionsRpcActions(db: SqliteDb): RpcAction[] {
  const service = new SubscriptionService(db, null as any);
  function require(): SubscriptionService {
    return service;
  }

  return [
    {
      name: "subscriptions.list",
      handler: async (args) => {
        const svc = require();
        const status = typeof args.status === "string" ? (args.status as any) : undefined;
        const category = typeof args.category === "string" ? args.category : undefined;
        const subs = svc.list({ status, category });
        // Enrich with group info
        const enriched = subs.map(s => ({ ...s, group: categoryGroup(s.category || "other") }));
        return { subscriptions: enriched };
      },
    },
    {
      name: "subscriptions.create",
      handler: async (args) => {
        const svc = require();
        const name = typeof args.name === "string" ? args.name : "";
        if (!name.trim()) throw new Error("name is required");
        const amount = typeof args.amount_cents === "number" ? args.amount_cents : 0;
        if (amount <= 0) throw new Error("amount_cents must be > 0");
        const provider = typeof args.provider === "string" ? args.provider : "";
        // Auto-categorize if no category provided
        const category = (typeof args.category === "string" && args.category)
          ? args.category
          : autoCategorize(name, provider);
        const sub = svc.create({
          name,
          provider,
          amount_cents: amount,
          currency: typeof args.currency === "string" ? args.currency : undefined,
          billing_cycle: typeof args.billing_cycle === "string" ? args.billing_cycle as any : undefined,
          category,
          start_date: typeof args.start_date === "string" ? args.start_date : new Date().toISOString().slice(0, 10),
          next_billing: typeof args.next_billing === "string" ? args.next_billing : undefined,
          url: typeof args.url === "string" ? args.url : undefined,
          notes: typeof args.notes === "string" ? args.notes : undefined,
        });
        return { success: true, subscription: { ...sub, group: categoryGroup(sub.category || "other") } };
      },
    },
    {
      name: "subscriptions.update",
      handler: async (args) => {
        const svc = require();
        const id = typeof args.id === "string" ? args.id : "";
        if (!id) throw new Error("id required");
        const changes: any = {};
        if (typeof args.name === "string") changes.name = args.name;
        if (typeof args.provider === "string") changes.provider = args.provider;
        if (typeof args.amount_cents === "number") changes.amount_cents = args.amount_cents;
        if (typeof args.currency === "string") changes.currency = args.currency;
        if (typeof args.billing_cycle === "string") changes.billing_cycle = args.billing_cycle;
        if (typeof args.category === "string") changes.category = args.category;
        if (typeof args.next_billing === "string") changes.next_billing = args.next_billing;
        if (typeof args.url === "string") changes.url = args.url;
        if (typeof args.notes === "string") changes.notes = args.notes;
        const sub = svc.update(id, changes);
        if (!sub) throw new Error("Subscription not found");
        return { success: true, subscription: { ...sub, group: categoryGroup(sub.category || "other") } };
      },
    },
    {
      name: "subscriptions.cancel",
      handler: async (args) => {
        const svc = require();
        const id = typeof args.id === "string" ? args.id : "";
        const sub = svc.cancel(id);
        if (!sub) throw new Error("Subscription not found");
        return { success: true, subscription: sub };
      },
    },
    {
      name: "subscriptions.pause",
      handler: async (args) => {
        const svc = require();
        const id = typeof args.id === "string" ? args.id : "";
        const sub = svc.pause(id);
        if (!sub) throw new Error("Subscription not found");
        return { success: true, subscription: sub };
      },
    },
    {
      name: "subscriptions.resume",
      handler: async (args) => {
        const svc = require();
        const id = typeof args.id === "string" ? args.id : "";
        const sub = svc.resume(id);
        if (!sub) throw new Error("Subscription not paused or not found");
        return { success: true, subscription: sub };
      },
    },
    {
      name: "subscriptions.summary",
      handler: async () => {
        const svc = require();
        const summary = svc.summary();
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
    },
    {
      name: "subscriptions.upcoming",
      handler: async (args) => {
        const svc = require();
        const days = typeof args.days === "number" ? args.days : 30;
        return { upcoming: svc.upcoming(days) };
      },
    },
    {
      name: "subscriptions.categories",
      handler: async () => {
        return { categories: knownCategories(), groups: CATEGORY_GROUPS };
      },
    },
    {
      name: "subscriptions.suggest_category",
      handler: async (args) => {
        const name = typeof args.name === "string" ? args.name : "";
        const provider = typeof args.provider === "string" ? args.provider : "";
        return { category: autoCategorize(name, provider), group: categoryGroup(autoCategorize(name, provider)) };
      },
    },
  ];
}
