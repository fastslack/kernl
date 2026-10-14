// tests/office-kit-panels.test.ts
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { panelsMigrations } from "../src/modules/panels/migrations.js";
import { officeDefinitionFromJson, materializeOffice } from "../src/modules/agents/office-kit.js";
import { PanelStore } from "../src/modules/panels/store.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";

const panels = {
  version: 1,
  sources: { events: { type: "collection", name: "events" } },
  views: [{ id: "flujo", title: "Flujo", component: "timeline", data: "events:$", time: "updated_at", text: "{{text}}" }],
  actions: { ronda: { type: "run", label: "Ronda", agent: "vigia", goal: "Ronda." } },
};

function setup() {
  const db = new Database(":memory:");
  runMigrations(db, "agents", agentsMigrations);
  runMigrations(db, "panels", panelsMigrations);
  return db;
}

describe("Office Kit panels", () => {
  it("parses and stores a valid panels block", () => {
    const db = setup();
    const def = officeDefinitionFromJson({ name: "Prueba", agents: [{ slug: "vigia", name: "Vigía", prompt: "x" }], panels });
    const report = materializeOffice(db, new AgentService(db, new EventBus()), def, {});
    expect(report.warnings.filter((w) => w.startsWith("panels"))).toEqual([]);
    expect(new PanelStore(db).getSpec(report.flowId)?.spec.views[0].id).toBe("flujo");
  });

  it("refuses a block that points at an agent outside the office, and stores nothing", () => {
    const db = setup();
    const bad = { ...panels, actions: { ronda: { type: "run", label: "R", agent: "ghost", goal: "x" } } };
    const def = officeDefinitionFromJson({ name: "Prueba2", agents: [{ slug: "vigia", name: "Vigía", prompt: "x" }], panels: bad });
    const report = materializeOffice(db, new AgentService(db, new EventBus()), def, {});
    expect(report.warnings.join(" ")).toContain('agent "ghost" is not in this office');
    expect(new PanelStore(db).getSpec(report.flowId)).toBeNull();
  });
});

describe("extension office panels", () => {
  it("stores the panels of an extension office once its agents are installed", async () => {
    const { AgentsFacade } = await import("../src/modules/agents/extension-facade.js");
    const db = setup();
    const facade = new AgentsFacade(db);
    await facade.installOfficeFromPayload({ slug: "demo-office", name: "Demo" });
    await facade.installAgentFromPayload({ slug: "vigia", name: "Vigía", flow_slug: "demo-office", system_prompt: "x" });
    await facade.installOfficePanelsFromPayload({ slug: "demo-office", name: "Demo", panels });
    expect(new PanelStore(db).getSpec("demo-office")?.spec.views[0].id).toBe("flujo");
  });

  it("skips a spec that names an agent the extension did not install", async () => {
    const { AgentsFacade } = await import("../src/modules/agents/extension-facade.js");
    const db = setup();
    const facade = new AgentsFacade(db);
    await facade.installOfficeFromPayload({ slug: "demo2", name: "Demo2" });
    await facade.installOfficePanelsFromPayload({ slug: "demo2", name: "Demo2", panels });
    expect(new PanelStore(db).getSpec("demo2")).toBeNull();
  });
});

describe("panels lifecycle", () => {
  it("drops the stored spec when the office is re-applied without panels or with an invalid one", () => {
    const db = setup();
    const svc = new AgentService(db, new EventBus());
    const agents = [{ slug: "vigia", name: "Vigía", prompt: "x" }];
    const r = materializeOffice(db, svc, officeDefinitionFromJson({ name: "Ciclo", agents, panels }), {});
    expect(new PanelStore(db).getSpec(r.flowId)).not.toBeNull();
    materializeOffice(db, svc, officeDefinitionFromJson({ name: "Ciclo", agents }), {});
    expect(new PanelStore(db).getSpec(r.flowId)).toBeNull();
    materializeOffice(db, svc, officeDefinitionFromJson({ name: "Ciclo", agents, panels }), {});
    const bad = { ...panels, actions: { ronda: { type: "run", label: "R", agent: "ghost", goal: "x" } } };
    materializeOffice(db, svc, officeDefinitionFromJson({ name: "Ciclo", agents, panels: bad }), {});
    expect(new PanelStore(db).getSpec(r.flowId)).toBeNull();
  });

  it("removes an office's spec and records when the office is deleted", () => {
    const db = setup();
    const svc = new AgentService(db, new EventBus());
    const r = materializeOffice(db, svc, officeDefinitionFromJson({ name: "Borrar", agents: [{ slug: "vigia", name: "Vigía", prompt: "x" }], panels }), {});
    const store = new PanelStore(db);
    store.putRecord(r.flowId, "events", "k", { text: "x" }, "agent");
    svc.deleteFlow(r.flowId);
    expect(store.getSpec(r.flowId)).toBeNull();
    expect(store.listRecords(r.flowId, "events")).toEqual([]);
  });
});

describe("extension office panels lifecycle", () => {
  it("drops a previous spec when a reinstall ships no panels", async () => {
    const { AgentsFacade } = await import("../src/modules/agents/extension-facade.js");
    const db = setup();
    const facade = new AgentsFacade(db);
    await facade.installOfficeFromPayload({ slug: "demo3", name: "Demo3" });
    await facade.installAgentFromPayload({ slug: "vigia", name: "Vigía", flow_slug: "demo3", system_prompt: "x" });
    await facade.installOfficePanelsFromPayload({ slug: "demo3", name: "Demo3", panels });
    await facade.installOfficePanelsFromPayload({ slug: "demo3", name: "Demo3" });
    expect(new PanelStore(db).getSpec("demo3")).toBeNull();
  });
});
