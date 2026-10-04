/**
 * The dashboard reaches every agent operation through rpcOrCall: WS RPC when
 * the bridge is up, the HTTP route otherwise. The two used to be separate
 * implementations and answered differently for the same request. They are
 * one function now (operations.ts); these tests pin the places they had
 * drifted apart, driven through both roads.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { AgentExecutor } from "../src/modules/agents/executor.js";
import { EventBus } from "../src/core/event-bus.js";
import { agentsRpcActions } from "../src/modules/agents/rpc-actions.js";
import { registerAgentRoutes } from "../src/modules/agents/api-routes.js";
import { KernelHttpServer } from "../src/core/http-server.js";
import type { KernelConfig } from "../src/core/config.js";
import { pickArgs } from "../src/sdk/args.js";

describe("pickArgs", () => {
  it("keeps each declared key only when it has the declared kind", () => {
    expect(pickArgs(
      { a: "x", b: 2, c: true, d: ["s"], e: { k: 1 }, f: "extra" },
      { a: "string", b: "number", c: "boolean", d: "string[]", e: "object" },
    )).toEqual({ a: "x", b: 2, c: true, d: ["s"], e: { k: 1 } });
    expect(pickArgs(
      { a: 1, b: "nope", c: "true", d: ["s", 1], e: [1] },
      { a: "string", b: "number", c: "boolean", d: "string[]", e: "object" },
    )).toEqual({});
  });

  it("reads a numeric string as a number (query strings carry nothing else)", () => {
    expect(pickArgs({ limit: "20", bad: "" }, { limit: "number", bad: "number" })).toEqual({ limit: 20 });
  });
});

describe("agent operations answer alike over RPC and HTTP", () => {
  let db: InstanceType<typeof Database>;
  let service: AgentService;
  let server: KernelHttpServer;
  let base = "";
  let rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>;

  beforeEach(async () => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db, "agents", agentsMigrations);
    const events = new EventBus();
    service = new AgentService(db, events);
    // A stub engine: these tests are about what the operation writes, not the LLM loop.
    const executor = {
      execute: async () => ({ status: "completed", result: "", steps_count: 0, tokens_used: 0 }),
      cancelRun: () => false,
    } as unknown as AgentExecutor;
    const actions = agentsRpcActions({ service, events, executor });
    rpc = (name, args) => actions.find((a) => a.name === name)!.handler(args);

    server = new KernelHttpServer({
      config: { dashboard: { port: 0, bind: "127.0.0.1" }, auth: { token: "" }, cors: { allowedOrigins: [] } } as unknown as KernelConfig,
    });
    registerAgentRoutes(server, service, new AgentExecutor(), events);
    expect(await server.start()).toBe(true);
    const addr = server.nodeServer!.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterEach(async () => {
    await server.stop();
    db.close();
  });

  const http = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });

  it("update writes wake_on_inbox over RPC too (the RPC list used to drop it)", async () => {
    const a = service.createAgent({ name: "A" });
    await rpc("agents.update", { id: a.id, wake_on_inbox: true });
    expect(service.getAgent(a.id)?.wake_on_inbox).toBe(1);
    const b = service.createAgent({ name: "B" });
    expect((await http("PUT", `/api/agents/${b.id}`, { wake_on_inbox: true })).status).toBe(200);
    expect(service.getAgent(b.id)?.wake_on_inbox).toBe(1);
  });

  it("create takes max_tokens and an inline schedule on both roads", async () => {
    const viaRpc = await rpc("agents.create", { name: "R", max_tokens: 777, schedule: { cron_expression: "0 9 * * *" } }) as { agent_id: string };
    const res = await http("POST", "/api/agents", { name: "H", max_tokens: 777, schedule: { cron_expression: "0 9 * * *" } });
    const viaHttp = await res.json() as { agent_id: string };
    for (const id of [viaRpc.agent_id, viaHttp.agent_id]) {
      expect(service.getAgent(id)?.max_tokens).toBe(777);
      expect(service.listSchedules(id)).toHaveLength(1);
    }
  });

  it("detail returns the same shape", async () => {
    const a = service.createAgent({ name: "A" });
    const viaRpc = await rpc("agents.detail", { id: a.id });
    const viaHttp = await (await http("GET", `/api/agents/${a.id}`)).json();
    expect(Object.keys(viaRpc as object).sort()).toEqual(Object.keys(viaHttp as object).sort());
  });

  it("a missing agent is the same error: 404 over HTTP, the message over RPC", async () => {
    const res = await http("DELETE", "/api/agents/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Agent not found" });
    await expect(rpc("agents.delete", { id: "nope" })).rejects.toThrow("Agent not found");
  });

  it("run over RPC resolves the goal template instead of passing {{event.*}} through", async () => {
    const a = service.createAgent({ name: "A", goal_template: "Check {{event.message}} now" });
    const out = await rpc("agents.run", { agent_id: a.id }) as { run_id: string };
    expect(service.getRun(out.run_id)?.goal).toBe("Check  now");
  });
});
