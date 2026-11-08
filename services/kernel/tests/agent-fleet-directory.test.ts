/**
 * The fleet directory is re-sent on every turn of every run: the agent's own
 * office keeps full detail, other offices are listed by name, and a name is
 * enough to reach a colleague in another office.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";

describe("fleet directory", () => {
  let service: AgentService;
  let ids: Record<string, string>;

  beforeEach(() => {
    const db = new Database(":memory:");
    runMigrations(db as unknown as never, "agents", agentsMigrations);
    service = new AgentService(db as unknown as never, new EventBus());
    const sales = service.createFlow({ name: "Ventas" });
    const dev = service.createFlow({ name: "Desarrollo" });
    ids = {
      me: service.createAgent({ name: "Prospector", flow_id: sales.id, description: "Busca clientes" }).id,
      mate: service.createAgent({ name: "Cerrador", flow_id: sales.id, description: "Cierra ventas con detalle largo" }).id,
      salesLead: service.createAgent({ name: "Lead", flow_id: sales.id }).id,
      devLead: service.createAgent({ name: "Lead", flow_id: dev.id }).id,
      dev: service.createAgent({ name: "Developer", flow_id: dev.id, description: "Escribe código con un detalle muy largo" }).id,
    };
  });

  it("details the own office and lists other offices by name only", () => {
    const block = service.buildDirectoryBlock(ids.me);
    expect(block).toContain("### Your office: Ventas");
    expect(block).toContain(ids.mate);
    expect(block).toContain("Cierra ventas");
    expect(block).toContain("- Desarrollo: ");
    expect(block).toMatch(/Desarrollo: .*Developer/);
    // "Lead" repeats across offices, so it keeps its ID; "Developer" does not.
    expect(block).toContain(`Lead \`${ids.devLead}\``);
    expect(block).not.toContain(ids.dev);
    expect(block).not.toContain("Escribe código");
    expect(block).not.toContain("**Prospector**");
  });

  it("stays small as the fleet grows", () => {
    const big = service.createFlow({ name: "Grande" });
    for (let i = 0; i < 100; i++) {
      service.createAgent({ name: `Agente ${i}`, flow_id: big.id, description: "x".repeat(120) });
    }
    expect(service.buildDirectoryBlock(ids.me).length).toBeLessThan(4000);
  });

  it("resolves a name that is unique in the fleet, and refuses an ambiguous one", () => {
    expect(service.findAgentByUniqueName("developer")?.id).toBe(ids.dev);
    expect(service.findAgentByUniqueName("Lead")).toBeUndefined();
    expect(service.findAgentByUniqueName("Nadie")).toBeUndefined();
  });
});

describe("keep_full_tool_turns", () => {
  it("defaults to 3 and accepts 0 to never trim", () => {
    const db = new Database(":memory:");
    runMigrations(db as unknown as never, "agents", agentsMigrations);
    const service = new AgentService(db as unknown as never, new EventBus());
    const a = service.createAgent({ name: "Probador" });
    expect(service.getAgent(a.id)!.keep_full_tool_turns).toBe(3);
    service.updateAgent(a.id, { keep_full_tool_turns: 0 });
    expect(service.getAgent(a.id)!.keep_full_tool_turns).toBe(0);
  });
});
