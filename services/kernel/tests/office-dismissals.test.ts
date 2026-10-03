import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";

// The chief's office rebuilds its report list from agent_runs on every load,
// so a report the operator dismissed came straight back. The decision lives
// here now, keyed by run id.
describe("office dismissals", () => {
  let service: AgentService;
  beforeEach(() => {
    const db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    service = new AgentService(db, new EventBus());
  });

  it("remembers dismissed runs", () => {
    expect(service.listOfficeDismissed()).toEqual([]);
    expect(service.dismissOfficeRuns(["r1", "r2"])).toBe(2);
    expect(service.listOfficeDismissed().sort()).toEqual(["r1", "r2"]);
  });

  it("is idempotent and ignores empty ids", () => {
    service.dismissOfficeRuns(["r1"]);
    expect(service.dismissOfficeRuns(["r1", "", "r3"])).toBe(1);
    expect(service.listOfficeDismissed().sort()).toEqual(["r1", "r3"]);
  });

  it("can bring a run back", () => {
    service.dismissOfficeRuns(["r1", "r2"]);
    expect(service.restoreOfficeRuns(["r1"])).toBe(1);
    expect(service.listOfficeDismissed()).toEqual(["r2"]);
  });
});

describe("getInboxMessage", () => {
  it("returns one office message whole, by id", () => {
    const db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    const service = new AgentService(db, new EventBus());
    const a = service.createAgent({ name: "Career Lead" });
    const b = service.createAgent({ name: "Chief" });
    const body = "Perfil y filtros cerrados. ".repeat(20);
    const res = service.postToColleague({ from_agent_id: a.id, to_agent_id: b.id, subject: "Perfil", body });
    const got = service.getInboxMessage(res.message!.id);
    expect(got).toMatchObject({ id: res.message!.id, from_agent_id: a.id, to_agent_id: b.id, subject: "Perfil", body });
    expect(service.getInboxMessage("nope")).toBeNull();
  });
});
