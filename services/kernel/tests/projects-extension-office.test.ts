import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { projectsMigrations } from "../src/modules/projects/migrations.js";
import { ProjectsService } from "../src/modules/projects/projects-service.js";
import { AgentsFacade, setOfficeSchedulesChangedHook } from "../src/modules/agents/extension-facade.js";
import { EventBus } from "../src/core/event-bus.js";

describe("extension-seeded offices and projects", () => {
  let db: InstanceType<typeof Database>; let facade: AgentsFacade; let projects: ProjectsService; let root: string;
  const clones = () => (db.prepare(
    "SELECT project_id, cron_expression FROM agent_schedules WHERE per_project = 1 AND project_id IS NOT NULL ORDER BY project_id",
  ).all() as Array<{ project_id: string; cron_expression: string }>);

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    runMigrations(db, "projects", projectsMigrations);
    root = mkdtempSync(join(tmpdir(), "ext-"));
    projects = new ProjectsService(db, new EventBus(), { encryptionKey: "a".repeat(64), projectsRoot: root });
    facade = new AgentsFacade(db);
    setOfficeSchedulesChangedHook((flowId) => projects.syncOfficeSchedules(flowId));
  });
  afterEach(() => { setOfficeSchedulesChangedHook(null); db.close(); rmSync(root, { recursive: true, force: true }); });

  it("stores the office's project_settings_schema", async () => {
    const schema = { type: "object", properties: { countries: { type: "array" } } };
    await facade.installOfficeFromPayload({ slug: "sales-office", name: "Ventas", project_settings_schema: schema });
    expect(projects.getOfficeSettingsSchema("sales-office")).toEqual(schema);
  });

  it("a per_project agent schedule becomes a template cloned per project, and a reinstall re-syncs the clones", async () => {
    await facade.installOfficeFromPayload({ slug: "sales-office", name: "Ventas" });
    const h = projects.create({ slug: "heural", name: "Heural", brief: { value_prop: "v", audience: "a" } }).id;
    projects.assignOffice("sales-office", h);
    await facade.installAgentFromPayload({
      slug: "closer", name: "Closer", flow_slug: "sales-office", system_prompt: "x",
      schedules: [{ cron_expression: "0 9 * * *", goal_override: "work the pipeline", per_project: true }],
    });
    expect(db.prepare("SELECT per_project, project_id FROM agent_schedules WHERE project_id IS NULL").all())
      .toEqual([{ per_project: 1, project_id: null }]);
    expect(clones()).toEqual([{ project_id: h, cron_expression: "0 9 * * *" }]);

    await facade.installAgentFromPayload({
      slug: "closer", name: "Closer", flow_slug: "sales-office", system_prompt: "x",
      schedules: [{ cron_expression: "0 10 * * *", goal_override: "work the pipeline", per_project: true }],
    });
    expect(clones()).toEqual([{ project_id: h, cron_expression: "0 10 * * *" }]);
  });
});
