/**
 * A workspace tool acts for the caller's office, and the office comes from
 * who the caller is: the `__caller_agent_id` the native executor injects, or
 * the caller the MCP request carries (CLI agents, via X-Caller-* headers).
 * An explicit `flow_id` argument used to win over both, so any agent could
 * reach another office's private workspaces by naming it.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { runWithContext } from "../src/core/request-context.js";
import { WorkspaceService } from "../assets/extensions/agents/agent-advanced/_module/workspace-service.js";
import { workspaceTools } from "../assets/extensions/agents/agent-advanced/_module/workspace-tools.js";

describe("workspace tools resolve the office from the caller's identity", () => {
  let db: InstanceType<typeof Database>;
  let listWorkspaces: (args: Record<string, unknown>) => Promise<string>;
  let alice = "";
  let bobFlow = "";

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    const agents = new AgentService(db, new EventBus());
    const ws = new WorkspaceService(db);
    const aliceFlow = agents.createFlow({ name: "Alice office" }).id;
    bobFlow = agents.createFlow({ name: "Bob office" }).id;
    alice = agents.createAgent({ name: "Alice", flow_id: aliceFlow }).id;
    ws.create({ owner_flow_id: aliceFlow, name: "alice-notes" });
    ws.create({ owner_flow_id: bobFlow, name: "bob-secrets" });

    const tool = workspaceTools(agents, ws).find((t) => t.name === "kernel_workspace_list_workspaces")!;
    listWorkspaces = async (args) => (await tool.handler(args)).content[0].text;
  });
  afterEach(() => db.close());

  it("uses the injected caller id", async () => {
    const out = await listWorkspaces({ __caller_agent_id: alice });
    expect(out).toContain("alice-notes");
    expect(out).not.toContain("bob-secrets");
  });

  it("ignores a flow_id argument naming another office", async () => {
    const out = await listWorkspaces({ __caller_agent_id: alice, flow_id: bobFlow });
    expect(out).toContain("alice-notes");
    expect(out).not.toContain("bob-secrets");
  });

  it("falls back to the caller the MCP request carries", async () => {
    const out = await runWithContext(
      { callerAgentId: alice, callerRunId: "", callerDepth: 0 },
      () => listWorkspaces({}),
    );
    expect(out).toContain("alice-notes");
  });

  it("has no office without a caller, whatever flow_id says", async () => {
    expect(await listWorkspaces({ flow_id: bobFlow })).toContain("not assigned to an office");
  });
});
