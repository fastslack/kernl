import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { projectsMigrations } from "../src/modules/projects/migrations.js";
import { ProjectsService } from "../src/modules/projects/projects-service.js";
import { AgentService } from "../src/modules/agents/service.js";
import { EventBus } from "../src/core/event-bus.js";

const KEY = "a".repeat(64);
const BRIEF = { value_prop: "EHR para clínicas", audience: "clínicas AR" };

describe("ProjectsService", () => {
  let db: InstanceType<typeof Database>;
  let svc: ProjectsService;
  let agents: AgentService;
  let root: string;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    runMigrations(db, "projects", projectsMigrations);
    const events = new EventBus();
    root = mkdtempSync(join(tmpdir(), "proj-"));
    svc = new ProjectsService(db, events, { encryptionKey: KEY, projectsRoot: root });
    agents = new AgentService(db, events);
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  it("creates a project and finds it by id or slug", () => {
    const p = svc.create({ slug: "heural", name: "Heural", brief: BRIEF });
    expect(svc.get(p.id)?.slug).toBe("heural");
    expect(svc.get("heural")?.id).toBe(p.id);
    expect(p.status).toBe("active");
  });

  it("rejects a bad slug and a brief without value_prop", () => {
    expect(() => svc.create({ slug: "Heural Pro", name: "x", brief: BRIEF })).toThrow(/slug/);
    expect(() => svc.create({ slug: "x", name: "x", brief: { audience: "a" } as never })).toThrow(/value_prop/);
  });

  it("seeds the project home once and never overwrites", () => {
    const p = svc.create({ slug: "heural", name: "Heural", brief: BRIEF });
    const dir = svc.homeDir(p);
    expect(readFileSync(join(dir, "BRIEF.md"), "utf8")).toContain("EHR para clínicas");
    expect(existsSync(join(dir, "MEMORY.md"))).toBe(true);
    expect(existsSync(join(dir, "assets"))).toBe(true);
  });

  it("assigns a project to an office N:M with settings", () => {
    const p = svc.create({ slug: "heural", name: "Heural", brief: BRIEF });
    const q = svc.create({ slug: "kernl", name: "Kernl", brief: BRIEF });
    const flow = agents.createFlow({ name: "Ventas" });
    svc.assignOffice(flow.id, p.id, { settings: { countries: ["AR"] } });
    svc.assignOffice(flow.id, q.id);
    expect(svc.officeProjects(flow.id).map((o) => o.project.slug).sort()).toEqual(["heural", "kernl"]);
    expect(svc.officeSettings(flow.id, p.id)).toEqual({ countries: ["AR"] });
    expect(svc.list({ flowId: flow.id }).length).toBe(2);
  });

  it("links existing resources without duplicates", () => {
    const p = svc.create({ slug: "heural", name: "Heural", brief: BRIEF });
    svc.link(p.id, "social_account", "twitter:123");
    svc.link(p.id, "social_account", "twitter:123");
    expect(svc.links(p.id, "social_account").length).toBe(1);
    svc.unlink(p.id, "social_account", "twitter:123");
    expect(svc.links(p.id).length).toBe(0);
  });

  it("keeps the connector token encrypted and hands it back decrypted", () => {
    const p = svc.create({ slug: "heural", name: "Heural", brief: BRIEF });
    svc.setConnector(p.id, { url: "https://x.test/kernl/v1", token: "tok" });
    const raw = db.prepare("SELECT connector_token, webhook_secret FROM projects WHERE id = ?").get(p.id) as { connector_token: string; webhook_secret: string };
    expect(raw.connector_token).not.toBe("tok");
    expect(svc.connectorSecrets(p.id).token).toBe("tok");
    expect(svc.connectorSecrets(p.id).webhookSecret.length).toBeGreaterThan(20);
    expect(svc.get(p.id)!.has_connector_token).toBe(true);
  });
});
