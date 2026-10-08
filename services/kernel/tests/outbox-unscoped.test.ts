import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "../src/core/db/migrations.js";
import { agentsMigrations } from "../src/modules/agents/migrations.js";
import { projectsMigrations } from "../src/modules/projects/migrations.js";
import { ProjectsService } from "../src/modules/projects/projects-service.js";
import { OutboxService } from "../src/modules/projects/outbox-service.js";
import { EventBus } from "../src/core/event-bus.js";
import { outboxTools } from "../src/modules/projects/tools.js";
import { runWithContext } from "../src/core/request-context.js";

describe("outbox drafts without a project", () => {
  let db: InstanceType<typeof Database>; let outbox: OutboxService; let root: string; let projectId: string;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    runMigrations(db, "projects", projectsMigrations);
    const events = new EventBus();
    root = mkdtempSync(join(tmpdir(), "obu-"));
    const projects = new ProjectsService(db, events, { encryptionKey: "a".repeat(64), projectsRoot: root });
    projectId = projects.create({ slug: "heural", name: "Heural", brief: { value_prop: "v", audience: "a" } }).id;
    outbox = new OutboxService(db, events, projects, () => {});
    outbox.registerChannel("social_post", {
      validate: (p) => ((p as { content?: unknown }).content ? { ok: true } : { ok: false, error: "content required" }),
      preview: () => ({ title: "t", body: "b" }),
      send: async () => ({ ref: "x" }),
    });
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  it("accepts a draft with no project and lists it", () => {
    const item = outbox.propose({ project_id: null, flow_id: "", agent_id: "a1", run_id: "r1", channel: "social_post", account_ref: "social:self", payload: { content: "hola" } });
    expect(item.project_id).toBeNull();
    expect(outbox.list().map((i) => i.id)).toContain(item.id);
    expect(outbox.pendingCount()).toBe(1);
  });

  it("still validates the channel payload without a project", () => {
    expect(() => outbox.propose({ project_id: null, flow_id: "", agent_id: "", run_id: "", channel: "social_post", account_ref: "social:self", payload: {} })).toThrow("content required");
    expect(() => outbox.propose({ project_id: null, flow_id: "", agent_id: "", run_id: "", channel: "nope", account_ref: "social:self", payload: {} })).toThrow(/channel/);
  });

  it("still checks the account link when there is a project", () => {
    expect(() => outbox.propose({ project_id: projectId, flow_id: "", agent_id: "", run_id: "", channel: "social_post", account_ref: "not-linked", payload: { content: "x" } })).toThrow("not linked");
  });

  it("migration v8 keeps existing rows", () => {
    const d = new Database(":memory:");
    runMigrations(d, "agents", agentsMigrations);
    runMigrations(d, "projects", projectsMigrations.filter((m) => m.version <= 7));
    const now = new Date().toISOString();
    d.prepare("INSERT INTO projects (id, slug, name, created_at, updated_at) VALUES ('p1','s','S',?,?)").run(now, now);
    d.prepare(
      "INSERT INTO outbox_items (id, project_id, channel, account_ref, status, created_at, updated_at) VALUES ('o1','p1','c','a','sent',?,?)",
    ).run(now, now);
    runMigrations(d, "projects", projectsMigrations);
    expect(d.prepare("SELECT id, status, project_id FROM outbox_items").all()).toEqual([{ id: "o1", status: "sent", project_id: "p1" }]);
    d.prepare("INSERT INTO outbox_items (id, project_id, channel, account_ref, created_at, updated_at) VALUES ('o2', NULL,'c','a',?,?)").run(now, now);
    expect(d.prepare("SELECT COUNT(*) AS c FROM outbox_items").get()).toEqual({ c: 2 });
    d.close();
  });

  it("kernel_outbox_propose drafts without a project from any run, and from a human", async () => {
    const tool = outboxTools(outbox, () => ({ project_id: null, agent_id: "a" }), () => "")
      .find((t) => t.name === "kernel_outbox_propose")!;
    const args = { channel: "social_post", account_ref: "social:self", payload: { content: "hola" } };
    const res = await runWithContext({ callerAgentId: "a", callerRunId: "r9", callerDepth: 0 }, () => tool.handler(args));
    expect(res.isError).toBeFalsy();
    const human = await tool.handler(args);
    expect(human.isError).toBeFalsy();
    const items = outbox.list();
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.project_id === null)).toBe(true);
    expect(items.map((i) => i.run_id).sort()).toEqual(["", "r9"]);
  });
});

describe("draft notice without a project", () => {
  it("uses a generic text and rate-limits the unscoped bucket", async () => {
    const { DraftNotifier } = await import("../src/modules/projects/draft-notifier.js");
    const sent: Array<{ title: string; body?: string }> = [];
    let now = 0;
    const n = new DraftNotifier(async (m) => { sent.push(m); return true; }, (id) => id, () => now, 10 * 60_000);
    n.onChanged({ id: "a", project_id: null, status: "draft" });
    n.onChanged({ id: "b", project_id: null, status: "draft" });
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toBe("Borrador para aprobar");
    expect(sent[0].body).not.toContain("null");
    now = 11 * 60_000;
    n.onChanged({ id: "c", project_id: null, status: "draft" });
    expect(sent).toHaveLength(2);
  });
});
