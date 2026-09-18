import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";
import {
  defineOffice,
  materializeOffice,
  officeDefinitionFromJson,
  parseEvery,
  scheduleFloorMs,
  slugify,
  OfficeExistsError,
  type OfficeDefinition,
} from "../src/modules/agents/office-kit.js";

function fixture(): OfficeDefinition {
  return {
    name: "Test Office",
    color: "#16a34a",
    repo: "/tmp/office-kit-test-repo",
    cron: { agent: "test-lead", every: "45m", goal: "resume" },
    agents: [
      {
        slug: "test-lead",
        name: "Test Lead",
        role: "manager",
        prompt: "You are the lead.",
        tools: ["kernel_agents_run"],
        chainTo: ["test-builder", "test-qa"],
      },
      { slug: "test-builder", name: "Test Builder", prompt: "You build.", plugins: ["x/y"] },
      { slug: "test-qa", name: "Test QA", prompt: "You verify." },
    ],
  };
}

describe("office-kit", () => {
  let db: InstanceType<typeof Database>;
  let service: AgentService;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db, "agents", agentsMigrations);
    service = new AgentService(db, new EventBus());
  });

  afterEach(() => db.close());

  it("materializes flow + agents + chains + cron with resolved defaults", () => {
    const report = materializeOffice(db, service, fixture());

    expect(report.created).toEqual(["test-lead", "test-builder", "test-qa"]);
    expect(report.updated).toEqual([]);
    expect(report.chained).toEqual([["test-lead", "test-builder"], ["test-lead", "test-qa"]]);
    expect(report.scheduled?.intervalMs).toBe(45 * 60_000);

    const flow = db.prepare("SELECT * FROM agent_flows WHERE name = 'Test Office' AND active = 1").get() as
      { id: string; color: string };
    expect(flow).toBeTruthy();
    expect(flow.color).toBe("#16a34a");
    expect(report.flowId).toBe(flow.id);

    const lead = service.getAgentBySlug("test-lead")!;
    expect(lead.flow_id).toBe(flow.id);
    expect((lead as unknown as { role: string }).role).toBe("manager");
    expect((lead as unknown as { executor_type: string }).executor_type).toBe("claude_code");
    const vars = JSON.parse(lead.variables) as Record<string, unknown>;
    expect(vars.__cwd_path__).toBe("/tmp/office-kit-test-repo");
    expect(vars.__sandbox__).toBe(false);
    expect(vars.__permission_mode__).toBe("bypassPermissions");
    // discipline preamble auto-prepended
    expect(lead.system_prompt).toContain("You are the lead.");
    expect(lead.system_prompt).toContain("Office discipline");
    // repo office → claude_code model chain default
    expect(lead.model_chain).toContain("claude_code");

    const builderVars = JSON.parse(service.getAgentBySlug("test-builder")!.variables) as Record<string, unknown>;
    expect(builderVars.__plugins__).toEqual(["x/y"]);

    const schedules = service.listSchedules(lead.id);
    expect(schedules.filter((s) => s.active === 1).length).toBe(1);
    expect(schedules[0].goal_override).toBe("resume");
  });

  it("is idempotent: re-run creates nothing new, preserves pauses and operator variables", () => {
    materializeOffice(db, service, fixture());
    const lead = service.getAgentBySlug("test-lead")!;

    // operator pauses the lead and hand-edits a variable
    db.prepare("UPDATE agents SET active = 0 WHERE id = ?").run(lead.id);
    const vars = JSON.parse(lead.variables) as Record<string, unknown>;
    vars.my_custom = "keep-me";
    db.prepare("UPDATE agents SET variables = ? WHERE id = ?").run(JSON.stringify(vars), lead.id);

    const report2 = materializeOffice(db, service, fixture());
    expect(report2.created).toEqual([]);
    expect(report2.updated).toEqual(["test-lead", "test-builder", "test-qa"]);
    expect(report2.chained).toEqual([]); // no duplicate chains
    expect(report2.scheduled).toBeUndefined(); // schedule already active → left alone

    const leadAfter = service.getAgentBySlug("test-lead")!;
    expect(leadAfter.active).toBe(0); // pause survives
    const varsAfter = JSON.parse(leadAfter.variables) as Record<string, unknown>;
    expect(varsAfter.my_custom).toBe("keep-me");
    expect(varsAfter.__cwd_path__).toBe("/tmp/office-kit-test-repo");

    expect(db.prepare("SELECT COUNT(*) c FROM agents WHERE slug LIKE 'test-%'").get()).toEqual({ c: 3 });
    expect(db.prepare("SELECT COUNT(*) c FROM agent_chains").get()).toEqual({ c: 2 });
    expect(db.prepare("SELECT COUNT(*) c FROM agent_flows WHERE name = 'Test Office' AND active = 1").get()).toEqual({ c: 1 });
  });

  it("native office (no repo): native executor, no sandbox vars, empty model chain", () => {
    const def: OfficeDefinition = {
      name: "Research",
      agents: [{ slug: "res-1", name: "Researcher", prompt: "You research." }],
    };
    materializeOffice(db, service, def);
    const a = service.getAgentBySlug("res-1")!;
    expect((a as unknown as { executor_type: string }).executor_type).toBe("native");
    expect(a.model_chain).toBe("");
    const vars = JSON.parse(a.variables) as Record<string, unknown>;
    expect(vars.__cwd_path__).toBeUndefined();
    expect(vars.__sandbox__).toBeUndefined();
  });

  it("parseEvery handles units and clamps below-floor intervals", () => {
    expect(parseEvery("45m")).toBe(2_700_000);
    expect(parseEvery("6h")).toBe(21_600_000);
    expect(parseEvery("90s")).toBe(90_000);
    expect(parseEvery(1_200_000)).toBe(1_200_000);
    expect(() => parseEvery("banana")).toThrow();

    // Pin the floor env — other test files in the suite mutate it.
    const prevFloor = process.env.KERNEL_AGENT_MIN_SCHEDULE_SECONDS;
    process.env.KERNEL_AGENT_MIN_SCHEDULE_SECONDS = "300";
    try {
      const def = fixture();
      def.cron = { agent: "test-lead", every: "1m" }; // below the 300s floor
      const report = materializeOffice(db, service, def);
      expect(report.scheduled?.intervalMs).toBe(scheduleFloorMs());
      expect(report.scheduled?.intervalMs).toBe(300_000);
    } finally {
      if (prevFloor === undefined) delete process.env.KERNEL_AGENT_MIN_SCHEDULE_SECONDS;
      else process.env.KERNEL_AGENT_MIN_SCHEDULE_SECONDS = prevFloor;
    }
  });

  it("defineOffice validates slugs, chains and cron target", () => {
    expect(() => defineOffice({ name: "", agents: [] } as unknown as OfficeDefinition)).toThrow();
    expect(() =>
      defineOffice({
        name: "X",
        agents: [
          { slug: "a", name: "A", prompt: "p" },
          { slug: "a", name: "B", prompt: "p" },
        ],
      }),
    ).toThrow(/duplicate/);
    expect(() =>
      defineOffice({
        name: "X",
        agents: [{ slug: "a", name: "A", prompt: "p", chainTo: ["ghost"] }],
      }),
    ).toThrow(/unknown slug/);
    expect(() =>
      defineOffice({
        name: "X",
        agents: [{ slug: "a", name: "A", prompt: "p" }],
        cron: { agent: "nobody", every: "45m" },
      }),
    ).toThrow(/cron.agent/);
  });

  // Instance-specific fixture: scripts/personal/ is gitignored, so this test
  // only runs on installs that carry the personal office manifest.
  const hasProdeFixture = existsSync(new URL("../scripts/personal/prode.office.ts", import.meta.url));
  it.skipIf(!hasProdeFixture)("prode manifest reproduces the legacy seed shape", async () => {
    // Non-literal specifier so `tsc --noEmit` (lint) doesn't resolve this
    // gitignored fixture at type-check time — the it.skipIf above already guards
    // runtime execution when the file is absent (public repo / CI).
    const prodeFixture: string = "../scripts/personal/prode.office.js";
    const { default: prode } = await import(prodeFixture);
    const report = materializeOffice(db, service, prode);
    expect(report.created).toEqual(["prode-techlead", "prode-builder", "prode-qa"]);
    expect(report.scheduled?.intervalMs).toBe(45 * 60_000);

    const lead = service.getAgentBySlug("prode-techlead")!;
    expect((lead as unknown as { role: string }).role).toBe("manager");
    expect((lead as unknown as { executor_type: string }).executor_type).toBe("claude_code");
    expect(lead.system_prompt).toContain("Office discipline (every agent in the PRODE office)");
    expect(JSON.parse(lead.model_chain)).toEqual([
      { provider: "claude_code", model: "claude-sonnet-4-5" },
      { provider: "grok", model: "grok-4-fast-reasoning" },
    ]);
    const vars = JSON.parse(lead.variables) as Record<string, unknown>;
    expect(String(vars.__cwd_path__)).toContain("prode-mundial-2026");
    expect(vars.__sandbox__).toBe(false);
    expect(vars.__permission_mode__).toBe("bypassPermissions");
    expect(vars.__preview_url__).toBe("http://localhost:4321");

    const builderVars = JSON.parse(service.getAgentBySlug("prode-builder")!.variables) as Record<string, unknown>;
    expect(builderVars.__plugins__).toEqual(["claude-plugins-official/frontend-design"]);

    // techlead → builder, techlead → qa chains
    expect(report.chained).toEqual([
      ["prode-techlead", "prode-builder"],
      ["prode-techlead", "prode-qa"],
    ]);
  });

  it("officeDefinitionFromJson coerces the wizard payload and derives slugs", () => {
    const def = officeDefinitionFromJson({
      name: "Marketing",
      agents: [
        { name: "Lead", role: "manager", prompt: "lead prompt" },
        { name: "Writer", prompt: "writer prompt" },
      ],
      cron: { agent: "marketing-lead", every: "45m" },
    });
    expect(def.agents[0].slug).toBe("marketing-lead");
    expect(def.agents[1].slug).toBe("marketing-writer");
    expect(def.agents[0].role).toBe("manager");
    expect(slugify("Análisis de Datos")).toBe("analisis-de-datos");
  });

  it("mode 'create' refuses a name that already exists, ignoring case", () => {
    materializeOffice(db, service, { name: "Research", agents: [{ slug: "mc-1", name: "R", prompt: "p" }] });
    expect(() =>
      materializeOffice(db, service, { name: "research", agents: [{ slug: "mc-2", name: "R2", prompt: "p" }] }, { mode: "create" }),
    ).toThrow(OfficeExistsError);
  });

  it("mode 'create' renames a colliding agent slug instead of taking over the old agent", () => {
    // Found "Research", then delete it (its agent becomes unassigned + paused
    // by AgentFlowsService.deleteFlow — simulated directly here).
    const first = materializeOffice(db, service, {
      name: "Research",
      agents: [
        { slug: "research-curator", name: "Curator", role: "manager", prompt: "p", chainTo: ["research-writer"] },
        { slug: "research-writer", name: "Writer", prompt: "p2" },
      ],
      cron: { agent: "research-curator", every: "45m" },
    });
    const oldCuratorId = service.getAgentBySlug("research-curator")!.id;
    const oldWriterId = service.getAgentBySlug("research-writer")!.id;
    // Simulate deleting the office: deleteFlow pauses+unassigns the agents
    // and deactivates the flow (agents.slug stays as-is — slugs are global).
    db.prepare("UPDATE agents SET active = 0, flow_id = '' WHERE id IN (?, ?)").run(oldCuratorId, oldWriterId);
    db.prepare("UPDATE agent_flows SET active = 0 WHERE id = ?").run(first.flowId);

    const second = materializeOffice(
      db,
      service,
      {
        name: "Research",
        agents: [
          { slug: "research-curator", name: "Curator", role: "manager", prompt: "p", chainTo: ["research-writer"] },
          { slug: "research-writer", name: "Writer", prompt: "p2" },
        ],
        cron: { agent: "research-curator", every: "45m" },
      },
      { mode: "create" },
    );

    expect(second.flowId).not.toBe(first.flowId);
    expect(second.created).toEqual(["research-curator-2", "research-writer-2"]);
    expect(second.updated).toEqual([]);
    expect(second.warnings).toContain('agent slug "research-curator" already exists — created as "research-curator-2"');
    expect(second.warnings).toContain('agent slug "research-writer" already exists — created as "research-writer-2"');
    expect(second.chained).toEqual([["research-curator-2", "research-writer-2"]]);
    expect(second.scheduled?.agent).toBe("research-curator-2");

    // Old agents are untouched: still the same ids, still unassigned/paused.
    const oldCurator = service.getAgent(oldCuratorId)!;
    expect(oldCurator.active).toBe(0);
    expect(oldCurator.flow_id).toBe("");
    const oldWriter = service.getAgent(oldWriterId)!;
    expect(oldWriter.active).toBe(0);
    expect(oldWriter.flow_id).toBe("");

    // New agents are brand new rows under the new office.
    const newCurator = service.getAgentBySlug("research-curator-2")!;
    expect(newCurator.id).not.toBe(oldCuratorId);
    expect(newCurator.flow_id).toBe(second.flowId);
    expect(newCurator.active).toBe(1);
  });

  it("mode 'create' with no colliding slugs behaves normally, no warnings", () => {
    const r = materializeOffice(
      db,
      service,
      { name: "Fresh Office", agents: [{ slug: "fresh-1", name: "A", prompt: "p" }] },
      { mode: "create" },
    );
    expect(r.created).toEqual(["fresh-1"]);
    expect(r.warnings).toEqual([]);
  });

  it("mode defaults to upsert and reuses the office with that name", () => {
    const a = materializeOffice(db, service, { name: "Same", agents: [{ slug: "up-1", name: "A", prompt: "p" }] });
    const b = materializeOffice(db, service, { name: "Same", agents: [{ slug: "up-1", name: "A", prompt: "p2" }] });
    expect(b.flowId).toBe(a.flowId);
  });

  it("stores kind on a new office and updates it on upsert", () => {
    const r = materializeOffice(db, service, { name: "Ops", kind: "devops", agents: [{ slug: "k-1", name: "A", prompt: "p" }] });
    expect(service.getFlow(r.flowId)!.kind).toBe("devops");
    materializeOffice(db, service, { name: "Ops", kind: "creative", agents: [{ slug: "k-1", name: "A", prompt: "p" }] });
    expect(service.getFlow(r.flowId)!.kind).toBe("creative");
  });

  it("officeDefinitionFromJson resolves chainTo and cron.agent NAMEs to slugs", () => {
    const def = officeDefinitionFromJson({
      name: "Wizard Team",
      agents: [
        { name: "Lead", role: "manager", prompt: "lead prompt", chainTo: ["Writer"] },
        { name: "Writer", prompt: "writer prompt" },
      ],
      cron: { agent: "Lead", every: "45m" },
    });
    const lead = def.agents.find((a) => a.name === "Lead")!;
    const writer = def.agents.find((a) => a.name === "Writer")!;
    expect(lead.chainTo).toEqual([writer.slug]);
    expect(def.cron?.agent).toBe(lead.slug);
  });

  it("officeDefinitionFromJson leaves an already-correct slug in chainTo/cron.agent untouched", () => {
    const def = officeDefinitionFromJson({
      name: "Wizard Team 2",
      agents: [
        { slug: "custom-lead", name: "Lead", role: "manager", prompt: "p", chainTo: ["custom-writer"] },
        { slug: "custom-writer", name: "Writer", prompt: "p2" },
      ],
      cron: { agent: "custom-lead", every: "45m" },
    });
    expect(def.agents[0].chainTo).toEqual(["custom-writer"]);
    expect(def.cron?.agent).toBe("custom-lead");
  });

  it("rejects an unknown kind or isolation from JSON", () => {
    expect(() => officeDefinitionFromJson({ name: "X", kind: "castle", agents: [{ name: "A", prompt: "p" }] })).toThrow(/kind/);
    expect(() => officeDefinitionFromJson({ name: "X", repoIsolation: "yolo", agents: [{ name: "A", prompt: "p" }] })).toThrow(/repoIsolation/);
  });

  it("repoIsolation 'sandbox' leaves the executor's safe defaults in place", () => {
    const r = materializeOffice(db, service, {
      name: "Sandboxed",
      repo: "/tmp/office-kit-test-repo",
      repoIsolation: "sandbox",
      agents: [{ slug: "sb-1", name: "Builder", prompt: "p" }],
    });
    const vars = JSON.parse(service.getAgentBySlug("sb-1")!.variables) as Record<string, unknown>;
    expect(vars.__cwd_path__).toBe("/tmp/office-kit-test-repo");
    expect(vars.__sandbox__).toBeUndefined();
    expect(vars.__permission_mode__).toBeUndefined();
    expect(service.getFlow(r.flowId)!.repo_isolation).toBe("sandbox");
  });

  it("an explicit repoIsolation cannot be overridden by an agent's own variables", () => {
    const r = materializeOffice(db, service, {
      name: "Locked Sandbox",
      repo: "/tmp/office-kit-test-repo",
      repoIsolation: "sandbox",
      agents: [{ slug: "lk-1", name: "Builder", prompt: "p", variables: { __sandbox__: false } }],
    });
    const vars = JSON.parse(service.getAgentBySlug("lk-1")!.variables) as Record<string, unknown>;
    expect(vars.__sandbox__).toBeUndefined();
    expect(service.getFlow(r.flowId)!.repo_isolation).toBe("sandbox");
  });

  it("re-materializing with 'sandbox' removes a previous host posture", () => {
    const def: OfficeDefinition = {
      name: "Flip",
      repo: "/tmp/office-kit-test-repo",
      agents: [{ slug: "flip-1", name: "B", prompt: "p" }],
    };
    const first = materializeOffice(db, service, def);
    expect(service.getFlow(first.flowId)!.repo_isolation).toBe("host");
    materializeOffice(db, service, { ...def, repoIsolation: "sandbox" });
    const vars = JSON.parse(service.getAgentBySlug("flip-1")!.variables) as Record<string, unknown>;
    expect(vars.__sandbox__).toBeUndefined();
    expect(vars.__permission_mode__).toBeUndefined();
  });
});
