import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { AgentExecutor } from "../src/modules/agents/executor.js";
import { agentsTools } from "../src/modules/agents/tools.js";
import { EventBus } from "../src/core/event-bus.js";
import type { ToolDefinition } from "../src/core/types.js";

// The Agent Factory's deterministic barrier: kernel_agents_factory_finalize.
// The meta-agent does research + synthesis; this tool must reliably validate
// tools, resolve the office, block duplicates, and create an INACTIVE draft.

const FAKE_CATALOG: ToolDefinition[] = [
  { name: "kernel_finance_summary", description: "", inputSchema: {} as never, handler: async () => ({ content: [] }) },
  { name: "kernel_webintel_search", description: "", inputSchema: {} as never, handler: async () => ({ content: [] }) },
  { name: "kernel_notes_create", description: "", inputSchema: {} as never, handler: async () => ({ content: [] }) },
];

describe("kernel_agents_factory_finalize", () => {
  let db: InstanceType<typeof Database>;
  let service: AgentService;
  let events: EventBus;
  let finalize: ToolDefinition;

  function text(r: Awaited<ReturnType<ToolDefinition["handler"]>>): string {
    return (r as { content: Array<{ text?: string }> }).content[0]?.text ?? "";
  }

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db, "agents", agentsMigrations);
    events = new EventBus();
    service = new AgentService(db, events);

    const executor = new AgentExecutor();
    executor.setKernelTools(FAKE_CATALOG);
    const tools = agentsTools(service, executor, events);
    finalize = tools.find((t) => t.name === "kernel_agents_factory_finalize")!;
    expect(finalize).toBeDefined();
  });

  afterEach(() => db.close());

  it("creates an INACTIVE draft with only verified tools (drops hallucinated)", async () => {
    const res = await finalize.handler({
      name: "Contador Test",
      system_prompt: "Sos un contador experto.",
      description: "Asesor fiscal",
      tool_ids: ["kernel_finance_summary", "kernel_made_up_tool", "kernel_notes_create"],
      flow_name: "Contabilidad",
      brief: "experto en impuestos AR",
    });

    const out = text(res);
    expect(out).toContain("INACTIVE");
    expect(out).toContain("kernel_finance_summary");
    expect(out).toContain("kernel_notes_create");
    // Hallucinated tool is dropped and reported.
    expect(out).toContain("kernel_made_up_tool");
    expect(out).toContain("Dropped");

    const agent = service.listAgents().find((a) => a.name === "Contador Test")!;
    expect(agent).toBeDefined();
    expect(agent.active).toBe(0); // draft, pending review
    const granted = JSON.parse(agent.allowed_tools) as string[];
    expect(granted).toEqual(["kernel_finance_summary", "kernel_notes_create"]);
    expect(granted).not.toContain("kernel_made_up_tool");
  });

  it("creates the target office when it does not exist, reuses it otherwise", async () => {
    await finalize.handler({
      name: "Agente A",
      system_prompt: "p",
      flow_name: "Nueva Oficina",
      tool_ids: ["kernel_notes_create"],
    });
    const flows1 = service.listFlows().filter((f) => f.name === "Nueva Oficina");
    expect(flows1.length).toBe(1);

    await finalize.handler({
      name: "Agente B",
      system_prompt: "p",
      flow_name: "nueva oficina", // case-insensitive → reuse
      tool_ids: ["kernel_notes_create"],
    });
    const flows2 = service.listFlows().filter((f) => f.name.toLowerCase() === "nueva oficina");
    expect(flows2.length).toBe(1); // not duplicated

    const a = service.listAgents().find((x) => x.name === "Agente A")!;
    const b = service.listAgents().find((x) => x.name === "Agente B")!;
    expect(a.flow_id).toBe(b.flow_id); // both in the same office
  });

  it("blocks a duplicate name in the same office", async () => {
    await finalize.handler({
      name: "Dup Agent",
      system_prompt: "p",
      flow_name: "OfficeX",
      tool_ids: ["kernel_notes_create"],
    });
    const res = await finalize.handler({
      name: "  dup   agent ", // normalized collision
      system_prompt: "p",
      flow_name: "OfficeX",
      tool_ids: ["kernel_notes_create"],
    });
    expect(text(res).toLowerCase()).toContain("already exists");
    // Only one agent created.
    expect(service.listAgents().filter((a) => a.flow_id === service.listFlows().find((f) => f.name === "OfficeX")!.id).length).toBe(1);
  });

  it("stores the brief on the agent for provenance", async () => {
    await finalize.handler({
      name: "Brief Agent",
      system_prompt: "p",
      flow_name: "OfficeY",
      tool_ids: [],
      brief: "dominio: logística inversa",
    });
    const agent = service.listAgents().find((a) => a.name === "Brief Agent")!;
    const vars = JSON.parse(agent.variables) as Record<string, string>;
    expect(vars.__factory_brief).toBe("dominio: logística inversa");
  });

  it("rejects empty name or system_prompt", async () => {
    expect(text(await finalize.handler({ name: "", system_prompt: "p" }))).toContain("name is required");
    expect(text(await finalize.handler({ name: "X", system_prompt: "" }))).toContain("system_prompt is required");
  });
});
