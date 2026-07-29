import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { seedAgentRanks } from "../src/modules/agents/ranks-seeder.js";
import { EventBus } from "../src/core/event-bus.js";

// The default hierarchy is a neutral corporate ladder — no themed or
// Spanish rank names anywhere. There is no rename migration: the seeder is
// the single source of truth, so a fresh install is correct on first boot.

const RANKS: Array<{ name: string; level: number; description: string }> = [
  { name: "Trainee", level: 1, description: "Entry level — newly onboarded" },
  { name: "Junior Associate", level: 2, description: "Junior team member with initial responsibilities" },
  { name: "Associate", level: 3, description: "Team member leading a small group" },
  { name: "Senior Associate", level: 4, description: "Most senior individual-contributor level" },
  { name: "Specialist", level: 5, description: "First management-track level" },
  { name: "Senior Specialist", level: 6, description: "Senior specialist" },
  { name: "Team Lead", level: 7, description: "Leads a team" },
  { name: "Manager", level: 8, description: "Manages a group — second in command" },
  { name: "Senior Manager", level: 9, description: "Manages a group or department" },
  { name: "Director", level: 10, description: "Senior leadership" },
  { name: "Chief", level: 11, description: "Top of the organization" },
];

describe("default rank hierarchy (fresh install)", () => {
  let db: InstanceType<typeof Database>;
  let service: AgentService;
  let events: EventBus;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db, "agents", agentsMigrations);
    events = new EventBus();
    service = new AgentService(db, events);
  });

  afterEach(() => db.close());

  it("seeds 11 neutral rank names via seedAgentRanks", () => {
    seedAgentRanks(db, service);
    const ranks = service.listRanks();
    expect(ranks).toHaveLength(11);
    expect(ranks.map((r) => r.name).sort()).toEqual(RANKS.map((r) => r.name).sort());
  });

  it("seeds the correct level/description pair for every rank", () => {
    seedAgentRanks(db, service);
    const ranks = service.listRanks();
    for (const expected of RANKS) {
      const found = ranks.find((r) => r.level === expected.level);
      expect(found).toBeDefined();
      expect(found!.name).toBe(expected.name);
      expect(found!.description).toBe(expected.description);
    }
  });

  it("auto-assigns unranked agents using the neutral rank names", () => {
    seedAgentRanks(db, service);
    const scriptAgent = service.createAgent({ name: "Script Agent", builtin_handler: "some_handler" });
    const managerAgent = service.createAgent({ name: "Manager Agent", role: "manager", show_on_dashboard: true });
    seedAgentRanks(db, service);

    const junior = service.listRanks().find((r) => r.name === "Junior Associate");
    const seniorManager = service.listRanks().find((r) => r.name === "Senior Manager");

    expect(service.getAgent(scriptAgent.id)!.rank_id).toBe(junior!.id);
    expect(service.getAgent(managerAgent.id)!.rank_id).toBe(seniorManager!.id);
  });
});
