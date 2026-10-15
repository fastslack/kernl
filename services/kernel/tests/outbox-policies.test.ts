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

const tick = () => new Promise((r) => setTimeout(r, 20));

describe("outbox policies", () => {
  let db: Database; let root: string; let outbox: OutboxService; let pid: string; let sent: unknown[];
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, "agents", agentsMigrations);
    runMigrations(db, "projects", projectsMigrations);
    const events = new EventBus();
    root = mkdtempSync(join(tmpdir(), "op-"));
    const projects = new ProjectsService(db, events, { encryptionKey: "a".repeat(64), projectsRoot: root });
    pid = projects.create({ slug: "heural", name: "Heural", brief: { value_prop: "v", audience: "a" } }).id;
    projects.link(pid, "social_account", "fake:1");
    sent = [];
    outbox = new OutboxService(db, events, projects, () => {});
    outbox.registerChannel("fake", {
      validate: () => ({ ok: true }), preview: () => ({ title: "t", body: "b" }),
      send: async (payload) => { sent.push(payload); return { ref: "r1" }; },
    });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const propose = (payload: unknown) => outbox.propose({ project_id: pid, flow_id: "growth-office", agent_id: "", run_id: "", channel: "fake", account_ref: "fake:1", payload });
  const status = (id: string) => (db.prepare("SELECT status, review_note FROM outbox_items WHERE id = ?").get(id) as { status: string; review_note: string });

  it("without policies a draft stays a draft", async () => {
    const item = propose({ action_type: "community.reply" });
    await tick();
    expect(status(item.id).status).toBe("draft");
  });

  it("an auto decision approves and sends, with the rule as review_note", async () => {
    outbox.registerPolicy("growth", (item) => (item.payload as { action_type?: string }).action_type === "community.reply"
      ? { decision: "auto", note: "auto: community.reply (tope 5/día)" } : { decision: "manual" });
    const item = propose({ action_type: "community.reply" });
    expect(item.status).toBe("draft");
    await tick();
    expect(status(item.id)).toEqual({ status: "sent", review_note: "auto: community.reply (tope 5/día)" });
    expect(sent.length).toBe(1);
    const other = propose({ action_type: "content.publish" });
    await tick();
    expect(status(other.id).status).toBe("draft");
  });

  it("a throwing policy or a rehearsal draft never auto-approves", async () => {
    outbox.registerPolicy("boom", () => { throw new Error("x"); });
    outbox.registerPolicy("growth", () => ({ decision: "auto", note: "auto" }));
    const reh = propose({ action_type: "community.reply", rehearsal: true });
    await tick();
    expect(status(reh.id).status).toBe("draft");
    const ok = propose({ action_type: "community.reply" });
    await tick();
    expect(status(ok.id).status).toBe("sent");
  });

  it("registering the same name replaces the policy", async () => {
    outbox.registerPolicy("growth", () => ({ decision: "auto", note: "a" }));
    outbox.registerPolicy("growth", () => ({ decision: "manual" }));
    const item = propose({ action_type: "community.reply" });
    await tick();
    expect(status(item.id).status).toBe("draft");
  });
  it("an unregistered policy no longer approves", async () => {
    outbox.registerPolicy("growth", () => ({ decision: "auto", note: "a" }));
    outbox.unregisterPolicy("growth");
    const item = propose({ action_type: "community.reply" });
    await tick();
    expect(status(item.id).status).toBe("draft");
  });
});
