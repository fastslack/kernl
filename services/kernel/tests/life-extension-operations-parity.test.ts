/**
 * Finance, subscriptions, health, nutrition, training, shopping and the RSS
 * registry: the dashboard reaches their actions through rpcOrCall (WS RPC when
 * the bridge is up, the HTTP route otherwise). Where an action had both, the
 * two were separate copies, and the RPC side often wrote raw SQL past the
 * service. They are one function over the service now; these tests pin each
 * place the copies had drifted, driven through both roads where both exist.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { EventBus } from "../src/core/event-bus.js";
import { KernelHttpServer } from "../src/core/http-server.js";
import type { KernelConfig } from "../src/core/config.js";
import type { SqliteDb } from "../src/sdk/index.js";

import { financeMigrations } from "../assets/extensions/finance/finance/_module/migrations/001_finance.js";
import { FinanceService } from "../assets/extensions/finance/finance/_module/service.js";
import { financeRpcActions } from "../assets/extensions/finance/finance/_module/rpc-actions.js";
import { subscriptionsMigrations } from "../assets/extensions/finance/subscriptions/_module/migrations/001_subscriptions.js";
import { SubscriptionService } from "../assets/extensions/finance/subscriptions/_module/service.js";
import { subscriptionsRpcActions } from "../assets/extensions/finance/subscriptions/_module/rpc-actions.js";
import { healthMigrations } from "../assets/extensions/health/health/_module/migrations/001_health.js";
import { HealthService } from "../assets/extensions/health/health/_module/service.js";
import { healthRpcActions } from "../assets/extensions/health/health/_module/rpc-actions.js";
import { nutritionMigrations } from "../assets/extensions/health/nutrition/_module/migrations/001_nutrition.js";
import { NutritionService } from "../assets/extensions/health/nutrition/_module/service.js";
import { nutritionRpcActions } from "../assets/extensions/health/nutrition/_module/rpc-actions.js";
import { trainingMigrations } from "../assets/extensions/health/training/_module/migrations/001_training.js";
import { TrainingService } from "../assets/extensions/health/training/_module/service.js";
import { trainingRpcActions } from "../assets/extensions/health/training/_module/rpc-actions.js";
import { registerTrainingRoutes } from "../assets/extensions/health/training/_module/routes.js";
import { shoppingMigrations } from "../assets/extensions/home/shopping/_module/migrations/001_shopping.js";
import { ShoppingService } from "../assets/extensions/home/shopping/_module/service.js";
import { shoppingRpcActions } from "../assets/extensions/home/shopping/_module/rpc-actions.js";
import { registerShoppingRoutes } from "../assets/extensions/home/shopping/_module/routes.js";
import { rssRegistryMigrations } from "../assets/extensions/integration/rss-registry/_module/migrations.js";
import { RssRegistryService } from "../assets/extensions/integration/rss-registry/_module/service.js";
import { rssRegistryRpcActions } from "../assets/extensions/integration/rss-registry/_module/rpc-actions.js";
import { registerRssRegistryRoutes } from "../assets/extensions/integration/rss-registry/_module/api-routes.js";

type Actions = Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<unknown> }>;
type Rpc = (name: string, args?: Record<string, unknown>) => Promise<any>;
const rpcOf = (actions: Actions): Rpc => (name, args = {}) => {
  const action = actions.find((a) => a.name === name);
  if (!action) throw new Error(`no RPC action ${name}`);
  return action.handler(args);
};

let db: InstanceType<typeof Database>;
let sqlite: SqliteDb;
let events: EventBus;
let server: KernelHttpServer;
let base = "";

beforeEach(async () => {
  db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  sqlite = db as unknown as SqliteDb;
  events = new EventBus();
  server = new KernelHttpServer({
    config: { dashboard: { port: 0, bind: "127.0.0.1" }, auth: { token: "" }, cors: { allowedOrigins: [] } } as unknown as KernelConfig,
  });
});
afterEach(async () => {
  await server.stop();
  db.close();
});

async function start(): Promise<void> {
  expect(await server.start()).toBe(true);
  const addr = server.nodeServer!.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
}
const http = (method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });

describe("nutrition RPC goes through NutritionService", () => {
  let service: NutritionService;
  let rpc: Rpc;
  beforeEach(() => {
    runMigrations(sqlite, "nutrition", nutritionMigrations);
    service = new NutritionService(sqlite);
    rpc = rpcOf(nutritionRpcActions(service));
  });

  it("entries.log scales a linked food's macros (the raw INSERT stored zeros)", async () => {
    const food = service.addFood({ name: "Oats", calories_per_100g: 380, protein_per_100g: 13 });
    const out = await rpc("nutrition.entries.log", { food_id: food.id, quantity_g: 50, meal_type: "breakfast" });
    const entry = db.prepare("SELECT * FROM nutrition_entries WHERE id = ?").get(out.id) as Record<string, unknown>;
    expect(entry.food_name).toBe("Oats");
    expect(entry.calories).toBe(190);
    expect(entry.protein_g).toBe(6.5);
  });

  it("entries.log still takes the wellness page's explicit numbers", async () => {
    const out = await rpc("nutrition.entries.log", { food_name: " Toast ", meal_type: "snack", quantity_g: 0, calories: 120, protein_g: 4, carbs_g: 20, fat_g: 2 });
    const entry = db.prepare("SELECT * FROM nutrition_entries WHERE id = ?").get(out.id) as Record<string, unknown>;
    expect(entry).toMatchObject({ food_name: "Toast", calories: 120, quantity_g: 0 });
    await expect(rpc("nutrition.entries.log", {})).rejects.toThrow("food_name required");
  });

  it("foods.search finds a food (the service's FTS query threw on every call)", async () => {
    service.addFood({ name: "Banana" });
    expect(service.searchFoods("Ban").map((f) => f.name)).toEqual(["Banana"]);
    const out = await rpc("nutrition.foods.search", { q: "Banana" });
    expect(out.foods.map((f: { name: string }) => f.name)).toEqual(["Banana"]);
    // FTS syntax it cannot parse falls back to LIKE instead of failing.
    expect(service.searchFoods('"')).toEqual([]);
  });

  it("fasting.start closes the fast still open, as the service does", async () => {
    const first = await rpc("nutrition.fasting.start", { protocol: "16:8" });
    await rpc("nutrition.fasting.start", { protocol: "omad" });
    const row = db.prepare("SELECT status FROM nutrition_fasting WHERE id = ?").get(first.id) as { status: string };
    expect(row.status).toBe("broken");
    expect((await rpc("nutrition.fasting.active")).fast.target_hours).toBe(23);
  });

  it("water.log keeps the date it is given", async () => {
    const out = await rpc("nutrition.water.log", { amount_ml: 250, date: "2026-01-02" });
    expect((db.prepare("SELECT date FROM nutrition_water WHERE id = ?").get(out.id) as { date: string }).date).toBe("2026-01-02");
    await expect(rpc("nutrition.water.log", { amount_ml: -5 })).rejects.toThrow("amount_ml required");
  });

  it("dailySummary keeps its shape", async () => {
    await rpc("nutrition.entries.log", { food_name: "A", calories: 100 });
    await rpc("nutrition.water.log", { amount_ml: 300 });
    const out = await rpc("nutrition.dailySummary");
    expect(out.totals).toMatchObject({ entries: 1, calories: 100 });
    expect(out.water).toEqual({ total_ml: 300 });
    expect(out.goal).toBeNull();
  });
});

describe("health RPC goes through HealthService", () => {
  let rpc: Rpc;
  beforeEach(() => {
    runMigrations(sqlite, "health", healthMigrations);
    rpc = rpcOf(healthRpcActions(new HealthService(sqlite, () => null)));
  });

  it("metrics.log gives an empty unit the type's default and takes the page's string value", async () => {
    const out = await rpc("health.metrics.log", { type: "weight", value: "72.5", unit: "" });
    expect(db.prepare("SELECT value, unit FROM health_metrics WHERE id = ?").get(out.id)).toEqual({ value: "72.5", unit: "kg" });
  });

  it("medications.update reports a missing medication instead of a silent ok", async () => {
    await expect(rpc("health.medications.update", { id: "nope", dosage: "5mg" })).rejects.toThrow("Medication not found");
    const med = await rpc("health.medications.create", { name: "X" });
    await rpc("health.medications.update", { id: med.id, active: false, start_date: "2026-01-01" });
    expect(db.prepare("SELECT active, start_date FROM health_medications WHERE id = ?").get(med.id)).toEqual({ active: 0, start_date: "2026-01-01" });
  });
});

describe("finance RPC goes through FinanceService", () => {
  let rpc: Rpc;
  beforeEach(() => {
    runMigrations(sqlite, "finance", financeMigrations);
    rpc = rpcOf(financeRpcActions(new FinanceService(sqlite, () => null)));
  });

  it("transactions.create refuses an unknown account instead of writing an orphan", async () => {
    await expect(rpc("finance.transactions.create", { account_id: "nope", amount_cents: 500 })).rejects.toThrow("Account not found");
    expect((db.prepare("SELECT COUNT(*) as c FROM finance_transactions").get() as { c: number }).c).toBe(0);
  });

  it("the stored amount and the balance move agree, and money stays integer cents", async () => {
    const acc = await rpc("finance.accounts.create", { name: "Main", balance_cents: 10_000 });
    await rpc("finance.transactions.create", { account_id: acc.id, amount_cents: -2_500, type: "expense" });
    expect((db.prepare("SELECT amount_cents FROM finance_transactions").get() as { amount_cents: number }).amount_cents).toBe(2_500);
    expect((db.prepare("SELECT balance_cents FROM finance_accounts").get() as { balance_cents: number }).balance_cents).toBe(7_500);
    await expect(rpc("finance.transactions.create", { account_id: acc.id, amount_cents: 12.5 })).rejects.toThrow("integer");
    const list = await rpc("finance.transactions.list", { account_id: acc.id });
    expect(list.total).toBe(1);
  });
});

describe("subscriptions RPC", () => {
  it("keeps its validation with pickArgs", async () => {
    runMigrations(sqlite, "subscriptions", subscriptionsMigrations);
    const rpc = rpcOf(subscriptionsRpcActions(new SubscriptionService(sqlite, () => null)));
    await expect(rpc("subscriptions.create", { name: "Netflix", amount_cents: 0 })).rejects.toThrow("amount_cents must be > 0");
    const out = await rpc("subscriptions.create", { name: "Netflix", amount_cents: 1299 });
    expect(out.subscription.category).not.toBe("");
    await expect(rpc("subscriptions.update", { id: "nope", name: "x" })).rejects.toThrow("Subscription not found");
    // An update touches only what it was sent.
    const updated = await rpc("subscriptions.update", { id: out.subscription.id, name: "Netflix HD" });
    expect(updated.subscription).toMatchObject({ name: "Netflix HD", billing_cycle: "monthly", amount_cents: 1299 });
  });
});

describe("training operations answer alike over RPC and HTTP", () => {
  let service: TrainingService;
  let rpc: Rpc;
  beforeEach(async () => {
    runMigrations(sqlite, "training", trainingMigrations);
    service = new TrainingService(sqlite);
    rpc = rpcOf(trainingRpcActions({ service, events }));
    registerTrainingRoutes(server, service, events);
    await start();
  });

  it("registers the RPC name the page derives from each route (they used to fall through to HTTP)", async () => {
    const names = trainingRpcActions({ service, events }).map((a) => a.name);
    for (const n of ["training.exercises", "training.startWorkout", "training.logSet", "training.finishWorkout", "training.logCardio", "training.deleteWorkout", "training.programs"]) {
      expect(names).toContain(n);
    }
    // Older names are kept.
    for (const n of ["training.sets.log", "training.workouts.start", "training.cardio.log", "training.weeklySummary"]) expect(names).toContain(n);
  });

  it("a set logged under the old RPC name gets PR detection (the raw INSERT skipped it)", async () => {
    const w = await rpc("training.workouts.start", {});
    const out = await rpc("training.sets.log", { workout_id: w.id, exercise_name: "Squat", reps: 5, weight_kg: 100 });
    expect(out.setNumber).toBe(1);
    expect((db.prepare("SELECT is_pr FROM training_sets WHERE id = ?").get(out.id) as { is_pr: number }).is_pr).toBe(1);
    expect((db.prepare("SELECT COUNT(*) as c FROM training_prs").get() as { c: number }).c).toBe(1);
  });

  it("log-set answers the same set shape by both roads", async () => {
    const w = service.startWorkout({ name: "W" });
    const viaRpc = await rpc("training.logSet", { workout_id: w.id, exercise_name: "Row", reps: 8 });
    const viaHttp = await (await http("POST", "/api/training/log-set", { workout_id: w.id, exercise_name: "Row", reps: 8 })).json() as Record<string, unknown>;
    expect(Object.keys(viaRpc).sort()).toEqual(Object.keys(viaHttp).sort());
    expect(viaHttp.set_number).toBe(2);
  });

  it("cardio needs a duration on both roads (the column is NOT NULL)", async () => {
    await expect(rpc("training.cardio.log", { sport: "running" })).rejects.toThrow("sport and duration_minutes required");
    expect((await http("POST", "/api/training/log-cardio", { sport: "running" })).status).toBe(400);
    const out = await rpc("training.cardio.log", { sport: "running", duration_minutes: 30, distance_m: 5000 });
    expect((db.prepare("SELECT avg_pace_min_km FROM training_cardio WHERE id = ?").get(out.id) as { avg_pace_min_km: number }).avg_pace_min_km).toBe(6);
  });

  it("a missing workout is the same error: 404 over HTTP, the message over RPC", async () => {
    const res = await http("POST", "/api/training/delete-workout", { workout_id: "nope" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Workout not found" });
    await expect(rpc("training.deleteWorkout", { workout_id: "nope" })).rejects.toThrow("Workout not found");
    const w = service.startWorkout({ name: "W" });
    service.logSet({ workout_id: w.id, exercise_name: "Row", reps: 5 });
    expect(await rpc("training.deleteWorkout", { workout_id: w.id })).toEqual({ ok: true, deleted: w.id });
    expect((db.prepare("SELECT COUNT(*) as c FROM training_sets").get() as { c: number }).c).toBe(0);
  });
});

describe("shopping operations answer alike over RPC and HTTP", () => {
  let service: ShoppingService;
  let rpc: Rpc;
  beforeEach(async () => {
    runMigrations(sqlite, "shopping", shoppingMigrations);
    service = new ShoppingService(sqlite, () => null);
    rpc = rpcOf(shoppingRpcActions({ service, events }));
    registerShoppingRoutes(server, service, events);
    await start();
  });

  it("checking the last item completes the list over RPC too (only HTTP did)", async () => {
    const list = service.createList({ name: "L" });
    const item = service.addListItem({ list_id: list.id, name: "Milk" })!;
    await rpc("shopping.items.check", { id: item.id, checked: true });
    expect(service.getListWithItems(list.id)!.list.status).toBe("completed");

    const list2 = service.createList({ name: "L2" });
    const item2 = service.addListItem({ list_id: list2.id, name: "Eggs" })!;
    expect((await http("POST", "/api/shopping/check-item", { id: item2.id, checked: true })).status).toBe(200);
    expect(service.getListWithItems(list2.id)!.list.status).toBe("completed");
  });

  it("add-item over HTTP links a product and an unknown list is a 404", async () => {
    const list = service.createList({ name: "L" });
    const product = service.createProduct({ name: "Coffee", unit: "kg" });
    const res = await http("POST", "/api/shopping/add-item", { list_id: list.id, product_id: product.id });
    expect(res.status).toBe(200);
    const [item] = service.getListWithItems(list.id)!.items;
    expect(item).toMatchObject({ name: "Coffee", unit: "kg", product_id: product.id });
    expect((await http("POST", "/api/shopping/add-item", { list_id: "nope", name: "x" })).status).toBe(404);
    await expect(rpc("shopping.items.add", { list_id: "nope", name: "x" })).rejects.toThrow("List not found");
  });

  it("removeShoppingItem's DELETE ?id= fallback reaches the operation", async () => {
    const list = service.createList({ name: "L" });
    const item = service.addListItem({ list_id: list.id, name: "Milk" })!;
    expect((await http("DELETE", `/api/shopping/remove-item?id=${item.id}`)).status).toBe(200);
    expect(service.getListWithItems(list.id)!.items).toHaveLength(0);
  });

  it("create-list without a name is the same 400 by both roads", async () => {
    const res = await http("POST", "/api/shopping/create-list", {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Name required" });
    await expect(rpc("shopping.lists.create", {})).rejects.toThrow("Name required");
  });

  it("the RPC-only actions go through the service", async () => {
    const product = service.createProduct({ name: "Rice", min_stock: 2, current_stock: 2 });
    // Low stock is strictly below the minimum, as everywhere else.
    expect((await rpc("shopping.products.lowStock")).products).toHaveLength(0);
    const out = await rpc("shopping.purchases.log", { product_id: product.id, quantity: 2, total_price: 3 });
    expect(db.prepare("SELECT unit_price, total_price FROM purchases WHERE id = ?").get(out.id)).toEqual({ unit_price: 1.5, total_price: 3 });
    expect(service.getProduct(product.id)!.current_stock).toBe(4);
    await expect(rpc("shopping.purchases.log", { product_id: "nope" })).rejects.toThrow("Product not found");
    const lists = (await rpc("shopping.lists.list")).lists;
    expect(lists).toEqual([]);
  });
});

describe("rss-registry operations answer alike over RPC and HTTP", () => {
  let service: RssRegistryService;
  let rpc: Rpc;
  beforeEach(async () => {
    runMigrations(sqlite, "rss-registry", rssRegistryMigrations);
    service = new RssRegistryService(sqlite, events);
    rpc = rpcOf(rssRegistryRpcActions(service));
    registerRssRegistryRoutes(server, service);
    await start();
  });

  it("toggle without a status flips the feed over RPC too (it always set active)", async () => {
    const feed = service.addFeed({ name: "F", feed_url: "https://example.com/rss" });
    const out = await rpc("registry.rss.toggle", { id: feed.id });
    expect(out.feed.status).toBe("disabled");
    const res = await http("POST", `/api/registry/rss/${feed.id}/toggle`);
    expect(((await res.json()) as { feed: { status: string } }).feed.status).toBe("active");
    expect((await rpc("registry.rss.toggle", { id: feed.id, status: "active" })).feed.status).toBe("active");
  });

  it("a missing feed fails on both roads (RPC used to resolve { ok: false })", async () => {
    expect((await http("DELETE", "/api/registry/rss/nope")).status).toBe(404);
    await expect(rpc("registry.rss.delete", { id: "nope" })).rejects.toThrow("Feed not found");
    await expect(rpc("registry.rss.itemGet", { id: "nope" })).rejects.toThrow("Item not found");
  });

  it("items answer the same shape by both roads", async () => {
    const viaRpc = await rpc("registry.rss.items", { q: "x" });
    const viaHttp = await (await http("GET", "/api/registry/rss/items?q=x&limit=5")).json();
    expect(Object.keys(viaRpc).sort()).toEqual(Object.keys(viaHttp as object).sort());
  });

  it("adding a feed needs a name and a url by both roads", async () => {
    expect((await http("POST", "/api/registry/rss", { name: "F" })).status).toBe(400);
    await expect(rpc("registry.rss.add", { name: "F" })).rejects.toThrow("name and feed_url are required");
    const out = await rpc("registry.rss.add", { name: "F", feed_url: "https://example.com/rss", tags: ["a", "b"] });
    expect(out.feed.tags).toBe("a,b");
  });
});
