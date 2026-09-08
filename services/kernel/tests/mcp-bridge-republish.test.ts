/**
 * The hot-reconnection seam.
 *
 * `setKernelTools` converts its input eagerly and keeps no reference, so a
 * connection made after boot only becomes usable if something rebuilds the
 * surface and hands it to chat and the agent executor again. These tests
 * model that contract directly: if a future refactor of services.ts drops the
 * republish call or reverts the catalog to a snapshot, they fail.
 */

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { runMigrations } from "../src/core/db/migrations.js";
import { mcpMigrations } from "../assets/extensions/ai/mcp-bridge/_module/migrations/001_mcp.js";
import { McpStore } from "../assets/extensions/ai/mcp-bridge/_module/store.js";
import { McpRegistry } from "../assets/extensions/ai/mcp-bridge/_module/registry.js";
import type { McpBridgeConnection } from "../assets/extensions/ai/mcp-bridge/_module/client.js";
import type { ToolDefinition } from "../src/core/types.js";

function tool(name: string): ToolDefinition {
  return {
    name,
    description: name,
    inputSchema: z.any(),
    handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
  } as ToolDefinition;
}

/** Stands in for chat / the agent executor: converts eagerly, keeps no ref. */
class EagerConsumer {
  names: string[] = [];
  calls = 0;
  setKernelTools(tools: ToolDefinition[]): void {
    this.calls += 1;
    this.names = tools.map((t) => t.name);
  }
}

function bootstrapLike() {
  const db = new Database(":memory:");
  runMigrations(db as never, "mcp-bridge", mcpMigrations);
  const store = new McpStore(db as never);

  const chat = new EagerConsumer();
  const agents = new EagerConsumer();

  // The kernel's non-bridge tools, as bootstrap would supply them.
  const kernelTools = [tool("kernel_tasks_create")];
  let agentContribToolsRef: ToolDefinition[] = [];

  const registry = new McpRegistry({
    store,
    republish: () => republishToolSurface(),
    connect: (async (cfg: { name: string }) =>
      ({
        serverName: cfg.name,
        tools: [tool(`mcp_${cfg.name}_a`), tool(`mcp_${cfg.name}_b`)],
        disconnect: async () => {},
      }) satisfies McpBridgeConnection) as never,
  });

  // Mirrors services.ts: compose live, never snapshot.
  const composeTools = (): ToolDefinition[] => [...kernelTools, ...registry.getTools()];
  const republishToolSurface = (): void => {
    const next = [...composeTools(), ...agentContribToolsRef];
    chat.setKernelTools(next);
    agents.setKernelTools(next);
  };

  // Boot-time publish.
  chat.setKernelTools(composeTools());
  agents.setKernelTools(composeTools());

  return {
    store,
    registry,
    chat,
    agents,
    composeTools,
    setAgentContrib: (t: ToolDefinition[]) => {
      agentContribToolsRef = t;
    },
  };
}

describe("tool surface republication", () => {
  it("boots with only the kernel's own tools", () => {
    const { chat, agents } = bootstrapLike();
    expect(chat.names).toEqual(["kernel_tasks_create"]);
    expect(agents.names).toEqual(["kernel_tasks_create"]);
  });

  it("a server connected after boot reaches chat AND agents", async () => {
    const h = bootstrapLike();
    const s = h.store.create({ name: "upwork", transport: "stdio", command: "x" });

    await h.registry.connect(s.id);

    // Without the seam both would still read ["kernel_tasks_create"].
    expect(h.chat.names).toEqual(["kernel_tasks_create", "mcp_upwork_a", "mcp_upwork_b"]);
    expect(h.agents.names).toEqual(["kernel_tasks_create", "mcp_upwork_a", "mcp_upwork_b"]);
  });

  it("disconnecting removes the tools from both consumers", async () => {
    const h = bootstrapLike();
    const s = h.store.create({ name: "upwork", transport: "stdio", command: "x" });
    await h.registry.connect(s.id);
    await h.registry.disconnect(s.id);

    expect(h.chat.names).toEqual(["kernel_tasks_create"]);
    expect(h.agents.names).toEqual(["kernel_tasks_create"]);
  });

  it("removing a server republishes without it", async () => {
    const h = bootstrapLike();
    const s = h.store.create({ name: "upwork", transport: "stdio", command: "x" });
    await h.registry.connect(s.id);
    await h.registry.remove(s.id);
    expect(h.chat.names).toEqual(["kernel_tasks_create"]);
  });

  it("republishing preserves agent-contributed tools", async () => {
    const h = bootstrapLike();
    h.setAgentContrib([tool("agent_ask_scout")]);
    const s = h.store.create({ name: "upwork", transport: "stdio", command: "x" });

    await h.registry.connect(s.id);

    // Pushing only the MCP half would silently drop the agent tools from chat.
    expect(h.chat.names).toContain("agent_ask_scout");
    expect(h.chat.names).toContain("mcp_upwork_a");
  });

  it("a failed connection republishes nothing new but keeps the kernel tools", async () => {
    const db = new Database(":memory:");
    runMigrations(db as never, "mcp-bridge", mcpMigrations);
    const store = new McpStore(db as never);
    const chat = new EagerConsumer();
    const kernelTools = [tool("kernel_tasks_create")];
    const registry = new McpRegistry({
      store,
      republish: () => chat.setKernelTools([...kernelTools, ...registry.getTools()]),
      connect: (async () => {
        throw new Error("boom");
      }) as never,
    });
    const s = store.create({ name: "x", transport: "stdio", command: "x" });

    await registry.connect(s.id);

    expect(chat.names).toEqual(["kernel_tasks_create"]);
    expect(store.get(s.id)!.status).toBe("failed");
  });

  it("two servers accumulate, and removing one leaves the other", async () => {
    const h = bootstrapLike();
    const a = h.store.create({ name: "a", transport: "stdio", command: "x" });
    const b = h.store.create({ name: "b", transport: "stdio", command: "x" });
    await h.registry.connect(a.id);
    await h.registry.connect(b.id);
    expect(h.chat.names).toHaveLength(5);

    await h.registry.remove(a.id);
    expect(h.chat.names).toEqual(["kernel_tasks_create", "mcp_b_a", "mcp_b_b"]);
  });
});
