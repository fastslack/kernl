import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { AgentsFacade } from "../src/modules/agents/extension-facade.js";
import { EventBus } from "../src/core/event-bus.js";

describe("AgentsFacade — offices from extensions", () => {
  let db: InstanceType<typeof Database>;
  let service: AgentService;
  let facade: AgentsFacade;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db, "agents", agentsMigrations);
    service = new AgentService(db, new EventBus());
    facade = new AgentsFacade(db);
  });
  afterEach(() => db.close());

  const flowRow = (id: string) =>
    db.prepare("SELECT active, kind, source_extension_id FROM agent_flows WHERE id = ?").get(id) as {
      active: number; kind: string; source_extension_id: string;
    };

  it("stores kind and the extension id when installing an office", async () => {
    await facade.installOfficeFromPayload({ slug: "devops-office", name: "DevOps Office", kind: "devops", __extension_id: "ext-devops" });
    expect(flowRow("devops-office")).toEqual({ active: 1, kind: "devops", source_extension_id: "ext-devops" });
  });

  it("falls back to general for a missing or unknown kind", async () => {
    await facade.installOfficeFromPayload({ slug: "career-office", name: "Career Office", kind: "castle", __extension_id: "ext-career" });
    expect(flowRow("career-office").kind).toBe("general");
  });

  it("uninstall deactivates the office and parks the agents that did not come from the extension", async () => {
    await facade.installOfficeFromPayload({ slug: "career-office", name: "Career Office", __extension_id: "ext-career" });
    const scout = service.createAgent({ name: "Scout", flow_id: "career-office" });
    db.prepare("UPDATE agents SET source_extension_id = ? WHERE id = ?").run("ext-career", scout.id);
    const mine = service.createAgent({ name: "Mine", flow_id: "career-office" });

    await facade.uninstallBySource("ext-career");

    expect(service.getAgent(scout.id)).toBeFalsy();
    expect(service.getAgent(mine.id)!.flow_id).toBe("");
    expect(service.getAgent(mine.id)!.active).toBe(0);
    expect(flowRow("career-office").active).toBe(0);
  });

  it("uninstall leaves offices of other extensions alone", async () => {
    await facade.installOfficeFromPayload({ slug: "a-office", name: "A", __extension_id: "ext-a" });
    await facade.installOfficeFromPayload({ slug: "b-office", name: "B", __extension_id: "ext-b" });
    await facade.uninstallBySource("ext-a");
    expect(flowRow("b-office").active).toBe(1);
  });

  it("uninstall is atomic: a failure mid-loop leaves nothing applied", async () => {
    await facade.installOfficeFromPayload({ slug: "a-office", name: "A", __extension_id: "ext-a" });
    const mine = service.createAgent({ name: "Mine", flow_id: "a-office" });
    db.prepare("UPDATE agents SET source_extension_id = ? WHERE id = ?").run("ext-a", mine.id);
    const foreign = service.createAgent({ name: "Foreign", flow_id: "a-office" });

    // Force a real SQLite failure partway through the office UPDATE so the
    // transaction wrapper has something genuine to roll back.
    db.run(
      `CREATE TRIGGER trg_boom BEFORE UPDATE ON agent_flows
       WHEN NEW.id = 'a-office'
       BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    );

    await expect(facade.uninstallBySource("ext-a")).rejects.toThrow();

    // Nothing from the transaction was applied: the ext-a agent survives,
    // the foreign agent keeps its office, and the office stays active.
    expect(service.getAgent(mine.id)).toBeTruthy();
    expect(service.getAgent(foreign.id)!.flow_id).toBe("a-office");
    expect(service.getAgent(foreign.id)!.active).toBe(1);
    expect(flowRow("a-office").active).toBe(1);
  });
});
