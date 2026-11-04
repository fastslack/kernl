import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { projectsMigrations } from "../src/modules/projects/migrations.js";
import { ProjectsService, normalizeWebsite } from "../src/modules/projects/projects-service.js";
import { EventBus } from "../src/core/event-bus.js";

describe("project websites", () => {
  it("normalizes what a person types into one https URL", () => {
    expect(normalizeWebsite("Ejemplo.com")).toBe("https://ejemplo.com");
    expect(normalizeWebsite(" https://www.Ejemplo.com/ ")).toBe("https://www.ejemplo.com");
    expect(normalizeWebsite("http://ejemplo.com/blog/")).toBe("http://ejemplo.com/blog");
    expect(() => normalizeWebsite("no es un sitio")).toThrow();
    expect(() => normalizeWebsite("ftp://ejemplo.com")).toThrow();
  });

  it("a website is a project link of its own kind", () => {
    const db = new Database(":memory:");
    runMigrations(db as never, "agents", agentsMigrations);
    runMigrations(db as never, "projects", projectsMigrations);
    const svc = new ProjectsService(db as never, new EventBus(), { encryptionKey: "a".repeat(64), projectsRoot: mkdtempSync(join(tmpdir(), "pw-")) });
    const p = svc.create({ slug: "demo", name: "Demo", brief: { value_prop: "x", audience: "y" } });
    svc.link(p.id, "website", "demo.com/");
    svc.link(p.id, "website", "https://demo.com");
    expect(svc.links(p.id, "website").map((l) => l.ref_id)).toEqual(["https://demo.com"]);
  });

  it("the sites typed into Growth's settings become the project's websites once", () => {
    const db = new Database(":memory:");
    runMigrations(db as never, "agents", agentsMigrations);
    runMigrations(db as never, "projects", projectsMigrations.filter((m) => m.version < 12));
    db.exec("INSERT INTO projects (id, slug, name, status, brief, created_at, updated_at) VALUES ('P1','p1','P1','active','{}','x','x'), ('P2','p2','P2','active','{}','x','x')");
    db.exec(`INSERT INTO office_projects (flow_id, project_id, active, settings, created_at, updated_at) VALUES
      ('growth-office','P1',1,'{"sites":["https://a.com/"," https://b.com ",""]}','x','x'), ('other','P1',1,'{"sites":["https://c.com"]}','x','x'),
      ('growth-office','P2',1,'{"sites":"[\\"https://d.com/\\"]"}','x','x')`);
    runMigrations(db as never, "projects", projectsMigrations);
    const rows = db.prepare("SELECT ref_id FROM project_links WHERE kind='website' ORDER BY ref_id").all() as Array<{ ref_id: string }>;
    expect(rows.map((r) => r.ref_id)).toEqual(["https://a.com", "https://b.com", "https://d.com"]);
  });
});
