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
});
