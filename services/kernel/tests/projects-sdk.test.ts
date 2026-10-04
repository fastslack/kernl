import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as sdk from "../src/sdk/index.js";
import { useProjects } from "../src/core/host-runtime.js";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { projectsMigrations } from "../src/modules/projects/migrations.js";
import { ProjectsService } from "../src/modules/projects/projects-service.js";
import { OutboxService } from "../src/modules/projects/outbox-service.js";
import { projectsHostFor } from "../src/modules/projects/sdk-host.js";
import { EventBus } from "../src/core/event-bus.js";
import { AgentService } from "../src/modules/agents/service.js";
import { materializeOffice, officeDefinitionFromJson } from "../src/modules/agents/office-kit.js";

describe("SDK projects surface", () => {
  afterEach(() => useProjects(() => null));

  it("exports the facades", () => {
    expect(typeof sdk.registerOutboxChannel).toBe("function");
    expect(typeof sdk.projects.get).toBe("function");
    expect(typeof sdk.outbox.propose).toBe("function");
  });

  it("says so when the projects module is not running", () => {
    useProjects(() => null);
    expect(() => sdk.projects.list()).toThrow(/not installed|not running/);
  });

  it("reaches the live projects module through the host", () => {
    const db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    runMigrations(db, "projects", projectsMigrations);
    const root = mkdtempSync(join(tmpdir(), "sdk-"));
    const events = new EventBus();
    const svc = new ProjectsService(db, events, { encryptionKey: "a".repeat(64), projectsRoot: root });
    const outbox = new OutboxService(db, events, svc, () => {});
    useProjects(() => projectsHostFor(svc, outbox, () => []));
    const p = svc.create({ slug: "heural", name: "Heural", brief: { value_prop: "v", audience: "a" } });
    svc.link(p.id, "email_account", "mail:1");
    expect(sdk.projects.get("heural")?.id).toBe(p.id);
    sdk.registerOutboxChannel("email", {
      validate: () => ({ ok: true }), preview: () => ({ title: "", body: "" }), send: async () => ({ ref: "x" }),
    });
    const item = sdk.outbox.propose({ project_id: p.id, flow_id: "F", channel: "email", account_ref: "mail:1", payload: { to: "a@b.c" } });
    expect(item.status).toBe("draft");
    expect(outbox.hasChannel("email")).toBe(true);
    db.close(); rmSync(root, { recursive: true, force: true });
  });

  it("an office stores the JSON schema of its per-project settings", () => {
    const db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    runMigrations(db, "projects", projectsMigrations);
    const root = mkdtempSync(join(tmpdir(), "sdk-"));
    const svc = new ProjectsService(db, new EventBus(), { encryptionKey: "a".repeat(64), projectsRoot: root });
    svc.setOfficeSettingsSchema("F1", { type: "object", properties: { countries: { type: "array" } } });
    expect(svc.getOfficeSettingsSchema("F1")).toEqual({ type: "object", properties: { countries: { type: "array" } } });
    expect(svc.getOfficeSettingsSchema("F2")).toBeNull();
    db.close(); rmSync(root, { recursive: true, force: true });
  });

  it("office.json project_settings_schema lands in the office's schema", () => {
    const db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    runMigrations(db, "projects", projectsMigrations);
    const root = mkdtempSync(join(tmpdir(), "sdk-"));
    const svc = new ProjectsService(db, new EventBus(), { encryptionKey: "a".repeat(64), projectsRoot: root });
    const agents = new AgentService(db, new EventBus());
    const schema = { type: "object", properties: { countries: { type: "array", items: { type: "string" } } } };
    materializeOffice(db, agents, officeDefinitionFromJson({
      name: "Ventas", project_settings_schema: schema,
      agents: [{ slug: "closer", name: "Closer", role: "manager", prompt: "x" }],
    }));
    const flow = agents.listFlows().find((f) => f.name === "Ventas")!;
    expect(svc.getOfficeSettingsSchema(flow.id)).toEqual(schema);
    db.close(); rmSync(root, { recursive: true, force: true });
  });
});
