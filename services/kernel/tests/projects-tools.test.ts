import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { projectsMigrations } from "../src/modules/projects/migrations.js";
import { ProjectsService } from "../src/modules/projects/projects-service.js";
import { OutboxService } from "../src/modules/projects/outbox-service.js";
import { ConnectorService } from "../src/modules/projects/connector-service.js";
import { projectTools } from "../src/modules/projects/tools.js";
import { EventBus } from "../src/core/event-bus.js";

describe("projects MCP tools", () => {
  it("create → assign → link → list, and no tool can approve a draft", async () => {
    const db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    runMigrations(db, "projects", projectsMigrations);
    const root = mkdtempSync(join(tmpdir(), "pt-"));
    const ev = new EventBus();
    const svc = new ProjectsService(db, ev, { encryptionKey: "a".repeat(64), projectsRoot: root });
    const ob = new OutboxService(db, ev, svc, () => {});
    const tools = projectTools(svc, ob, new ConnectorService(db, ev, svc));
    const t = (n: string) => tools.find((x) => x.name === n)!;
    await t("kernel_projects_create").handler({ slug: "heural", name: "Heural", brief: { value_prop: "v", audience: "a" } });
    expect((await t("kernel_projects_create").handler({ slug: "x", name: "x", brief: {} })).isError).toBe(true);
    await t("kernel_projects_assign_office").handler({ project: "heural", flow_id: "F1" });
    await t("kernel_projects_link").handler({ project: "heural", kind: "social_account", ref_id: "twitter:1" });
    expect(JSON.stringify(await t("kernel_projects_list").handler({ flow_id: "F1" }))).toContain("heural");
    expect(JSON.stringify(await t("kernel_projects_get").handler({ project: "heural" }))).toContain("twitter:1");
    expect(tools.some((x) => /approve/.test(x.name))).toBe(false);
    db.close(); rmSync(root, { recursive: true, force: true });
  });
});
