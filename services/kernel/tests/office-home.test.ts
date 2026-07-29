import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";
import { seedOfficeHome, OFFICE_HOME_WORKSPACE_NAME } from "../src/modules/agents/office-home.js";

describe("office home", () => {
  let db: InstanceType<typeof Database>;
  let service: AgentService;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db, "agents", agentsMigrations);
    service = new AgentService(db, new EventBus());
  });

  afterEach(() => db.close());

  it("migration v36 adds home columns without breaking existing flows", () => {
    // insert a flow the old way (no home columns specified) — defaults apply
    db.prepare(
      "INSERT INTO agent_flows (id, name, description, color, active, created_at, updated_at) VALUES ('f1','Legacy','','#fff',1,'t','t')",
    ).run();
    const row = db.prepare("SELECT home_workspace_id, home_repo_path FROM agent_flows WHERE id = 'f1'").get() as {
      home_workspace_id: string;
      home_repo_path: string;
    };
    expect(row.home_workspace_id).toBe("");
    expect(row.home_repo_path).toBe("");
  });

  it("createFlow auto-creates an office-home workspace and links it", () => {
    const flow = service.createFlow({ name: "Ventas" });
    expect(flow.home_workspace_id).toBeTruthy();

    const ws = db
      .prepare("SELECT * FROM workspaces WHERE id = ?")
      .get(flow.home_workspace_id!) as { owner_flow_id: string; name: string; shared: number };
    expect(ws.owner_flow_id).toBe(flow.id);
    expect(ws.name).toBe(OFFICE_HOME_WORKSPACE_NAME);
    expect(ws.shared).toBe(1);
  });

  it("resolveFlowHome returns the kernel workspace by default", () => {
    const flow = service.createFlow({ name: "Soporte" });
    const home = service.resolveFlowHome(flow.id);
    expect(home).toBeTruthy();
    expect(home!.kind).toBe("workspace");
    expect(home!.path.endsWith(flow.home_workspace_id!)).toBe(true);
  });

  it("resolveFlowHome returns the git repo once promoted", () => {
    const flow = service.createFlow({ name: "Repo Office" });
    service.setFlowRepo(flow.id, "/home/user/projects/repo-office");
    const home = service.resolveFlowHome(flow.id);
    expect(home!.kind).toBe("git");
    expect(home!.path).toBe("/home/user/projects/repo-office");
  });

  it("setFlowRepo with empty path reverts to the workspace home", () => {
    const flow = service.createFlow({ name: "Flip" });
    service.setFlowRepo(flow.id, "/abs/path");
    expect(service.resolveFlowHome(flow.id)!.kind).toBe("git");
    service.setFlowRepo(flow.id, "");
    expect(service.resolveFlowHome(flow.id)!.kind).toBe("workspace");
  });

  it("ensureOfficeHome backfills a flow that has no home (idempotent)", () => {
    db.prepare(
      "INSERT INTO agent_flows (id, name, description, color, active, created_at, updated_at) VALUES ('f2','Old Office','','#fff',1,'t','t')",
    ).run();

    const wsId = service.ensureOfficeHome("f2");
    expect(wsId).toBeTruthy();

    // idempotent — second call returns the same id, no duplicate workspace row
    const again = service.ensureOfficeHome("f2");
    expect(again).toBe(wsId);
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM workspaces WHERE owner_flow_id = 'f2' AND deleted_at IS NULL")
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("seedOfficeHome creates the folder convention and never overwrites", () => {
    const dir = mkdtempSync(join(tmpdir(), "office-home-"));
    try {
      seedOfficeHome(dir, { name: "Demo", description: "una oficina demo" });
      expect(existsSync(join(dir, "CHARTER.md"))).toBe(true);
      expect(existsSync(join(dir, "MEMORY.md"))).toBe(true);
      expect(existsSync(join(dir, "decisions", ".gitkeep"))).toBe(true);
      expect(existsSync(join(dir, "docs", ".gitkeep"))).toBe(true);

      // user edits CHARTER → re-seeding must not clobber it
      writeFileSync(join(dir, "CHARTER.md"), "EDITED", "utf8");
      seedOfficeHome(dir, { name: "Demo", description: "una oficina demo" });
      expect(readFileSync(join(dir, "CHARTER.md"), "utf8")).toBe("EDITED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
