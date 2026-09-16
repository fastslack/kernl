/**
 * Conflict shapes Plan 2 depends on for "mode: create" against an existing
 * office name — both surfaces that expose Office Kit's `OfficeExistsError`.
 *
 * HTTP: follows the real-server pattern from
 * tests/agent-skill-suggestions-route.test.ts — stand up a real
 * KernelHttpServer with registerAgentRoutes (which registers
 * POST /api/offices/create).
 *
 * RPC: builds `agentsRpcActions({ service })` directly against a real
 * AgentService on an in-memory DB and invokes the "offices.create" handler.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { AgentExecutor } from "../src/modules/agents/executor.js";
import { EventBus } from "../src/core/event-bus.js";
import { registerAgentRoutes } from "../src/modules/agents/api-routes.js";
import { agentsRpcActions } from "../src/modules/agents/rpc-actions.js";
import { KernelHttpServer } from "../src/core/http-server.js";
import type { KernelConfig } from "../src/core/config.js";

describe("POST /api/offices/create — mode 'create' name conflict", () => {
  let db: InstanceType<typeof Database>;
  let service: AgentService;
  let server: KernelHttpServer;
  let base: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db, "agents", agentsMigrations);
    service = new AgentService(db, new EventBus());
    const executor = new AgentExecutor();

    const cfg = {
      dashboard: { port: 0, bind: "127.0.0.1" },
      auth: { token: "" },
      cors: { allowedOrigins: [] },
    } as unknown as KernelConfig;
    server = new KernelHttpServer({ config: cfg });
    registerAgentRoutes(server, service, executor);

    const started = await server.start();
    expect(started).toBe(true);
    const addr = server.nodeServer!.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await server.stop();
    db.close();
  });

  it("returns 409 { error: 'office_exists', message, office_id } when the name is already taken", async () => {
    const createBody = {
      name: "Research",
      agents: [{ name: "Curator", role: "manager", prompt: "p" }],
    };
    const first = await fetch(`${base}/api/offices/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createBody),
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { report: { flowId: string } };
    const officeId = firstBody.report.flowId;

    const second = await fetch(`${base}/api/offices/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...createBody, mode: "create" }),
    });
    expect(second.status).toBe(409);
    const secondBody = await second.json() as { error: string; message: string; office_id: string };
    expect(secondBody.error).toBe("office_exists");
    expect(typeof secondBody.message).toBe("string");
    expect(secondBody.message.length).toBeGreaterThan(0);
    expect(secondBody.office_id).toBe(officeId);
  });
});

describe("offices.create RPC action — mode 'create' name conflict", () => {
  let db: InstanceType<typeof Database>;
  let service: AgentService;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db, "agents", agentsMigrations);
    service = new AgentService(db, new EventBus());
  });

  afterEach(() => db.close());

  function findAction(name: string) {
    const actions = agentsRpcActions({ service });
    const action = actions.find((a) => a.name === name);
    if (!action) throw new Error(`no rpc action named ${name}`);
    return action;
  }

  it("throws an Error whose message is 'office_exists:<id>'", async () => {
    const createAction = findAction("offices.create");
    const createArgs = { name: "Research", agents: [{ name: "Curator", role: "manager", prompt: "p" }] };
    const firstResult = await createAction.handler(createArgs) as { report: { flowId: string } };
    const officeId = firstResult.report.flowId;

    await expect(createAction.handler({ ...createArgs, mode: "create" })).rejects.toThrow(
      `office_exists:${officeId}`,
    );
  });
});
