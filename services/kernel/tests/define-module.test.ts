/**
 * defineModule replaces the hand-written KernelModule of each extension. The
 * registry reads a present optional hook as "this module contributes one",
 * and asks for some of them before initialize() — so absent parts must stay
 * absent, and state-backed hooks must answer empty until init has run.
 */

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { defineModule, dashboardChannel, notificationChannelModule } from "../src/sdk/module.js";
import type { ModuleContext } from "../src/core/types.js";

const ctxWith = (extra: Partial<ModuleContext> = {}) =>
  ({ sqlite: new Database(":memory:"), ...extra }) as unknown as ModuleContext;

describe("defineModule", () => {
  it("runs migrations, builds state once, and hands it to tools and rpc", async () => {
    let built = 0;
    const mod = defineModule({
      name: "demo",
      migrations: [{ version: 1, sql: "CREATE TABLE demo_items (id TEXT PRIMARY KEY)" }],
      init: (ctx) => { built++; return { db: ctx.sqlite }; },
      tools: (s) => [{ name: "t", description: "", inputSchema: {} as never, handler: async () => ({ content: [] }) }],
      rpc: (s) => [{ name: "demo.list", handler: async () => s.db.prepare("SELECT count(*) AS n FROM demo_items").get() }],
    });
    expect(mod.getRpcActions!()).toEqual([]); // before init
    const ctx = ctxWith();
    await mod.initialize(ctx);
    expect(built).toBe(1);
    expect(mod.getTools().map((t) => t.name)).toEqual(["t"]);
    const [action] = await mod.getRpcActions!();
    expect(await action.handler({})).toEqual({ n: 0 });

    await mod.shutdown();
    expect(mod.getTools()).toEqual([]);
    expect(mod.getRpcActions!()).toEqual([]);
  });

  it("leaves hooks the spec does not provide undefined", () => {
    const mod = defineModule({ name: "bare" });
    expect(mod.getRpcActions).toBeUndefined();
    expect(mod.getDashboardDescriptor).toBeUndefined();
    expect(mod.getAgentDrivers).toBeUndefined();
  });

  it("answers the dashboard descriptor before init", () => {
    const mod = defineModule({ name: "notes", dashboard: dashboardChannel("notes", () => []) });
    expect(mod.getDashboardDescriptor!()).toEqual({
      channels: [{ name: "notes", query: expect.any(Function) }],
      channelMappings: [{ moduleKey: "notes", channels: ["notes"] }],
      stores: ["notes"],
      fetchEndpoints: [{ url: "/api/dashboard/notes", store: "notes" }],
    });
  });

  it("registers a notification provider factory", async () => {
    const registered: string[] = [];
    const notifier = { getRegistry: () => ({ registerFactory: (id: string) => registered.push(id) }) };
    const mod = notificationChannelModule("ext:demo", "demo", () => ({}) as never);
    await mod.initialize(ctxWith({ notifier } as unknown as Partial<ModuleContext>));
    expect(mod.name).toBe("ext:demo");
    expect(registered).toEqual(["demo"]);
    expect(mod.getTools()).toEqual([]);
  });
});
